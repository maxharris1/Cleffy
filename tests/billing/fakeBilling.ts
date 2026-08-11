import {
    monthKeyOf,
    resolveEntitlements,
    type Entitlements,
    type QuotaBackend,
    type SubscriptionLike,
    type UsageMetric,
} from '../../supabase/functions/_shared/entitlements';

/**
 * In-memory stand-in for the billing tables, implementing the contract that
 * supabase/migrations/20260811120000_billing.sql defines.
 *
 * Same idea as `FakeApi` in src/sync/syncEngine.test.ts: the production code
 * under test is real, only the storage behind it is faked. What it reproduces
 * deliberately:
 *  - consume_quota()'s atomicity, as an increment that only happens when the
 *    check passes, so "rejected" and "not incremented" cannot come apart;
 *  - the calendar-month key, so rollover is exercised;
 *  - the cloud-score cap as a stock (count of live rows), not a counter.
 *
 * Postgres remains the real authority — this is how the rules get exercised in
 * CI without one.
 */

export interface FakeBillingOptions {
    now?: Date;
}

export class FakeBilling implements QuotaBackend {
    subscriptions: SubscriptionLike[] = [];
    /** user id -> owner ids of the studios they hold a seat in. */
    studioSeats = new Map<string, string[]>();
    counters = new Map<string, number>();
    /** owner id -> ids of their non-archived documents. */
    activeScores = new Map<string, string[]>();

    now: Date;

    constructor(options: FakeBillingOptions = {}) {
        this.now = options.now ?? new Date('2026-08-11T12:00:00Z');
    }

    private counterKey(userId: string, metric: UsageMetric): string {
        return `${userId}|${metric}|${monthKeyOf(this.now)}`;
    }

    countOf(userId: string, metric: UsageMetric): number {
        return this.counters.get(this.counterKey(userId, metric)) ?? 0;
    }

    /** Mirrors get_entitlements(): own live subscription, then a paid studio seat, then free. */
    getEntitlements = async (userId: string): Promise<Entitlements | null> =>
        resolveEntitlements(
            {
                userId,
                subscriptions: this.subscriptions,
                studioOwnerIds: this.studioSeats.get(userId) ?? [],
                ownerSubscriptions: this.subscriptions,
            },
            this.now.getTime(),
        );

    /**
     * Mirrors consume_quota(). The check and the increment are one step here for
     * the same reason they are one statement in SQL: a caller must never be told
     * "no" after the counter already moved.
     */
    consumeQuota = async (
        userId: string,
        metric: UsageMetric,
        limit: number,
    ): Promise<{ ok: boolean; count: number } | null> => {
        if (limit === 0) {
            return { ok: false, count: 0 };
        }
        const key = this.counterKey(userId, metric);
        const current = this.counters.get(key) ?? 0;
        if (limit > 0 && current >= limit) {
            return { ok: false, count: current };
        }
        const next = current + 1;
        this.counters.set(key, next);
        return { ok: true, count: next };
    };

    /** Mirrors release_quota(): never below zero. */
    releaseQuota(userId: string, metric: UsageMetric): void {
        const key = this.counterKey(userId, metric);
        this.counters.set(key, Math.max(0, (this.counters.get(key) ?? 0) - 1));
    }

    subscribe(userId: string, tier: 'pro' | 'studio', overrides: Partial<SubscriptionLike> = {}): void {
        this.subscriptions.push({
            user_id: userId,
            tier,
            status: 'active',
            current_period_end: '2027-08-11T12:00:00Z',
            ...overrides,
        });
    }

    seatIn(memberId: string, ownerId: string): void {
        this.studioSeats.set(memberId, [...(this.studioSeats.get(memberId) ?? []), ownerId]);
    }

    /**
     * Mirrors the documents_enforce_score_cap trigger: raises with the same
     * P0001 + JSON DETAIL shape PostgREST would surface to the client.
     */
    async insertScore(ownerId: string, scoreId: string): Promise<void> {
        const entitlements = await this.getEntitlements(ownerId);
        const limit = entitlements?.limits.cloud_scores ?? 0;
        const active = this.activeScores.get(ownerId) ?? [];
        if (limit >= 0 && active.length >= limit) {
            throw {
                code: 'P0001',
                message: 'limit_reached',
                details: JSON.stringify({
                    code: 'limit_reached',
                    metric: 'cloud_scores',
                    limit,
                    tier: entitlements?.tier ?? 'free',
                }),
            };
        }
        this.activeScores.set(ownerId, [...active, scoreId]);
    }

    /** Archiving frees a slot without deleting anything — the lapse behaviour. */
    archiveScore(ownerId: string, scoreId: string): void {
        this.activeScores.set(
            ownerId,
            (this.activeScores.get(ownerId) ?? []).filter((id) => id !== scoreId),
        );
    }
}
