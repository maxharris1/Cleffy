import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
    duplicateUndoStateOf,
    EDGE_FUNCTION_WALL_CLOCK_MS,
    handleStripeEvent,
    holdsRunningSubscription,
    isEntitlingStatus,
    STRIPE_EVENT_CLAIM_STALE_AFTER,
    STRIPE_SUBSCRIPTION_LOCK_STALE_AFTER,
    STRIPE_SUBSCRIPTION_LOCK_STALE_AFTER_MS,
    SUBSCRIPTION_MISSING,
    subscriptionRowFrom,
    type ClaimOutcome,
    type DuplicateUndo,
    type DuplicateUndoState,
    type StripeEventLike,
    type StripeSubscriptionLike,
    type SubscriptionUpsert,
    type SubscriptionWriteOutcome,
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
/** The service clock a claim is taken on, in ms. */
const CLAIMED_AT = Date.parse('2026-10-12T22:35:00Z');
/**
 * Stripe's own `created` stamp on an event, in seconds. Every event a test
 * builds carries the same one unless it is testing the ordering guard: equal
 * stamps pass it, which is what keeps a retry of the SAME event applicable.
 */
const EVENT_CREATED = 1_760_000_000;

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

/** How long claim_stripe_event lets a claim sit unfinished; see the migration. */
const STALE_AFTER_MS = 10 * 60_000;

/**
 * How long claim_subscription_write lets a write lock sit. Taken from the
 * constant the function passes it rather than restated, so a change to the lease
 * cannot leave the fake modelling the old one.
 */
const LOCK_STALE_AFTER_MS = STRIPE_SUBSCRIPTION_LOCK_STALE_AFTER_MS;

/** A `stripe_events` row, in the three states the table can hold it in. */
interface FakeEvent {
    id: string;
    type: string;
    status: 'processing' | 'done';
    claimedAt: number;
}

/** In-memory stand-in for the tables the webhook writes. */
class FakeStore implements WebhookStore {
    events = new Map<string, FakeEvent>();
    customers = new Map<string, string>();
    subscriptions = new Map<string, SubscriptionUpsert>();
    archived: string[] = [];
    restored: string[] = [];
    released: string[] = [];
    logs: string[] = [];
    remote = new Map<string, StripeSubscriptionLike>();
    /** Ids Stripe answers resource_missing for, as opposed to merely not answering. */
    missing = new Set<string>();
    /** The service's clock, so a claim can be left to go stale without waiting. */
    clock = CLAIMED_AT;
    /** The claim stamp this delivery holds, as the real store keeps per request. */
    held: number | null = null;
    /** Writes the staleness trigger dropped, for the assertions about it. */
    staleWritesRefused: string[] = [];
    /** Writes write_subscription_under_lock refused for want of the lease. */
    writesRefusedWithoutLease: string[] = [];

    /**
     * claim_stripe_event, modelled: a fresh event is claimed, a finished one is
     * never re-claimed, an in-flight one is left to the delivery that holds it,
     * and one whose claim has gone stale is taken over (QA round 4, D2).
     */
    claimEvent = async (id: string, type: string): Promise<ClaimOutcome> => {
        const existing = this.events.get(id);
        if (existing?.status === 'done') {
            this.held = null;
            return 'done';
        }
        // A claim still inside its window belongs to a delivery that may be
        // running right now, and nobody has applied the event: that is the
        // answer Stripe has to be told to try again for (QA round 4, D2
        // follow-up).
        if (existing && this.clock - existing.claimedAt < STALE_AFTER_MS) {
            this.held = null;
            return 'in_flight';
        }
        this.events.set(id, { id, type, status: 'processing', claimedAt: this.clock });
        this.held = this.clock;
        return 'claimed';
    };
    markEventDone = async (id: string) => {
        const row = this.events.get(id);
        // Only our own claim, as the real store scopes its update: a claim that
        // went stale and was taken over belongs to the delivery holding it now.
        if (row && row.claimedAt === this.held) {
            row.status = 'done';
        }
    };
    userIdForCustomer = async (customerId: string) => this.customers.get(customerId) ?? null;
    linkCustomer = async (customerId: string, userId: string) => {
        this.customers.set(customerId, userId);
    };
    /**
     * The upsert, plus the two database guards that sit on it: the partial
     * unique index that refuses a SECOND entitling subscription for one user
     * (subscriptions_one_entitling_per_user_mode) and the BEFORE UPDATE trigger
     * that drops a write carrying an older event stamp than the row holds
     * (subscriptions_refuse_stale_event). Both are Postgres's to enforce -- the
     * SQL proof is tests/sql/billing_double_charge.sql -- and both change what
     * this handler must do, so the fake has to have them.
     */
    upsertSubscription = async (row: SubscriptionUpsert, holder: string): Promise<SubscriptionWriteOutcome> => {
        // The lease check, in the same step as the write
        // (write_subscription_under_lock, migration 20261013120101). Before it,
        // the write carried no lease at all and a delivery whose lease had been
        // taken over still landed its older read on top of the newer one.
        if (this.locks.get(row.stripe_subscription_id)?.holder !== holder) {
            this.writesRefusedWithoutLease.push(row.stripe_subscription_id);
            return { outcome: 'lost_lock' };
        }

        const other = [...this.subscriptions.values()].find(
            (existing) =>
                existing.user_id === row.user_id &&
                existing.stripe_subscription_id !== row.stripe_subscription_id &&
                isEntitlingStatus(existing.status),
        );
        if (other && isEntitlingStatus(row.status)) {
            return { outcome: 'duplicate', otherSubscriptionId: other.stripe_subscription_id };
        }

        const current = this.subscriptions.get(row.stripe_subscription_id);
        if (current) {
            if (row.last_event_created_at === null) {
                // An unstamped write never wipes out the high-water mark.
                this.subscriptions.set(row.stripe_subscription_id, {
                    ...row,
                    last_event_created_at: current.last_event_created_at,
                });
                return { outcome: 'written' };
            }
            if (current.last_event_created_at !== null && row.last_event_created_at < current.last_event_created_at) {
                this.staleWritesRefused.push(row.stripe_subscription_id);
                return { outcome: 'written' };
            }
        }

        this.subscriptions.set(row.stripe_subscription_id, row);
        return { outcome: 'written' };
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
    /**
     * subscription_writes and claim/release_subscription_write, modelled: one
     * holder per subscription, with a lease another delivery can take over once
     * it has gone stale (QA round 4, D3 follow-up).
     */
    locks = new Map<string, { holder: string; claimedAt: number }>();
    locksTaken = 0;
    lockSubscription = async (subscriptionId: string): Promise<string | null> => {
        const held = this.locks.get(subscriptionId);
        if (held && this.clock - held.claimedAt < LOCK_STALE_AFTER_MS) {
            return null;
        }
        this.locksTaken += 1;
        const holder = `lock-${this.locksTaken}`;
        this.locks.set(subscriptionId, { holder, claimedAt: this.clock });
        return holder;
    };
    unlockSubscription = async (subscriptionId: string, holder: string) => {
        if (this.locks.get(subscriptionId)?.holder === holder) {
            this.locks.delete(subscriptionId);
        }
    };
    /** What cancelAndRefundDuplicate does in Stripe, as a ledger. */
    canceledInStripe: string[] = [];
    refundedInStripe: string[] = [];
    cancelFails = false;
    /** The four outcomes the refund half reports; see DuplicateUndo. */
    refundOutcome: DuplicateUndo['refund'] = 'refunded';
    cancelDuplicateSubscription = async (subscriptionId: string): Promise<DuplicateUndo> => {
        const stopped = !this.cancelFails;
        if (stopped) {
            this.canceledInStripe.push(subscriptionId);
        }
        if (this.refundOutcome === 'refunded') {
            this.refundedInStripe.push(subscriptionId);
        }
        return {
            stopped,
            refund: this.refundOutcome,
            detail: `stopped=${stopped} refund=${this.refundOutcome}`,
        };
    };
    /**
     * `duplicate_refunds` and its three functions, modelled (migration
     * 20261013120102): the durable record of a duplicate whose cancel-and-refund
     * has not finished, which is what survives the event that found it.
     */
    ledger = new Map<string, { userId: string | null; state: DuplicateUndoState; attempts: number; detail: string }>();
    pendingDuplicateUndo = async (subscriptionId: string): Promise<{ userId: string | null } | null> => {
        const row = this.ledger.get(subscriptionId);
        return row?.state === 'pending' ? { userId: row.userId } : null;
    };
    recordPendingDuplicateUndo = async (subscriptionId: string, userId: string | null) => {
        const row = this.ledger.get(subscriptionId);
        this.ledger.set(subscriptionId, {
            userId: userId ?? row?.userId ?? null,
            // A settled debt is not reopened by another attempt at it.
            state: row?.state === 'resolved' ? 'resolved' : 'pending',
            attempts: row?.attempts ?? 0,
            detail: row?.detail ?? '',
        });
    };
    settleDuplicateUndo = async (subscriptionId: string, state: DuplicateUndoState, undone: DuplicateUndo) => {
        const row = this.ledger.get(subscriptionId);
        this.ledger.set(subscriptionId, {
            userId: row?.userId ?? null,
            state,
            // One per attempt that reported back, the failures included.
            attempts: (row?.attempts ?? 0) + 1,
            detail: undone.detail,
        });
    };
    /**
     * Mirrors the real store: the claim is forgotten, so a redelivery is fresh
     * -- and only while it is still this delivery's claim.
     */
    releaseEvent = async (id: string) => {
        this.released.push(id);
        if (this.events.get(id)?.claimedAt === this.held) {
            this.events.delete(id);
        }
    };
    log = (message: string) => {
        this.logs.push(message);
    };
}

const subscriptionEvent = (
    id: string,
    type: string,
    overrides: Partial<StripeSubscriptionLike> = {},
    created = EVENT_CREATED,
): StripeEventLike => ({
    id,
    type,
    created,
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
 * A place to suspend one delivery while another arrives: `arrived` resolves when
 * the handler reaches the step, and it goes no further until `release` is
 * called. Two deliveries really overlapping is the only way to test what the
 * per-subscription lock is for.
 */
const latch = () => {
    let release = () => {};
    const released = new Promise<void>((resolve_) => {
        release = () => resolve_();
    });
    let arrive = () => {};
    const arrived = new Promise<void>((resolve_) => {
        arrive = () => resolve_();
    });
    return { released, release, arrived, arrive };
};

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
        expect(store.events.has('evt_inv_flaky')).toBe(false);
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

    describe('a claim whose delivery never finished', () => {
        // The isolate can die between claiming an event and applying it: a
        // timeout on the Stripe read-back, an OOM, a deploy restarting the
        // worker. No catch runs, so nothing releases the claim -- and before
        // this it stayed forever, so every Stripe retry for the next three days
        // answered `200 duplicate`. For checkout.session.completed that is a
        // customer charged and never entitled (QA round 4, D2).
        const diedHolding = async (event: StripeEventLike) => {
            await store.claimEvent(event.id, event.type);
        };

        it('agrees with the window claim_stripe_event is called with', () => {
            // The fake compares in milliseconds; the handler hands the migration
            // an interval. The two have to mean the same thing.
            expect(STRIPE_EVENT_CLAIM_STALE_AFTER).toBe(`${STALE_AFTER_MS / 60_000} minutes`);
        });

        it('is reprocessed once the claim has gone stale', async () => {
            const event = subscriptionEvent('evt_orphaned', 'customer.subscription.updated');
            await diedHolding(event);
            expect(store.events.get('evt_orphaned')?.status).toBe('processing');

            store.clock += STALE_AFTER_MS + 1_000;
            const retry = await deliver(store, event);

            expect(retry.body).toMatchObject({ applied: 'subscription_upserted' });
            expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'active', tier: 'teacher' });
            expect(store.events.get('evt_orphaned')?.status).toBe('done');
        });

        it('is left alone while the delivery holding it may still be running, and Stripe keeps trying', async () => {
            // Inside the window, a second delivery is genuinely concurrent, and
            // both applying it is exactly what the claim exists to stop. But it
            // is NOT a duplicate: nobody has applied this event, so a 200 would
            // make Stripe forget it -- and if the delivery holding the claim is
            // the one that died, there would be no later delivery to take the
            // claim over once it went stale (QA round 4, D2 follow-up).
            const event = subscriptionEvent('evt_inflight', 'customer.subscription.updated');
            await diedHolding(event);

            store.clock += STALE_AFTER_MS - 1_000;
            const second = await deliver(store, event);

            expect(second.status).toBe(409);
            expect(second.body).toMatchObject({ retry: true });
            expect(store.subscriptions.size).toBe(0);
            // The claim belongs to the other delivery: not ours to release, and
            // not ours to finish.
            expect(store.released).toEqual([]);
            expect(store.events.get('evt_inflight')?.status).toBe('processing');
        });

        it('is never reprocessed once it is done, however long ago', async () => {
            const event = subscriptionEvent('evt_finished', 'customer.subscription.updated');
            await deliver(store, event);
            expect(store.events.get('evt_finished')?.status).toBe('done');

            store.subscriptions.clear();
            store.clock += STALE_AFTER_MS * 100;
            const replay = await deliverLate(store, event);

            expect(replay.body).toMatchObject({ duplicate: true });
            expect(store.subscriptions.size).toBe(0);
        });

        it('leaves no claim behind when it asks Stripe to retry', async () => {
            const event = subscriptionEvent('evt_unreadable_claim', 'customer.subscription.updated');

            const result = await handleStripeEvent(event, store, PRICE_TIERS);

            expect(result.status).toBeGreaterThanOrEqual(500);
            expect(store.events.has('evt_unreadable_claim')).toBe(false);
        });

        describe('finishes the claim on every outcome it is done with', () => {
            // An `ignored:` answer is a decision, not a failure. Left
            // `processing`, each of these would be re-processed every time the
            // claim went stale, for as long as Stripe kept retrying.
            it('a checkout with nothing to subscribe', async () => {
                await handleStripeEvent(
                    {
                        id: 'evt_done_one_off',
                        type: 'checkout.session.completed',
                        created: EVENT_CREATED,
                        data: { object: { customer: 'cus_9', client_reference_id: 'teacher-9' } },
                    },
                    store,
                    PRICE_TIERS,
                );
                expect(store.events.get('evt_done_one_off')?.status).toBe('done');
            });

            it('an event nobody can be resolved for', async () => {
                await deliver(
                    store,
                    subscriptionEvent('evt_done_orphan', 'customer.subscription.updated', {
                        metadata: null,
                        customer: 'cus_unknown',
                    }),
                );
                expect(store.events.get('evt_done_orphan')?.status).toBe('done');
            });

            it('a subscription Stripe says does not exist', async () => {
                store.missing.add('sub_gone');
                await deliverLate(
                    store,
                    subscriptionEvent('evt_done_gone', 'customer.subscription.updated', { id: 'sub_gone' }),
                );
                expect(store.events.get('evt_done_gone')?.status).toBe('done');
            });

            it('an event refused by the terminal-status floor', async () => {
                await deliver(store, subscriptionEvent('evt_done_del', 'customer.subscription.deleted'));
                store.remote.set('sub_1', {
                    id: 'sub_1',
                    status: 'active',
                    customer: 'cus_1',
                    items: { data: [{ price: { id: 'price_teacher_annual' } }] },
                    metadata: { user_id: 'teacher-1' },
                });
                await deliverLate(store, subscriptionEvent('evt_done_raced', 'customer.subscription.updated'));
                expect(store.events.get('evt_done_raced')?.status).toBe('done');
            });

            it('an event type we do not handle', async () => {
                await handleStripeEvent(
                    { id: 'evt_done_other', type: 'customer.updated', data: { object: {} } },
                    store,
                    PRICE_TIERS,
                );
                expect(store.events.get('evt_done_other')?.status).toBe('done');
            });
        });
    });

    describe('a second entitling subscription for one user', () => {
        // What the partial unique index refuses, and what the handler does with
        // the refusal (QA round 4, D1). It can only happen if both the expiry
        // and the idempotency key in checkoutFlow.ts were bypassed -- which is
        // the point of a layer that does not depend on an Edge Function having
        // run at all.
        it('is acknowledged, left unrecorded, and alerted on', async () => {
            await deliver(store, subscriptionEvent('evt_one', 'customer.subscription.created'));
            expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'active', tier: 'teacher' });

            const second = await deliver(
                store,
                subscriptionEvent('evt_two', 'customer.subscription.created', { id: 'sub_2' }),
            );

            expect(second.status).toBe(200);
            expect(second.body).toMatchObject({ ignored: 'duplicate_active_subscription' });
            // No row, so get_entitlements cannot entitle the customer twice --
            // and delete-account still cancels it, because it lists
            // subscriptions from Stripe rather than from here.
            expect(store.subscriptions.has('sub_2')).toBe(false);
            expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'active', tier: 'teacher' });
            const alert = store.logs.find((line) => line.startsWith('ALERT'));
            expect(alert).toContain('teacher-1');
            expect(alert).toContain('sub_1');
            expect(alert).toContain('sub_2');
            // The refusal IS the detection, so the money stops here rather than
            // when a human reads the alert: the subscription that was refused is
            // the one cancelled and refunded, and the recorded one is left
            // entitling the customer.
            expect(store.canceledInStripe).toEqual(['sub_2']);
            expect(store.refundedInStripe).toEqual(['sub_2']);
            // Not retried: the constraint would refuse it identically for three
            // days, burying the endpoint failures that matter.
            expect(store.events.get('evt_two')?.status).toBe('done');
            expect(store.released).toEqual([]);
            // And nothing was archived or restored off a row that never landed.
            expect(store.restored).toEqual(['teacher-1']);
            expect(store.archived).toEqual([]);
        });

        it('does not stand in the way of the subscription updating itself', async () => {
            await deliver(store, subscriptionEvent('evt_live', 'customer.subscription.created'));
            const update = await deliver(
                store,
                subscriptionEvent('evt_live_2', 'customer.subscription.updated', { cancel_at_period_end: true }),
            );
            expect(update.body).toMatchObject({ applied: 'subscription_upserted' });
            expect(store.subscriptions.get('sub_1')).toMatchObject({ cancel_at_period_end: true });
        });

        it.each([
            ['the cancellation failed', { cancelFails: true }],
            ['the refund failed', { refundOutcome: 'failed' as const }],
        ])('asks Stripe to redeliver when %s', async (_name, failure) => {
            await deliver(store, subscriptionEvent('evt_dup_one', 'customer.subscription.created'));
            Object.assign(store, failure);

            const second = await deliver(
                store,
                subscriptionEvent('evt_dup_two', 'customer.subscription.created', { id: 'sub_2' }),
            );

            // An unrefunded duplicate is money we are holding that is not ours,
            // and both halves are safe to repeat, so the retry is the only thing
            // that can still put it right without a human.
            expect(second.status).toBeGreaterThanOrEqual(500);
            expect(second.body).toMatchObject({ retry: true });
            expect(store.released).toEqual(['evt_dup_two']);
            expect(store.subscriptions.has('sub_2')).toBe(false);
            expect(store.logs.some((line) => line.startsWith('ALERT') && line.includes('sub_2'))).toBe(true);
        });

        it.each([
            // Caught while still trialing: billed nothing, so nothing to hand back.
            ['there was nothing to refund', 'nothing_to_refund' as const],
            // A paid invoice whose payment cannot be identified reads the same
            // way on every retry, so three days of 500s would bury the alert
            // rather than surface it.
            ['only a human can refund it', 'needs_human' as const],
        ])('acknowledges the event when %s', async (_name, outcome) => {
            await deliver(store, subscriptionEvent('evt_dup_tri_one', 'customer.subscription.created'));
            store.refundOutcome = outcome;

            const second = await deliver(
                store,
                subscriptionEvent('evt_dup_tri_two', 'customer.subscription.created', { id: 'sub_2' }),
            );

            expect(second.status).toBe(200);
            expect(second.body).toMatchObject({ ignored: 'duplicate_active_subscription' });
            expect(store.canceledInStripe).toEqual(['sub_2']);
            expect(store.released).toEqual([]);
            expect(store.events.get('evt_dup_tri_two')?.status).toBe('done');
            const alert = store.logs.find((line) => line.startsWith('ALERT') && line.includes('sub_2'));
            expect(alert).toContain(outcome);
        });

        describe('a refund the event that found it could not finish', () => {
            /**
             * QA round 4 review of #56, finding 2. Asking Stripe to redeliver is
             * only a fix if the redelivery comes back to the refund, and it does
             * not: the CANCEL half succeeded, so the duplicate reads `canceled`
             * on the retry, `canceled` is not an entitling status, the partial
             * unique index has nothing to refuse, and the duplicate branch --
             * the only code that ever attempted a refund -- is never entered
             * again. The event is acknowledged 200 and the money stays ours.
             */
            const duplicateWithFailedRefund = async () => {
                await deliver(store, subscriptionEvent('evt_owed_one', 'customer.subscription.created'));
                store.refundOutcome = 'failed';
                const refused = await deliver(
                    store,
                    subscriptionEvent('evt_owed_two', 'customer.subscription.created', { id: 'sub_2' }),
                );
                return refused;
            };

            it('writes the debt down before it touches Stripe', async () => {
                // Before, not after: an isolate that dies between the cancel and
                // the refund has still charged the customer twice, and this row
                // is the only thing that would know.
                const order: string[] = [];
                const realRecord = store.recordPendingDuplicateUndo;
                store.recordPendingDuplicateUndo = async (id, userId) => {
                    order.push('record');
                    return realRecord(id, userId);
                };
                const realCancel = store.cancelDuplicateSubscription;
                store.cancelDuplicateSubscription = async (id) => {
                    order.push('stripe');
                    return realCancel(id);
                };

                await duplicateWithFailedRefund();

                expect(order).toEqual(['record', 'stripe']);
                expect(store.ledger.get('sub_2')).toMatchObject({ userId: 'teacher-1', state: 'pending' });
            });

            it('retries the refund from a later delivery, when nothing looks like a duplicate any more', async () => {
                const refused = await duplicateWithFailedRefund();
                expect(refused.status).toBeGreaterThanOrEqual(500);
                expect(store.refundedInStripe).toEqual([]);
                expect(store.ledger.get('sub_2')?.state).toBe('pending');

                // Stripe redelivers. By now our own cancel has landed, so the
                // duplicate is `canceled` in Stripe -- which is exactly why the
                // old code never got back to the refund.
                store.refundOutcome = 'refunded';
                store.remote.set('sub_2', {
                    id: 'sub_2',
                    status: 'canceled',
                    customer: 'cus_1',
                    items: { data: [{ price: { id: 'price_teacher_annual' } }] },
                    metadata: { user_id: 'teacher-1' },
                });
                const redelivery = await handleStripeEvent(
                    subscriptionEvent('evt_owed_two', 'customer.subscription.created', {
                        id: 'sub_2',
                        status: 'canceled',
                    }),
                    store,
                    PRICE_TIERS,
                );

                // The duplicate branch is NOT what did it: the write went
                // through as an ordinary cancellation.
                expect(redelivery.status).toBe(200);
                expect(redelivery.body).toMatchObject({ applied: 'subscription_upserted' });
                // And the money is back.
                expect(store.refundedInStripe).toEqual(['sub_2']);
                expect(store.ledger.get('sub_2')?.state).toBe('resolved');
                expect(store.logs.some((line) => line.includes('was still owed an undo'))).toBe(true);
                // The subscription that was recorded is untouched throughout.
                expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'active', tier: 'teacher' });
            });

            it('is retried by an unrelated event about the duplicate too', async () => {
                // The cancel we issued produces its own events, and any of them
                // is another chance -- which matters because Stripe eventually
                // stops retrying the event that found the duplicate.
                await duplicateWithFailedRefund();
                store.refundOutcome = 'refunded';

                const deleted = await deliver(
                    store,
                    subscriptionEvent('evt_owed_deleted', 'customer.subscription.deleted', { id: 'sub_2' }),
                );

                expect(deleted.status).toBe(200);
                expect(store.refundedInStripe).toEqual(['sub_2']);
                expect(store.ledger.get('sub_2')?.state).toBe('resolved');
            });

            it('keeps asking while the refund keeps failing, and keeps the debt written down', async () => {
                await duplicateWithFailedRefund();

                const again = await deliver(
                    store,
                    subscriptionEvent('evt_owed_again', 'customer.subscription.deleted', { id: 'sub_2' }),
                );

                expect(again.status).toBeGreaterThanOrEqual(500);
                expect(again.body).toMatchObject({ error: 'duplicate_not_undone', retry: true });
                expect(store.released).toContain('evt_owed_again');
                expect(store.ledger.get('sub_2')).toMatchObject({ state: 'pending' });
                // Every attempt is counted, which is how a human tells "Stripe
                // had a bad minute" from "no delivery will ever manage this".
                expect(store.ledger.get('sub_2')?.attempts).toBeGreaterThan(1);
                // Nothing was applied off the back of it.
                expect(store.subscriptions.has('sub_2')).toBe(false);
            });

            it('stops retrying a refund only a human can make, and says so in the ledger', async () => {
                await deliver(store, subscriptionEvent('evt_human_one', 'customer.subscription.created'));
                store.refundOutcome = 'needs_human';
                const refused = await deliver(
                    store,
                    subscriptionEvent('evt_human_two', 'customer.subscription.created', { id: 'sub_2' }),
                );

                // Acknowledged, as before -- an unidentifiable payment reads the
                // same way on every retry, and three days of 500s would bury the
                // alert rather than surface it.
                expect(refused.status).toBe(200);
                expect(store.ledger.get('sub_2')?.state).toBe('needs_human');

                // And nothing retries it, so a later event about that
                // subscription is not held up by a debt no delivery can settle.
                store.cancelDuplicateSubscription = async () => {
                    throw new Error('should not be retried');
                };
                const later = await deliver(
                    store,
                    subscriptionEvent('evt_human_later', 'customer.subscription.deleted', { id: 'sub_2' }),
                );
                expect(later.status).toBe(200);
            });

            it('leaves the ledger clean when the first attempt settles it', async () => {
                // The common case, and the one that must not become slower: no
                // row left pending, and no retry asked for.
                await deliver(store, subscriptionEvent('evt_clean_one', 'customer.subscription.created'));
                const second = await deliver(
                    store,
                    subscriptionEvent('evt_clean_two', 'customer.subscription.created', { id: 'sub_2' }),
                );

                expect(second.status).toBe(200);
                expect(store.ledger.get('sub_2')?.state).toBe('resolved');
                expect(store.released).toEqual([]);
                // A later event about it asks Stripe for nothing.
                store.cancelDuplicateSubscription = async () => {
                    throw new Error('should not be retried');
                };
                expect((await deliver(store, subscriptionEvent('evt_clean_later', 'invoice.paid'))).status).toBe(200);
            });

            it.each([
                ['refunded', 'refunded' as const, 'resolved' as const],
                // Caught while still trialing: billed nothing, so nothing is owed.
                ['nothing was taken', 'nothing_to_refund' as const, 'resolved' as const],
                ['only a human can refund it', 'needs_human' as const, 'needs_human' as const],
                ['the refund failed', 'failed' as const, 'pending' as const],
            ])('records %s as %s', (_name, refund, state) => {
                expect(duplicateUndoStateOf({ stopped: true, refund, detail: '' })).toBe(state);
            });

            it('records a cancel that did not stop as still owed, whatever the refund did', () => {
                // A duplicate that can still bill is not undone even if the
                // money for the period already billed is back.
                expect(duplicateUndoStateOf({ stopped: false, refund: 'refunded', detail: '' })).toBe('pending');
            });
        });

        it('does not stand in the way of a new subscription after a cancellation', async () => {
            await deliver(store, subscriptionEvent('evt_old', 'customer.subscription.created'));
            await deliver(store, subscriptionEvent('evt_old_gone', 'customer.subscription.deleted'));
            const fresh = await deliver(
                store,
                subscriptionEvent('evt_fresh', 'customer.subscription.created', { id: 'sub_3' }),
            );
            expect(fresh.body).toMatchObject({ applied: 'subscription_upserted' });
            expect(store.subscriptions.get('sub_3')).toMatchObject({ status: 'active', tier: 'teacher' });
        });
    });

    describe('writes that land out of order', () => {
        // The window the live read-back cannot close (QA round 4, D3): both
        // deliveries read the CURRENT state, so neither applies a stale copy,
        // but their writes can still land in the wrong order -- A reads active,
        // B reads the newer past_due, B writes, A writes active. The row then
        // says a customer whose card failed is paid up until the next event
        // about them, a month or a year away.

        it('refuses a write carrying an older event stamp than the row holds', async () => {
            await deliver(
                store,
                subscriptionEvent(
                    'evt_newer',
                    'customer.subscription.updated',
                    { status: 'past_due' },
                    EVENT_CREATED + 60,
                ),
            );
            expect(store.subscriptions.get('sub_1')?.status).toBe('past_due');

            // A's read saw the state before B's change; its write lands second.
            const late = await deliver(
                store,
                subscriptionEvent('evt_older', 'customer.subscription.updated', { status: 'active' }, EVENT_CREATED),
            );

            // Still a 200: Stripe must not be asked to retry an event that is
            // simply too old to matter.
            expect(late.status).toBe(200);
            expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'past_due', tier: 'free' });
            expect(store.staleWritesRefused).toEqual(['sub_1']);
            // The archival and restore that follow a write read the user's
            // entitlements back from the database, so the dropped write cannot
            // archive a customer whose row still says past_due either.
            expect(store.archived).toEqual([]);
        });

        it('applies a write carrying a newer stamp', async () => {
            await deliver(store, subscriptionEvent('evt_first_stamp', 'customer.subscription.updated'));
            const next = await deliver(
                store,
                subscriptionEvent(
                    'evt_second_stamp',
                    'customer.subscription.updated',
                    { status: 'past_due' },
                    EVENT_CREATED + 60,
                ),
            );
            expect(next.body).toMatchObject({ applied: 'subscription_upserted' });
            expect(store.subscriptions.get('sub_1')?.status).toBe('past_due');
        });

        it('lets a write through against a row written before the stamp existed', async () => {
            // Every row that predates the migration has no stamp. Refusing
            // those would freeze them for good.
            store.subscriptions.set('sub_1', {
                ...subscriptionRowFrom(
                    { id: 'sub_1', status: 'active', items: { data: [{ price: { id: 'price_teacher_annual' } }] } },
                    'teacher-1',
                    PRICE_TIERS,
                ),
                last_event_created_at: null,
            });

            await deliver(store, subscriptionEvent('evt_stamps_it', 'customer.subscription.updated'));

            expect(store.subscriptions.get('sub_1')?.last_event_created_at).toBe(
                new Date(EVENT_CREATED * 1000).toISOString(),
            );
            expect(store.staleWritesRefused).toEqual([]);
        });

        it('keeps the row stamp when a write carries none', async () => {
            // An unstamped write is applied -- refusing it would swallow a
            // legitimate change -- but it must not wipe the high-water mark, or
            // the next stale event walks straight in.
            await deliver(store, subscriptionEvent('evt_stamped', 'customer.subscription.updated'));
            const unstamped = {
                ...subscriptionEvent('evt_unstamped', 'customer.subscription.updated', { status: 'past_due' }),
                created: undefined,
            };

            await deliver(store, unstamped);

            expect(store.subscriptions.get('sub_1')).toMatchObject({
                status: 'past_due',
                last_event_created_at: new Date(EVENT_CREATED * 1000).toISOString(),
            });

            const older = await deliver(
                store,
                subscriptionEvent(
                    'evt_older_still',
                    'customer.subscription.updated',
                    { status: 'active' },
                    EVENT_CREATED - 60,
                ),
            );
            expect(older.status).toBe(200);
            expect(store.subscriptions.get('sub_1')?.status).toBe('past_due');
        });
    });

    describe('two deliveries about one subscription at once', () => {
        // What the staleness trigger cannot see (QA round 4, D3 follow-up).
        // Stripe stamps `created` to the second, and equal stamps have to pass
        // the trigger -- a retry of one event must be able to write its own
        // state again -- so two events created inside the SAME second and
        // delivered concurrently could still land in the order they READ in
        // rather than the order they wrote in. The per-subscription write lock
        // makes the read and the write one step, which is the only thing that
        // orders them.
        const activeRemote = { status: 'active' };
        const pastDueRemote = { status: 'past_due' };
        const remote = (overrides: Partial<StripeSubscriptionLike>): StripeSubscriptionLike => ({
            id: 'sub_1',
            status: 'active',
            customer: 'cus_1',
            current_period_end: 1_800_000_000,
            items: { data: [{ price: { id: 'price_teacher_annual' } }] },
            metadata: { user_id: 'teacher-1' },
            ...overrides,
        });

        it('agrees with the window claim_subscription_write is called with', () => {
            expect(STRIPE_SUBSCRIPTION_LOCK_STALE_AFTER).toBe(`${LOCK_STALE_AFTER_MS / 60_000} minutes`);
        });

        it('leases the write for longer than an invocation can run', () => {
            // "An Edge Function cannot run for anything like two minutes" was
            // the old comment, and it was wrong (QA round 4 review of #56,
            // finding 3): a delivery stalled inside the Stripe read this lock is
            // held across outlived its own lease.
            expect(STRIPE_SUBSCRIPTION_LOCK_STALE_AFTER_MS).toBeGreaterThan(EDGE_FUNCTION_WALL_CLOCK_MS);
        });

        it('refuses the write of a delivery whose lease was taken over', async () => {
            // The whole of finding 3, in order. A reads `past_due` and stalls on
            // its way to the write for longer than its own lease. B takes the
            // lease over, reads the newer `active`, writes it, releases. A then
            // writes -- and before the fix nothing refused it, because only the
            // RELEASE ever checked whose lease it was and the staleness trigger
            // cannot order two events Stripe stamped in the same second. The row
            // ended up saying a customer whose card had just been fixed was
            // past_due, until the next event about them a month or a year later.
            store.remote.set('sub_1', remote(pastDueRemote));
            const gate = latch();
            const realUpsert = store.upsertSubscription;
            let suspend = true;
            store.upsertSubscription = async (row, holder) => {
                if (suspend) {
                    suspend = false;
                    gate.arrive();
                    await gate.released;
                }
                return realUpsert(row, holder);
            };

            const stalled = handleStripeEvent(
                subscriptionEvent('evt_lease_a', 'customer.subscription.updated', pastDueRemote),
                store,
                PRICE_TIERS,
            );
            await gate.arrived;

            // A is still inside its write when its lease goes stale.
            store.clock += LOCK_STALE_AFTER_MS + 1_000;
            store.remote.set('sub_1', remote(activeRemote));
            const tookOver = await handleStripeEvent(
                subscriptionEvent('evt_lease_b', 'customer.subscription.updated', activeRemote),
                store,
                PRICE_TIERS,
            );

            expect(tookOver.body).toMatchObject({ applied: 'subscription_upserted' });
            expect(store.subscriptions.get('sub_1')?.status).toBe('active');

            gate.release();
            const stalledResult = await stalled;

            // Nothing was written, so the 503 is honest and the redelivery can
            // read Stripe again rather than re-applying a minutes-old answer.
            expect(stalledResult.status).toBe(503);
            expect(stalledResult.body).toMatchObject({ error: 'subscription_write_lease_lost', retry: true });
            expect(store.writesRefusedWithoutLease).toEqual(['sub_1']);
            expect(store.subscriptions.get('sub_1')?.status).toBe('active');
            // The claim goes with it: a 503 Stripe will redeliver must not read
            // as a duplicate when it does. (Only the call is asserted, not the
            // row: `held` on this fake is one claim stamp for the whole store,
            // where the real one closes over it per request, so across an
            // overlap it is the second delivery's.)
            expect(store.released).toEqual(['evt_lease_a']);
            // And the trigger never fired: the two stamps are equal, which is
            // exactly why the lease had to be checked at the write.
            expect(store.staleWritesRefused).toEqual([]);
        });

        it('carries the holder into the write, so there is a lease to check', async () => {
            // The mechanism the test above turns on: a write that did not carry
            // the lease token could not be refused by one.
            store.remote.set('sub_1', remote(activeRemote));
            const seen: string[] = [];
            const realUpsert = store.upsertSubscription;
            store.upsertSubscription = async (row, holder) => {
                seen.push(holder);
                return realUpsert(row, holder);
            };

            await deliverLate(store, subscriptionEvent('evt_holder', 'customer.subscription.updated'));

            expect(seen).toHaveLength(1);
            // The token claim_subscription_write answered with, and no other.
            expect(seen[0]).toBe(`lock-${store.locksTaken}`);
        });

        it('refuses the second delivery and asks Stripe to redeliver it', async () => {
            // A reads `active` and is suspended on its way to the write. The
            // card then fails in Stripe, in the same second, and B arrives
            // carrying the newer change. Without the lock B would read
            // `past_due`, write it, and then A's suspended write would put
            // `active` back -- a customer whose card failed, recorded as paid up
            // until the next event about them.
            store.remote.set('sub_1', remote(activeRemote));
            const gate = latch();
            const realUpsert = store.upsertSubscription;
            let suspend = true;
            store.upsertSubscription = async (row, holder) => {
                if (suspend) {
                    suspend = false;
                    gate.arrive();
                    await gate.released;
                }
                return realUpsert(row, holder);
            };

            const first = handleStripeEvent(
                subscriptionEvent('evt_race_a', 'customer.subscription.updated', activeRemote),
                store,
                PRICE_TIERS,
            );
            await gate.arrived;

            store.remote.set('sub_1', remote(pastDueRemote));
            const second = await handleStripeEvent(
                subscriptionEvent('evt_race_b', 'customer.subscription.updated', pastDueRemote),
                store,
                PRICE_TIERS,
            );

            expect(second.status).toBe(503);
            expect(second.body).toMatchObject({ retry: true });
            // Its claim is released, so the redelivery Stripe is being asked for
            // is processed rather than answered as a duplicate.
            expect(store.released).toEqual(['evt_race_b']);
            expect(store.events.has('evt_race_b')).toBe(false);

            gate.release();
            await first;
            expect(store.subscriptions.get('sub_1')?.status).toBe('active');
            // The lock is given back, so the redelivery gets it...
            expect(store.locks.size).toBe(0);

            const redelivery = await handleStripeEvent(
                subscriptionEvent('evt_race_b', 'customer.subscription.updated', pastDueRemote),
                store,
                PRICE_TIERS,
            );

            // ...and reads Stripe AFTER A's write, so what lands is the current
            // state and not whichever delivery happened to write last.
            expect(redelivery.body).toMatchObject({ applied: 'subscription_upserted' });
            expect(store.subscriptions.get('sub_1')?.status).toBe('past_due');
            // And the trigger never fired: the two stamps are equal, which is
            // exactly why the lock had to do this rather than the comparison.
            expect(store.staleWritesRefused).toEqual([]);
        });

        it('gives the lock back after every delivery, including a failed one', async () => {
            store.remote.set('sub_1', remote(activeRemote));
            await deliverLate(store, subscriptionEvent('evt_lock_ok', 'customer.subscription.updated'));
            expect(store.locks.size).toBe(0);

            store.applyFreeTierArchival = async () => {
                throw new Error('connection reset');
            };
            store.remote.set('sub_1', remote({ status: 'canceled' }));
            await expect(
                handleStripeEvent(
                    subscriptionEvent('evt_lock_throw', 'customer.subscription.updated', { status: 'canceled' }),
                    store,
                    PRICE_TIERS,
                ),
            ).rejects.toThrow('connection reset');

            // A lease nobody released would refuse every later event about this
            // subscription until it went stale.
            expect(store.locks.size).toBe(0);
        });

        it('takes a lock over once the delivery holding it is long gone', async () => {
            // The lease, for the same reason the event claim has one: an isolate
            // killed mid-write releases nothing.
            store.remote.set('sub_1', remote(activeRemote));
            await store.lockSubscription('sub_1');

            const refused = await deliverLate(
                store,
                subscriptionEvent('evt_locked_out', 'customer.subscription.updated'),
            );
            expect(refused.status).toBe(503);

            store.clock += LOCK_STALE_AFTER_MS + 1_000;
            const taken = await deliverLate(
                store,
                subscriptionEvent('evt_takes_over', 'customer.subscription.updated'),
            );

            expect(taken.body).toMatchObject({ applied: 'subscription_upserted' });
            expect(store.subscriptions.get('sub_1')?.status).toBe('active');
        });

        it('locks the subscription a checkout and an invoice are about too', async () => {
            // All three paths that read Stripe and write the row take it; a path
            // that did not would be free to interleave with the ones that do.
            store.remote.set('sub_1', remote(activeRemote));
            await store.lockSubscription('sub_1');

            const checkout = await handleStripeEvent(
                {
                    id: 'evt_checkout_locked',
                    type: 'checkout.session.completed',
                    created: EVENT_CREATED,
                    data: { object: { customer: 'cus_1', client_reference_id: 'teacher-1', subscription: 'sub_1' } },
                },
                store,
                PRICE_TIERS,
            );
            const invoice = await handleStripeEvent(
                {
                    id: 'evt_invoice_locked',
                    type: 'invoice.paid',
                    created: EVENT_CREATED,
                    data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
                },
                store,
                PRICE_TIERS,
            );

            expect(checkout.status).toBe(503);
            expect(invoice.status).toBe(503);
            expect(store.subscriptions.size).toBe(0);
            expect(store.released).toEqual(['evt_checkout_locked', 'evt_invoice_locked']);
        });
    });

    describe('renewals and pauses', () => {
        it.each(['invoice.paid', 'invoice.payment_succeeded'])(
            'applies the subscription Stripe holds now on %s',
            async (type) => {
                // Unhandled, these left the row holding the period end that had
                // just been superseded, so get_entitlements saw an expired plan
                // and dropped the teacher to free limits until some other event
                // arrived (QA round 4, D6). Same shape as
                // invoice.payment_failed: read the subscription back, apply it.
                store.remote.set('sub_1', {
                    id: 'sub_1',
                    status: 'active',
                    customer: 'cus_1',
                    current_period_end: 1_900_000_000,
                    items: { data: [{ price: { id: 'price_teacher_annual' } }] },
                    metadata: { user_id: 'teacher-1' },
                });

                const result = await handleStripeEvent(
                    {
                        id: `evt_${type}`,
                        type,
                        created: EVENT_CREATED,
                        data: { object: { customer: 'cus_1', subscription: 'sub_1' } },
                    },
                    store,
                    PRICE_TIERS,
                );

                expect(result.status).toBe(200);
                expect(result.body).toMatchObject({ applied: 'invoice_recorded' });
                expect(store.subscriptions.get('sub_1')).toMatchObject({
                    status: 'active',
                    tier: 'teacher',
                    current_period_end: new Date(1_900_000_000 * 1000).toISOString(),
                });
                expect(store.restored).toEqual(['teacher-1']);
            },
        );

        it('stops a paused subscription entitling, and entitles again on resume', async () => {
            // A pause bills nothing. Unhandled, the row kept saying `active` and
            // kept entitling for free (QA round 4, D6).
            await deliver(store, subscriptionEvent('evt_paused', 'customer.subscription.paused', { status: 'paused' }));

            expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'paused', tier: 'free' });
            // Not archived: a pause is reversible, and `paused` is not an
            // archiving status, so the teacher's scores stay as they are.
            expect(store.archived).toEqual([]);

            await deliver(
                store,
                subscriptionEvent(
                    'evt_resumed',
                    'customer.subscription.resumed',
                    { status: 'active' },
                    EVENT_CREATED + 60,
                ),
            );

            expect(store.subscriptions.get('sub_1')).toMatchObject({ status: 'active', tier: 'teacher' });
            expect(store.restored).toEqual(['teacher-1']);
        });
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

    it('is wired into the checkout flow ahead of creating any session', () => {
        // The decisions moved to _shared/checkoutFlow.ts, where the suite can
        // drive them (tests/billing/checkoutFlow.test.ts); stripe-checkout is
        // wiring. The ORDER is what this holds in place, in the two functions it
        // is spread across: this guard before the lock is taken, and then --
        // inside the lock -- the customer, whose subscriptions and sessions are
        // the ones read, before the expiry, before a new session. Creating the
        // session before expiring the old ones leaves two that can be paid,
        // which is the double charge itself.
        const source = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/checkoutFlow.ts'), 'utf8');
        const guard = source.indexOf('deps.holdsRunningSubscription(running.rows');
        expect(guard).toBeGreaterThan(0);
        expect(guard).toBeLessThan(source.indexOf('deps.beginAttempt('));
        const order = [
            'deps.findCustomer(',
            'deps.stripeSubscriptionStatuses(',
            'deps.fetchSession(',
            'deps.expireOpenSessions(',
            'deps.createSession(',
            'deps.finishAttempt(',
        ].map((call) => {
            const at = source.indexOf(call);
            expect(at, call).toBeGreaterThan(0);
            return at;
        });
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(source).toMatch(/code: 'already_subscribed'/);
    });
});
