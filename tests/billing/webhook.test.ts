import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
    handleStripeEvent,
    holdsRunningSubscription,
    SUBSCRIPTION_MISSING,
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
    restored: string[] = [];
    released: string[] = [];
    logs: string[] = [];
    remote = new Map<string, StripeSubscriptionLike>();
    /** Ids Stripe answers resource_missing for, as opposed to merely not answering. */
    missing = new Set<string>();

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
    fetchSubscription = async (id: string) =>
        this.missing.has(id) ? SUBSCRIPTION_MISSING : (this.remote.get(id) ?? null);
    userIdForSubscription = async (id: string) => this.subscriptions.get(id)?.user_id ?? null;
    storedStatusOf = async (id: string) => this.subscriptions.get(id)?.status ?? null;
    applyFreeTierArchival = async (userId: string) => {
        this.archived.push(userId);
    };
    restorePlanArchivedScores = async (userId: string) => {
        this.restored.push(userId);
    };
    /** Mirrors the real store: the id is forgotten, so a redelivery is fresh. */
    releaseEvent = async (id: string) => {
        this.released.push(id);
        this.events = this.events.filter((event) => event !== id);
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

/**
 * Stripe sending `event` right after the change it reports: the object it
 * embeds IS the subscription's current state, so that is what a live re-read
 * answers from then on (a deleted subscription reads back as canceled).
 */
const deliver = (store: FakeStore, event: StripeEventLike) => {
    const object = event.data.object as StripeSubscriptionLike;
    store.remote.set(
        object.id,
        event.type === 'customer.subscription.deleted' ? { ...object, status: 'canceled' } : object,
    );
    return handleStripeEvent(event, store, PRICE_TIERS);
};

/**
 * Stripe redelivering an event whose first delivery failed, after the
 * subscription has moved on: the embedded object is stale, and the live
 * state stays whatever the newer events made it.
 */
const deliverLate = (store: FakeStore, event: StripeEventLike) => handleStripeEvent(event, store, PRICE_TIERS);

describe('stripe event handling', () => {
    let store: FakeStore;

    beforeEach(() => {
        store = new FakeStore();
    });

    it('is idempotent: a replayed event id applies exactly once', async () => {
        const event = subscriptionEvent('evt_1', 'customer.subscription.updated');

        const first = await deliver(store, event);
        expect(first.body).toMatchObject({ applied: 'subscription_upserted' });
        expect(store.subscriptions.get('sub_1')?.tier).toBe('teacher');

        store.subscriptions.clear();
        const second = await deliverLate(store, event);
        expect(second.status).toBe(200);
        expect(second.body).toMatchObject({ duplicate: true });
        // The replay must not have re-applied anything.
        expect(store.subscriptions.size).toBe(0);
    });

    it('does not re-archive on a replayed cancellation', async () => {
        const event = subscriptionEvent('evt_cancel', 'customer.subscription.deleted');
        await deliver(store, event);
        await deliverLate(store, event);
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
        // A checkout is how a lapsed teacher comes back, so it restores too.
        expect(store.restored).toEqual(['teacher-9']);
    });

    it('releases the claim and asks for a retry when checkout cannot read the subscription', async () => {
        // The purchase is in this event. Answering 200 while keeping the claim
        // would acknowledge it to Stripe and drop it: the retry would read as a
        // duplicate, and a paying customer would be left on Free.
        const checkout: StripeEventLike = {
            id: 'evt_checkout_flaky',
            type: 'checkout.session.completed',
            data: { object: { customer: 'cus_9', subscription: 'sub_9', client_reference_id: 'teacher-9' } },
        };

        const first = await handleStripeEvent(checkout, store, PRICE_TIERS);
        expect(first.status).toBeGreaterThanOrEqual(500);
        expect(first.body).toMatchObject({ retry: true });
        expect(store.released).toEqual(['evt_checkout_flaky']);
        expect(store.subscriptions.size).toBe(0);

        // Stripe's retry, once its API answers again, is processed, not skipped.
        store.remote.set('sub_9', {
            id: 'sub_9',
            status: 'active',
            customer: 'cus_9',
            items: { data: [{ price: { id: 'price_teacher_monthly' } }] },
        });
        const retry = await handleStripeEvent(checkout, store, PRICE_TIERS);
        expect(retry.status).toBe(200);
        expect(retry.body).toMatchObject({ applied: 'subscription_upserted' });
        expect(store.subscriptions.get('sub_9')).toMatchObject({ user_id: 'teacher-9', tier: 'teacher' });
    });

    it('releases the claim and asks for a retry when a failed invoice cannot read the subscription', async () => {
        const event: StripeEventLike = {
            id: 'evt_inv_flaky',
            type: 'invoice.payment_failed',
            data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
        };
        const result = await handleStripeEvent(event, store, PRICE_TIERS);
        expect(result.status).toBeGreaterThanOrEqual(500);
        expect(store.released).toEqual(['evt_inv_flaky']);
        expect(store.events).not.toContain('evt_inv_flaky');
    });

    it.each([
        [
            'checkout.session.completed',
            { customer: 'cus_9', subscription: 'sub_gone', client_reference_id: 'teacher-9' },
        ],
        ['invoice.payment_failed', { customer: 'cus_1', subscription: 'sub_gone' }],
        [
            'customer.subscription.updated',
            { id: 'sub_gone', status: 'active', customer: 'cus_1', metadata: { user_id: 'teacher-1' } },
        ],
        [
            'customer.subscription.created',
            { id: 'sub_gone', status: 'active', customer: 'cus_1', metadata: { user_id: 'teacher-1' } },
        ],
    ])('acknowledges %s for a subscription Stripe says does not exist', async (type, object) => {
        // resource_missing is Stripe answering, not Stripe failing: three days
        // of 500s would fail identically and only trip endpoint alerts. The
        // claim is kept, so a redelivery is a duplicate, and the log is loud.
        store.missing.add('sub_gone');
        const event: StripeEventLike = { id: `evt_gone_${type}`, type, data: { object } };

        const result = await handleStripeEvent(event, store, PRICE_TIERS);

        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ ignored: 'subscription_missing' });
        expect(store.released).toEqual([]);
        expect(store.subscriptions.size).toBe(0);
        expect(store.logs.some((line) => line.startsWith('ALERT') && line.includes('sub_gone'))).toBe(true);
        const replay = await handleStripeEvent(event, store, PRICE_TIERS);
        expect(replay.body).toMatchObject({ duplicate: true });
    });

    it('does not release the claim for a checkout it deliberately ignores', async () => {
        const result = await handleStripeEvent(
            {
                id: 'evt_one_off',
                type: 'checkout.session.completed',
                data: { object: { customer: 'cus_9', client_reference_id: 'teacher-9' } },
            },
            store,
            PRICE_TIERS,
        );
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ ignored: 'no_subscription' });
        expect(store.released).toEqual([]);
    });

    it('archives past the free cap when a subscription is deleted', async () => {
        await deliver(store, subscriptionEvent('evt_d', 'customer.subscription.deleted'));
        expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'canceled', tier: 'free' });
        expect(store.archived).toEqual(['teacher-1']);
    });

    describe('events delivered out of order', () => {
        // Stripe guarantees delivery, not order, and every transient failure
        // here answers 500 with the claim released -- so the retry of an older
        // event landing after a newer one for the same subscription is the
        // normal path, not an exotic one. Each is a different event id, so
        // idempotency cannot see it.

        it('keeps a paid subscription active when a late unpaid copy arrives', async () => {
            // active -> unpaid (evt_unpaid) -> the customer pays -> active
            // (evt_paid). evt_unpaid's first delivery hit a transient failure,
            // so Stripe retries it after evt_paid.
            const unpaid = subscriptionEvent('evt_unpaid_first', 'customer.subscription.updated', {
                status: 'unpaid',
            });
            const first = await handleStripeEvent(unpaid, store, PRICE_TIERS);
            expect(first.status).toBeGreaterThanOrEqual(500);
            expect(store.released).toEqual(['evt_unpaid_first']);

            await deliver(store, subscriptionEvent('evt_paid_after', 'customer.subscription.updated'));
            expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'active', tier: 'teacher' });

            const late = await deliverLate(store, unpaid);

            expect(late.status).toBe(200);
            // The customer has paid: still Teacher, nothing archived.
            expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'active', tier: 'teacher' });
            expect(store.archived).toEqual([]);
        });

        it.each(['past_due', 'incomplete'])(
            'keeps a paid subscription active when a late %s copy arrives',
            async (status) => {
                await deliver(store, subscriptionEvent('evt_now_active', 'customer.subscription.updated'));
                await deliverLate(
                    store,
                    subscriptionEvent(`evt_late_${status}`, 'customer.subscription.updated', { status }),
                );
                expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'active', tier: 'teacher' });
            },
        );

        it('does not restore paid entitlements from a late active copy of an unpaid subscription', async () => {
            // active (evt_was_active) -> unpaid (evt_now_unpaid); the first
            // delivery of evt_was_active failed and is retried last.
            const wasActive = subscriptionEvent('evt_was_active', 'customer.subscription.updated');
            await deliver(
                store,
                subscriptionEvent('evt_now_unpaid', 'customer.subscription.updated', { status: 'unpaid' }),
            );
            expect(store.archived).toEqual(['teacher-1']);

            const late = await deliverLate(store, wasActive);

            expect(late.status).toBe(200);
            expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'unpaid', tier: 'free' });
            expect(store.restored).toEqual([]);
        });

        it('cannot reopen a cancelled subscription with a late updated event', async () => {
            // The `updated` that fires when a teacher cancels still reads
            // `active`; landing after the `deleted` it raced, it must not hand
            // Teacher entitlements back for the rest of the period on a
            // subscription that no longer exists.
            await deliver(store, subscriptionEvent('evt_del', 'customer.subscription.deleted'));
            expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'canceled', tier: 'free' });

            const late = await deliverLate(
                store,
                subscriptionEvent('evt_late_update', 'customer.subscription.updated', { status: 'active' }),
            );

            expect(late.status).toBe(200);
            expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'canceled', tier: 'free' });
            expect(store.restored).toEqual([]);
        });

        it('refuses to reopen an ended subscription even if a concurrent read saw it live', async () => {
            // The window the live read leaves: two deliveries in flight at once,
            // the older read landing second. An ended subscription never comes
            // back, so the floor holds whatever the read says.
            await deliver(store, subscriptionEvent('evt_del_c', 'customer.subscription.deleted'));
            store.remote.set('sub_1', {
                id: 'sub_1',
                status: 'active',
                customer: 'cus_1',
                items: { data: [{ price: { id: 'price_teacher_annual' } }] },
                metadata: { user_id: 'teacher-1' },
            });

            const raced = await deliverLate(store, subscriptionEvent('evt_raced', 'customer.subscription.updated'));

            expect(raced.body).toMatchObject({ ignored: 'terminal_status' });
            expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'canceled', tier: 'free' });
            expect(store.restored).toEqual([]);
        });

        it('re-runs the archival on the retry of an event whose archival failed after its write', async () => {
            // The row reads `canceled` after the first attempt, so a floor
            // keyed on the EMBEDDED status (`active` here) would skip the retry
            // and leave every score writable on a lapsed plan.
            store.remote.set('sub_1', {
                id: 'sub_1',
                status: 'canceled',
                customer: 'cus_1',
                items: { data: [{ price: { id: 'price_teacher_annual' } }] },
                metadata: { user_id: 'teacher-1' },
            });
            const event = subscriptionEvent('evt_archive_flaky', 'customer.subscription.updated');
            const archive = store.applyFreeTierArchival;
            store.applyFreeTierArchival = async () => {
                throw new Error('connection reset');
            };
            await expect(handleStripeEvent(event, store, PRICE_TIERS)).rejects.toThrow('connection reset');
            // What stripe-webhook/index.ts does with a thrown error.
            await store.releaseEvent(event.id);
            expect(store.subscriptions.get('sub_1')?.status).toBe('canceled');
            store.applyFreeTierArchival = archive;

            const retry = await deliverLate(store, event);

            expect(retry.body).toMatchObject({ applied: 'subscription_upserted' });
            expect(store.archived).toEqual(['teacher-1']);
        });

        it('retries, rather than applying the embedded copy, when Stripe cannot be read', async () => {
            const result = await handleStripeEvent(
                subscriptionEvent('evt_unreadable', 'customer.subscription.updated', { status: 'unpaid' }),
                store,
                PRICE_TIERS,
            );
            expect(result.status).toBeGreaterThanOrEqual(500);
            expect(result.body).toMatchObject({ retry: true });
            expect(store.released).toEqual(['evt_unreadable']);
            expect(store.subscriptions.size).toBe(0);
            expect(store.archived).toEqual([]);
        });
    });

    it('restores lapse-archived scores when an unpaid subscription is paid', async () => {
        await deliver(store, subscriptionEvent('evt_unpaid_r', 'customer.subscription.updated', { status: 'unpaid' }));
        expect(store.archived).toEqual(['teacher-1']);
        expect(store.restored).toEqual([]);

        await deliver(store, subscriptionEvent('evt_paid_r', 'customer.subscription.updated', { status: 'active' }));
        expect(store.restored).toEqual(['teacher-1']);
        // Restoring is not archiving again.
        expect(store.archived).toEqual(['teacher-1']);
    });

    it('restores on a trial, and on a brand-new subscription after a cancellation', async () => {
        await deliver(
            store,
            subscriptionEvent('evt_trial', 'customer.subscription.created', { id: 'sub_t', status: 'trialing' }),
        );
        expect(store.restored).toEqual(['teacher-1']);

        await deliver(store, subscriptionEvent('evt_del_t', 'customer.subscription.deleted', { id: 'sub_t' }));
        await deliver(
            store,
            subscriptionEvent('evt_new', 'customer.subscription.created', { id: 'sub_new', status: 'active' }),
        );
        expect(store.archived).toEqual(['teacher-1']);
        expect(store.restored).toEqual(['teacher-1', 'teacher-1']);
    });

    it('neither archives nor restores while a payment is past due', async () => {
        await deliver(store, subscriptionEvent('evt_pd_r', 'customer.subscription.updated', { status: 'past_due' }));
        expect(store.archived).toEqual([]);
        expect(store.restored).toEqual([]);
    });

    it('still lets an unpaid subscription come back, because paying the invoice can revive it', async () => {
        // `unpaid` archives but is NOT terminal — a floor there would strand the
        // customer who just settled the outstanding invoice.
        await deliver(store, subscriptionEvent('evt_unpaid', 'customer.subscription.updated', { status: 'unpaid' }));
        expect(store.subscriptions.get('sub_1')?.status).toBe('unpaid');

        await deliver(store, subscriptionEvent('evt_paid', 'customer.subscription.updated', { status: 'active' }));
        expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'active', tier: 'teacher' });
    });

    it('does not archive on past_due — Stripe is still retrying the card', async () => {
        await deliver(store, subscriptionEvent('evt_pd', 'customer.subscription.updated', { status: 'past_due' }));
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
        const result = await deliver(
            store,
            subscriptionEvent('evt_orphan', 'customer.subscription.updated', {
                metadata: null,
                customer: 'cus_unknown',
            }),
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

    it('treats a cancellation scheduled with cancel_at within the period as cancelling', () => {
        // The dashboard's "cancel on a custom date" sets cancel_at and leaves
        // cancel_at_period_end false; the owner must not be told it renews.
        const periodEnd = 1_800_000_000;
        const atPeriodEnd = subscriptionRowFrom(
            {
                id: 'sub_c1',
                status: 'active',
                cancel_at_period_end: false,
                cancel_at: periodEnd,
                current_period_end: periodEnd,
                items: { data: [{ price: { id: 'price_teacher_annual' } }] },
            },
            'teacher-1',
            PRICE_TIERS,
        );
        expect(atPeriodEnd.cancel_at_period_end).toBe(true);
        expect(atPeriodEnd.current_period_end).toBe(new Date(periodEnd * 1000).toISOString());

        // Mid-period: Stripe ends it at cancel_at, so that is the date shown.
        const midPeriod = subscriptionRowFrom(
            {
                id: 'sub_c2',
                status: 'active',
                cancel_at: periodEnd - 86_400,
                current_period_end: periodEnd,
                items: { data: [{ price: { id: 'price_teacher_annual' } }] },
            },
            'teacher-1',
            PRICE_TIERS,
        );
        expect(midPeriod.cancel_at_period_end).toBe(true);
        expect(midPeriod.current_period_end).toBe(new Date((periodEnd - 86_400) * 1000).toISOString());
    });

    it('still renews when cancel_at lies beyond the current period', () => {
        const periodEnd = 1_800_000_000;
        const row = subscriptionRowFrom(
            {
                id: 'sub_c3',
                status: 'active',
                cancel_at: periodEnd + 30 * 86_400,
                current_period_end: periodEnd,
                items: { data: [{ price: { id: 'price_teacher_annual' } }] },
            },
            'teacher-1',
            PRICE_TIERS,
        );
        expect(row.cancel_at_period_end).toBe(false);
        expect(row.current_period_end).toBe(new Date(periodEnd * 1000).toISOString());
    });

    it('keeps the portal flag as it is when no cancel_at is set', () => {
        const row = subscriptionRowFrom(
            {
                id: 'sub_c4',
                status: 'active',
                cancel_at_period_end: true,
                cancel_at: null,
                current_period_end: 1_800_000_000,
                items: { data: [{ price: { id: 'price_teacher_annual' } }] },
            },
            'teacher-1',
            PRICE_TIERS,
        );
        expect(row.cancel_at_period_end).toBe(true);
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

describe('checkout guard', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    const row = (status: string, current_period_end: string | null = '2026-11-09T12:00:00Z') => ({
        status,
        current_period_end,
    });

    it('refuses a second Checkout beside a running subscription, cancelling or not', () => {
        // Checkout always creates a new subscription: a Personal subscriber who
        // chose Teacher there was billed for both.
        expect(holdsRunningSubscription([row('active')], now)).toBe(true);
        expect(holdsRunningSubscription([row('trialing')], now)).toBe(true);
        expect(holdsRunningSubscription([row('active', null)], now)).toBe(true);
        // Stripe is still retrying it; fixing the card in the portal revives it.
        expect(holdsRunningSubscription([row('past_due', '2026-09-01T00:00:00Z')], now)).toBe(true);
    });

    it('leaves Checkout open once the subscription has ended or never started', () => {
        expect(holdsRunningSubscription([], now)).toBe(false);
        expect(holdsRunningSubscription([row('canceled')], now)).toBe(false);
        expect(holdsRunningSubscription([row('incomplete_expired')], now)).toBe(false);
        expect(holdsRunningSubscription([row('incomplete')], now)).toBe(false);
        expect(holdsRunningSubscription([row('unpaid')], now)).toBe(false);
        // Active on paper, but its period is over and no renewal has landed.
        expect(holdsRunningSubscription([row('active', '2026-10-01T00:00:00Z')], now)).toBe(false);
    });

    it('is wired into stripe-checkout ahead of creating any session', () => {
        const source = readFileSync(resolve(process.cwd(), 'supabase/functions/stripe-checkout/index.ts'), 'utf8');
        const guard = source.indexOf('holdsRunningSubscription(running');
        expect(guard).toBeGreaterThan(0);
        expect(guard).toBeLessThan(source.indexOf('stripe.customers.create'));
        expect(guard).toBeLessThan(source.indexOf('stripe.checkout.sessions.create'));
        expect(source).toMatch(/code:\s*'already_subscribed'/);
    });
});
