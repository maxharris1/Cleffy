import { describe, expect, it } from 'vitest';

import { TIER_LIMITS } from '../../supabase/functions/_shared/entitlements';
import {
    handleStripeEvent,
    type StripeEventLike,
    type StripeSubscriptionLike,
    type SubscriptionUpsert,
    type WebhookStore,
} from '../../supabase/functions/_shared/stripeEvents';
import { FakeBilling } from './fakeBilling';

/**
 * Lapse and resubscribe, end to end: the real webhook handler driving the
 * archive/restore contract of apply_free_tier_archival() and
 * restore_plan_archived_scores() (20261007120300_billing_correctness.sql), as
 * FakeBilling mirrors it. Same split as enforcement.test.ts: the production
 * decision code is real, only the tables are faked.
 *
 * What a paying customer is owed here: cancelling never deletes anything, and
 * coming back -- a new checkout, paying an unpaid invoice -- gives back every
 * score the lapse took away, without touching one they archived themselves.
 */

const FREE_SCORES = TIER_LIMITS.free.cloud_scores;

const PRICE_TIERS = {
    price_teacher_annual: 'teacher',
    price_personal_monthly: 'personal',
    price_academy_monthly: 'academy',
} as const;

/** A WebhookStore whose subscriptions and archive live in one FakeBilling. */
class BillingBackedStore implements WebhookStore {
    events = new Set<string>();
    rows = new Map<string, SubscriptionUpsert>();
    remote = new Map<string, StripeSubscriptionLike>();
    archivedCounts: number[] = [];
    restoredCounts: number[] = [];

    constructor(readonly billing: FakeBilling) {}

    claimEvent = async (id: string) => {
        if (this.events.has(id)) {
            return false;
        }
        this.events.add(id);
        return true;
    };
    releaseEvent = async (id: string) => {
        this.events.delete(id);
    };
    userIdForCustomer = async () => null;
    linkCustomer = async () => undefined;
    upsertSubscription = async (row: SubscriptionUpsert) => {
        this.rows.set(row.stripe_subscription_id, row);
        this.billing.subscriptions = [...this.rows.values()].map((r) => ({
            user_id: r.user_id,
            tier: r.tier,
            status: r.status,
            current_period_end: r.current_period_end,
        }));
    };
    fetchSubscription = async (id: string) => this.remote.get(id) ?? null;
    userIdForSubscription = async (id: string) => this.rows.get(id)?.user_id ?? null;
    storedStatusOf = async (id: string) => this.rows.get(id)?.status ?? null;
    applyFreeTierArchival = async (userId: string) => {
        this.archivedCounts.push(await this.billing.applyFreeTierArchival(userId));
    };
    restorePlanArchivedScores = async (userId: string) => {
        this.restoredCounts.push(await this.billing.restorePlanArchivedScores(userId));
    };
    log = () => undefined;
}

const subEvent = (id: string, type: string, overrides: Partial<StripeSubscriptionLike> = {}): StripeEventLike => ({
    id,
    type,
    data: {
        object: {
            id: 'sub_1',
            status: 'active',
            current_period_end: 1_900_000_000,
            items: { data: [{ price: { id: 'price_teacher_annual' } }] },
            metadata: { user_id: 'teacher' },
            ...overrides,
        },
    },
});

/**
 * Stripe sending `event` right after the change it reports: the embedded
 * object is the subscription's current state, which is what the handler's
 * live re-read answers (a deleted subscription reads back as canceled).
 */
const deliver = (store: BillingBackedStore, event: StripeEventLike) => {
    const object = event.data.object as StripeSubscriptionLike;
    store.remote.set(
        object.id,
        event.type === 'customer.subscription.deleted' ? { ...object, status: 'canceled' } : object,
    );
    return handleStripeEvent(event, store, PRICE_TIERS);
};

/** A paying teacher with `count` scores, score-0 the least recently touched. */
const payingTeacherWith = async (count: number) => {
    const billing = new FakeBilling();
    const store = new BillingBackedStore(billing);
    await deliver(store, subEvent('evt_start', 'customer.subscription.created'));
    for (let i = 0; i < count; i += 1) {
        await billing.insertScore('teacher', `score-${i}`);
    }
    return { billing, store };
};

const active = (billing: FakeBilling) => [...(billing.activeScores.get('teacher') ?? [])].sort();

describe('lapse and resubscribe', () => {
    it('archives past the free cap on cancellation, keeping the most recently used scores', async () => {
        const { billing, store } = await payingTeacherWith(6);

        await deliver(store, subEvent('evt_cancel', 'customer.subscription.deleted'));

        expect(store.archivedCounts).toEqual([6 - FREE_SCORES]);
        expect(active(billing)).toEqual(['score-3', 'score-4', 'score-5']);
        expect(billing.archivedScores.get('teacher')?.every((row) => row.reason === 'plan_lapse')).toBe(true);
    });

    it('restores every lapse-archived score on a new checkout', async () => {
        const { billing, store } = await payingTeacherWith(6);
        await deliver(store, subEvent('evt_cancel', 'customer.subscription.deleted'));

        store.remote.set('sub_2', {
            id: 'sub_2',
            status: 'active',
            items: { data: [{ price: { id: 'price_teacher_annual' } }] },
        });
        const result = await handleStripeEvent(
            {
                id: 'evt_checkout',
                type: 'checkout.session.completed',
                data: { object: { subscription: 'sub_2', client_reference_id: 'teacher' } },
            },
            store,
            PRICE_TIERS,
        );

        expect(result.status).toBe(200);
        expect(store.restoredCounts.at(-1)).toBe(6 - FREE_SCORES);
        expect(active(billing)).toHaveLength(6);
        expect(billing.archivedScores.get('teacher')).toEqual([]);
    });

    it('restores when an unpaid subscription is paid', async () => {
        const { billing, store } = await payingTeacherWith(5);
        await deliver(store, subEvent('evt_unpaid', 'customer.subscription.updated', { status: 'unpaid' }));
        expect(active(billing)).toHaveLength(FREE_SCORES);

        await deliver(store, subEvent('evt_paid', 'customer.subscription.updated', { status: 'active' }));
        expect(active(billing)).toHaveLength(5);
    });

    it('archives nothing when an unpaid event is retried after the customer has paid', async () => {
        // The unpaid event's first delivery failed (Stripe could not be read,
        // so the claim was released and a retry requested); the customer paid
        // before Stripe retried it. Applied from its embedded copy, the retry
        // would archive two of a paying teacher's scores until the next event.
        const { billing, store } = await payingTeacherWith(5);
        const unpaid = subEvent('evt_unpaid_retried', 'customer.subscription.updated', { status: 'unpaid' });
        store.remote.delete('sub_1');
        expect((await handleStripeEvent(unpaid, store, PRICE_TIERS)).status).toBeGreaterThanOrEqual(500);

        await deliver(store, subEvent('evt_paid_first', 'customer.subscription.updated'));
        const retried = await handleStripeEvent(unpaid, store, PRICE_TIERS);

        expect(retried.status).toBe(200);
        expect(store.archivedCounts).toEqual([]);
        expect(active(billing)).toHaveLength(5);
        expect(store.rows.get('sub_1')).toMatchObject({ status: 'active', tier: 'teacher' });
    });

    it('never restores a score the owner archived themselves', async () => {
        const { billing, store } = await payingTeacherWith(5);
        billing.archiveScore('teacher', 'score-4');

        await deliver(store, subEvent('evt_cancel', 'customer.subscription.deleted'));
        await deliver(store, subEvent('evt_back', 'customer.subscription.created', { id: 'sub_2' }));

        expect(active(billing)).toEqual(['score-0', 'score-1', 'score-2', 'score-3']);
        expect(billing.archivedScores.get('teacher')).toEqual([{ id: 'score-4', reason: 'owner' }]);
    });

    it('archives nothing when another plan is still live', async () => {
        const { billing, store } = await payingTeacherWith(5);
        await deliver(
            store,
            subEvent('evt_second', 'customer.subscription.created', {
                id: 'sub_personal',
                items: { data: [{ price: { id: 'price_personal_monthly' } }] },
            }),
        );

        await deliver(store, subEvent('evt_cancel', 'customer.subscription.deleted'));

        expect(store.archivedCounts).toEqual([0]);
        expect(active(billing)).toHaveLength(5);
    });

    it('restores no further than the cap of a plan that still resolves to free', async () => {
        // An entitling status on a price the catalogue does not know stores tier
        // free. The restore must stop where the owner could have unarchived by
        // hand, and the cap must still hold afterwards.
        const { billing, store } = await payingTeacherWith(6);
        await deliver(store, subEvent('evt_cancel', 'customer.subscription.deleted'));
        // The teacher deleted one of the three kept while on Free.
        billing.activeScores.set('teacher', ['score-4', 'score-5']);

        await deliver(
            store,
            subEvent('evt_mystery', 'customer.subscription.created', {
                id: 'sub_mystery',
                items: { data: [{ price: { id: 'price_retired' } }] },
            }),
        );

        expect(store.restoredCounts.at(-1)).toBe(1);
        // Most recently used first: score-2 was the newest of the archived three.
        expect(active(billing)).toEqual(['score-2', 'score-4', 'score-5']);
        await expect(billing.insertScore('teacher', 'one-too-many')).rejects.toMatchObject({
            message: 'limit_reached',
        });
    });

    describe('an Academy seat', () => {
        const academyEvent = (id: string, type: string, overrides: Partial<StripeSubscriptionLike> = {}) =>
            subEvent(id, type, {
                id: 'sub_academy',
                items: { data: [{ price: { id: 'price_academy_monthly' } }] },
                metadata: { user_id: 'owner' },
                ...overrides,
            });

        /**
         * A seated teacher whose own plan lapsed while the Academy owner was not
         * paying either: archived down to the free cap, with nothing of their
         * own left to send a webhook when the owner pays again.
         */
        const lapsedSeatHolder = async () => {
            const { billing, store } = await payingTeacherWith(5);
            billing.seatIn('teacher', 'owner');
            await deliver(store, academyEvent('evt_academy', 'customer.subscription.created'));
            await deliver(store, academyEvent('evt_academy_cancel', 'customer.subscription.deleted'));
            await deliver(store, subEvent('evt_cancel', 'customer.subscription.deleted'));
            expect(active(billing)).toHaveLength(FREE_SCORES);
            return { billing, store };
        };

        it('restores the seated teacher when the Academy owner resubscribes', async () => {
            const { billing, store } = await lapsedSeatHolder();

            await deliver(
                store,
                academyEvent('evt_academy_back', 'customer.subscription.created', { id: 'sub_academy_2' }),
            );

            expect(store.restoredCounts.at(-1)).toBe(5 - FREE_SCORES);
            expect(active(billing)).toHaveLength(5);
            expect(billing.archivedScores.get('teacher')).toEqual([]);
        });

        it('restores the seated teacher when the owner pays an unpaid Academy invoice', async () => {
            const { billing, store } = await lapsedSeatHolder();

            await deliver(
                store,
                academyEvent('evt_academy_unpaid', 'customer.subscription.updated', {
                    id: 'sub_academy_2',
                    status: 'unpaid',
                }),
            );
            expect(active(billing)).toHaveLength(FREE_SCORES);

            await deliver(
                store,
                academyEvent('evt_academy_paid', 'customer.subscription.updated', { id: 'sub_academy_2' }),
            );
            expect(active(billing)).toHaveLength(5);
        });

        it('restores nothing past the free cap when the owner comes back on a plan without seats', async () => {
            // A seat entitles only through an Academy subscription; the owner
            // returning on Teacher leaves the seated teacher on Free.
            const { billing, store } = await lapsedSeatHolder();

            await deliver(
                store,
                subEvent('evt_owner_teacher', 'customer.subscription.created', {
                    id: 'sub_owner_teacher',
                    metadata: { user_id: 'owner' },
                }),
            );

            expect(active(billing)).toHaveLength(FREE_SCORES);
            expect(billing.archivedScores.get('teacher')?.filter((row) => row.reason === 'plan_lapse')).toHaveLength(
                5 - FREE_SCORES,
            );
        });
    });

    it('does nothing more on a replayed reactivation', async () => {
        const { billing, store } = await payingTeacherWith(5);
        await deliver(store, subEvent('evt_cancel', 'customer.subscription.deleted'));
        const back = subEvent('evt_back', 'customer.subscription.created', { id: 'sub_2' });

        await deliver(store, back);
        const replay = await handleStripeEvent(back, store, PRICE_TIERS);

        expect(replay.body).toMatchObject({ duplicate: true });
        expect(store.restoredCounts).toEqual([0, 2]);
        expect(active(billing)).toHaveLength(5);
    });
});
