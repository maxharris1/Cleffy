import { beforeEach, describe, expect, it } from 'vitest';

import {
    handleStripeEvent,
    subscriptionRowFrom,
    type StripeEventLike,
    type StripeSubscriptionLike,
    type SubscriptionUpsert,
    type WebhookStore,
} from '../../supabase/functions/_shared/stripeEvents';
import {
    buildSignatureHeader,
    computeStripeSignature,
    parseSignatureHeader,
    verifyStripeSignature,
} from '../../supabase/functions/_shared/stripeSignature';

const SECRET = 'whsec_test_secret';
const NOW = 1_772_000_000;

/**
 * The env-driven catalogue, as supabase/functions/_shared/stripe.ts builds it.
 * Founding Teacher is a second, cheaper price on the Teacher product, so it maps
 * to 'teacher' like any other Teacher price — no schema, no special case.
 */
const PRICE_TIERS = {
    price_personal_monthly: 'personal',
    price_personal_annual: 'personal',
    price_teacher_monthly: 'teacher',
    price_teacher_annual: 'teacher',
    price_founding_annual: 'teacher',
    price_academy_monthly: 'academy',
    price_academy_annual: 'academy',
} as const;

/** In-memory stand-in for the tables the webhook writes. */
class FakeStore implements WebhookStore {
    events: string[] = [];
    customers = new Map<string, string>();
    subscriptions = new Map<string, SubscriptionUpsert>();
    archived: string[] = [];
    logs: string[] = [];
    remote = new Map<string, StripeSubscriptionLike>();

    claimEvent = async (id: string): Promise<boolean> => {
        if (this.events.includes(id)) {
            return false;
        }
        this.events.push(id);
        return true;
    };
    userIdForCustomer = async (customerId: string) => this.customers.get(customerId) ?? null;
    linkCustomer = async (customerId: string, userId: string) => {
        this.customers.set(customerId, userId);
    };
    upsertSubscription = async (row: SubscriptionUpsert) => {
        this.subscriptions.set(row.stripe_subscription_id, row);
    };
    fetchSubscription = async (id: string) => this.remote.get(id) ?? null;
    userIdForSubscription = async (id: string) => this.subscriptions.get(id)?.user_id ?? null;
    applyFreeTierArchival = async (userId: string) => {
        this.archived.push(userId);
    };
    log = (message: string) => {
        this.logs.push(message);
    };
}

const subscriptionEvent = (
    id: string,
    type: string,
    overrides: Partial<StripeSubscriptionLike> = {},
): StripeEventLike => ({
    id,
    type,
    data: {
        object: {
            id: 'sub_1',
            status: 'active',
            customer: 'cus_1',
            current_period_end: 1_800_000_000,
            items: { data: [{ price: { id: 'price_teacher_annual' } }] },
            metadata: { user_id: 'teacher-1' },
            ...overrides,
        },
    },
});

describe('stripe signature verification', () => {
    it('accepts a correctly signed payload', async () => {
        const payload = JSON.stringify({ id: 'evt_1' });
        const header = await buildSignatureHeader(NOW, payload, SECRET);
        await expect(verifyStripeSignature(payload, header, SECRET, NOW)).resolves.toEqual({ ok: true });
    });

    it('rejects a tampered body', async () => {
        const header = await buildSignatureHeader(NOW, '{"amount":10}', SECRET);
        const result = await verifyStripeSignature('{"amount":1000}', header, SECRET, NOW);
        expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
    });

    it('rejects a signature made with a different secret', async () => {
        const payload = '{"id":"evt_1"}';
        const header = await buildSignatureHeader(NOW, payload, 'whsec_wrong');
        const result = await verifyStripeSignature(payload, header, SECRET, NOW);
        expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
    });

    it('rejects a replay outside the tolerance window', async () => {
        const payload = '{"id":"evt_1"}';
        const header = await buildSignatureHeader(NOW - 4000, payload, SECRET);
        const result = await verifyStripeSignature(payload, header, SECRET, NOW);
        expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
    });

    it('rejects a missing or malformed header', async () => {
        await expect(verifyStripeSignature('{}', null, SECRET, NOW)).resolves.toEqual({
            ok: false,
            reason: 'missing_header',
        });
        await expect(verifyStripeSignature('{}', 'nonsense', SECRET, NOW)).resolves.toEqual({
            ok: false,
            reason: 'malformed_header',
        });
        await expect(verifyStripeSignature('{}', `t=${NOW}`, SECRET, NOW)).resolves.toEqual({
            ok: false,
            reason: 'no_v1_signature',
        });
    });

    it('accepts any matching v1 entry, as sent during secret rotation', async () => {
        const payload = '{"id":"evt_1"}';
        const good = await computeStripeSignature(NOW, payload, SECRET);
        const header = `t=${NOW},v1=deadbeef,v1=${good}`;
        expect(parseSignatureHeader(header).signatures).toHaveLength(2);
        await expect(verifyStripeSignature(payload, header, SECRET, NOW)).resolves.toEqual({ ok: true });
    });

    it('is sensitive to the exact bytes, so a re-serialized body fails', async () => {
        // Why the function must use req.text() and never JSON.stringify(parsed).
        const raw = '{"id":"evt_1",  "type":"x"}';
        const header = await buildSignatureHeader(NOW, raw, SECRET);
        const reSerialized = JSON.stringify(JSON.parse(raw));
        expect((await verifyStripeSignature(reSerialized, header, SECRET, NOW)).ok).toBe(false);
    });
});

describe('stripe event handling', () => {
    let store: FakeStore;

    beforeEach(() => {
        store = new FakeStore();
    });

    it('is idempotent: a replayed event id applies exactly once', async () => {
        const event = subscriptionEvent('evt_1', 'customer.subscription.updated');

        const first = await handleStripeEvent(event, store, PRICE_TIERS);
        expect(first.body).toMatchObject({ applied: 'subscription_upserted' });
        expect(store.subscriptions.get('sub_1')?.tier).toBe('teacher');

        store.subscriptions.clear();
        const second = await handleStripeEvent(event, store, PRICE_TIERS);
        expect(second.status).toBe(200);
        expect(second.body).toMatchObject({ duplicate: true });
        // The replay must not have re-applied anything.
        expect(store.subscriptions.size).toBe(0);
    });

    it('does not re-archive on a replayed cancellation', async () => {
        const event = subscriptionEvent('evt_cancel', 'customer.subscription.deleted');
        await handleStripeEvent(event, store, PRICE_TIERS);
        await handleStripeEvent(event, store, PRICE_TIERS);
        expect(store.archived).toEqual(['teacher-1']);
    });

    it('links the customer and records the subscription on checkout completion', async () => {
        store.remote.set('sub_9', {
            id: 'sub_9',
            status: 'active',
            customer: 'cus_9',
            current_period_end: 1_800_000_000,
            items: { data: [{ price: { id: 'price_academy_annual' } }] },
        });

        const result = await handleStripeEvent(
            {
                id: 'evt_checkout',
                type: 'checkout.session.completed',
                data: { object: { customer: 'cus_9', subscription: 'sub_9', client_reference_id: 'teacher-9' } },
            },
            store,
            PRICE_TIERS,
        );

        expect(result.status).toBe(200);
        expect(store.customers.get('cus_9')).toBe('teacher-9');
        expect(store.subscriptions.get('sub_9')).toMatchObject({ user_id: 'teacher-9', tier: 'academy' });
        expect(store.archived).toEqual([]);
    });

    it('archives past the free cap when a subscription is deleted', async () => {
        await handleStripeEvent(subscriptionEvent('evt_d', 'customer.subscription.deleted'), store, PRICE_TIERS);
        expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'canceled', tier: 'free' });
        expect(store.archived).toEqual(['teacher-1']);
    });

    it('does not archive on past_due — Stripe is still retrying the card', async () => {
        await handleStripeEvent(
            subscriptionEvent('evt_pd', 'customer.subscription.updated', { status: 'past_due' }),
            store,
            PRICE_TIERS,
        );
        expect(store.subscriptions.get('sub_1')?.status).toBe('past_due');
        expect(store.archived).toEqual([]);
    });

    it('records a failed invoice against the current Stripe state', async () => {
        store.remote.set('sub_1', {
            id: 'sub_1',
            status: 'unpaid',
            customer: 'cus_1',
            items: { data: [{ price: { id: 'price_teacher_annual' } }] },
            metadata: { user_id: 'teacher-1' },
        });

        const result = await handleStripeEvent(
            {
                id: 'evt_inv',
                type: 'invoice.payment_failed',
                data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
            },
            store,
            PRICE_TIERS,
        );

        expect(result.status).toBe(200);
        expect(store.subscriptions.get('sub_1')?.status).toBe('unpaid');
        expect(store.archived).toEqual(['teacher-1']);
    });

    it('ignores events it cannot attribute to a user', async () => {
        const result = await handleStripeEvent(
            subscriptionEvent('evt_orphan', 'customer.subscription.updated', {
                metadata: null,
                customer: 'cus_unknown',
            }),
            store,
            PRICE_TIERS,
        );
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ ignored: 'unknown_user' });
    });

    it('ignores unrelated event types without failing', async () => {
        const result = await handleStripeEvent(
            { id: 'evt_other', type: 'customer.updated', data: { object: {} } },
            store,
            PRICE_TIERS,
        );
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ ignored: 'customer.updated' });
    });
});

describe('subscription row mapping', () => {
    it('maps every published price to the tier it was sold as', () => {
        // Both intervals of all three products, so a mistyped env name in the
        // catalogue cannot silently drop a plan to free.
        for (const [priceId, tier] of Object.entries(PRICE_TIERS)) {
            const row = subscriptionRowFrom(
                { id: `sub_${priceId}`, status: 'active', items: { data: [{ price: { id: priceId } }] } },
                'teacher-1',
                PRICE_TIERS,
            );
            expect(row.tier).toBe(tier);
        }
    });

    it('maps the founding price to teacher, like any other teacher price', () => {
        const row = subscriptionRowFrom(
            {
                id: 'sub_f',
                status: 'active',
                items: { data: [{ price: { id: 'price_founding_annual' } }] },
            },
            'teacher-1',
            PRICE_TIERS,
        );
        expect(row.tier).toBe('teacher');
        expect(row.price_id).toBe('price_founding_annual');
    });

    it('stores free for a non-entitling status regardless of price', () => {
        const row = subscriptionRowFrom(
            {
                id: 'sub_x',
                status: 'past_due',
                items: { data: [{ price: { id: 'price_academy_annual' } }] },
            },
            'teacher-1',
            PRICE_TIERS,
        );
        expect(row.tier).toBe('free');
    });

    it('reads current_period_end from the subscription item when it is not on the subscription', () => {
        const row = subscriptionRowFrom(
            {
                id: 'sub_i',
                status: 'active',
                items: { data: [{ price: { id: 'price_teacher_annual' }, current_period_end: 1_800_000_000 }] },
            },
            'teacher-1',
            PRICE_TIERS,
        );
        expect(row.current_period_end).toBe(new Date(1_800_000_000 * 1000).toISOString());
    });

    it('maps an unknown price to free rather than guessing', () => {
        const row = subscriptionRowFrom(
            { id: 'sub_u', status: 'active', items: { data: [{ price: { id: 'price_mystery' } }] } },
            'teacher-1',
            PRICE_TIERS,
        );
        expect(row.tier).toBe('free');
    });
});
