/**
 * Entitlement rules, shared by the Edge Functions and the test suite.
 *
 * NO imports — Deno loads this with the `.ts` extension, vitest without it
 * (`allowImportingTsExtensions` is off), and neither can follow a specifier the
 * other rejects. Anything needing a Supabase client lives in ./quota.ts instead.
 *
 * Postgres is the enforcement authority: get_entitlements() and consume_quota()
 * in supabase/migrations/20260826193902_billing.sql decide what actually
 * happens. `resolveEntitlements` here is the executable specification of that
 * SQL — it is what lets the rules be tested in CI without a Postgres, and
 * tests/billing/limitsInSync.test.ts parses the migration to prove TIER_LIMITS
 * has not drifted from tier_limits().
 */

export type BillingTier = 'free' | 'personal' | 'teacher' | 'academy';

/**
 * What an account effectively is, which is not always something you can buy.
 * 'student' is a provisioned account — a real user carrying
 * app_metadata.user_type = 'student' — and it never appears on a subscription
 * row, which is why TIER_LIMITS below stays keyed by the four purchasable tiers.
 */
export type EffectiveTier = BillingTier | 'student';

export type UsageMetric = 'cloud_scores' | 'omr_runs' | 'vision_reads' | 'smart_imports' | 'pdf_exports' | 'students';

/**
 * -1 means unlimited. `students` is a STOCK like `cloud_scores` — the live
 * roster count, never written to usage_counters — which is why 'personal'
 * carrying 0 is exactly what gates that tier out of the student features.
 */
export type EntitlementLimits = Record<UsageMetric, number>;

/** 'managed' is a provisioned student: entitled by their teacher, billed to nobody. */
export type EntitlementSource = 'subscription' | 'studio_member' | 'managed' | 'none';

export interface Entitlements {
    user_id: string;
    tier: EffectiveTier;
    status: string | null;
    source: EntitlementSource;
    current_period_end: string | null;
    limits: EntitlementLimits;
}

export const UNLIMITED = -1;

/** Mirrors public.tier_limits(). Drift-guarded by tests/billing/limitsInSync.test.ts. */
export const TIER_LIMITS: Record<BillingTier, EntitlementLimits> = {
    free: { cloud_scores: 3, omr_runs: 3, vision_reads: 5, smart_imports: 2, pdf_exports: 1, students: 3 },
    personal: {
        cloud_scores: UNLIMITED,
        omr_runs: UNLIMITED,
        vision_reads: 500,
        smart_imports: UNLIMITED,
        pdf_exports: UNLIMITED,
        // The personal practice tool: paid limits, no roster.
        students: 0,
    },
    teacher: {
        cloud_scores: UNLIMITED,
        omr_runs: UNLIMITED,
        vision_reads: 500,
        smart_imports: UNLIMITED,
        pdf_exports: UNLIMITED,
        students: UNLIMITED,
    },
    academy: {
        cloud_scores: UNLIMITED,
        omr_runs: UNLIMITED,
        vision_reads: 500,
        smart_imports: UNLIMITED,
        pdf_exports: UNLIMITED,
        students: UNLIMITED,
    },
};

/**
 * Mirrors the 'student' branch of tier_limits(), and is drift-guarded with the
 * rest. Zero everywhere a student would be creating something of their own, and
 * unlimited exports: printing the piece your teacher assigned is the product
 * working, and a student has no plan to upgrade anyway.
 */
export const STUDENT_LIMITS: EntitlementLimits = {
    cloud_scores: 0,
    omr_runs: 0,
    vision_reads: 0,
    smart_imports: 0,
    pdf_exports: UNLIMITED,
    students: 0,
};

/** The ceilings for any effective tier, purchasable or not. */
export const limitsFor = (tier: EffectiveTier): EntitlementLimits =>
    tier === 'student' ? STUDENT_LIMITS : TIER_LIMITS[tier];

/**
 * Which counter each metered endpoint draws on. Both analyze-* endpoints are
 * two views of the same vision feature, so they share one budget.
 *
 * `students` is deliberately absent: it is a stock enforced where a seat is
 * provisioned, not a per-call budget any endpoint draws down.
 */
export const METRIC_BY_FUNCTION: Record<string, UsageMetric> = {
    'score-analyze': 'omr_runs',
    'analyze-annotations': 'vision_reads',
    'analyze-notes': 'vision_reads',
    'imslp-download': 'smart_imports',
};

/** Statuses that grant paid entitlements — must match get_entitlements(). */
export const isEntitlingStatus = (status: string | null): boolean => status === 'active' || status === 'trialing';

export const isUnlimited = (limit: number): boolean => limit < 0;

export const limitFor = (tier: EffectiveTier, metric: UsageMetric): number => limitsFor(tier)[metric];

/**
 * Paid tiers advertise "unlimited" vision reads but carry a generous fair-use
 * ceiling. Hitting it is an anomaly worth logging, not an upsell moment, so it
 * reports a different code and the UI points at support rather than at Checkout.
 *
 * Only the metered budgets reach here: `students` is a stock, refused where a
 * seat is provisioned, and never travels the quota path. A student's zeroes are
 * not a fair-use ceiling either — they are a feature they do not have.
 */
export const isFairUseCap = (tier: EffectiveTier, metric: UsageMetric): boolean =>
    tier !== 'free' && tier !== 'student' && !isUnlimited(limitFor(tier, metric));

/** First day of the metric's calendar month, matching date_trunc('month', now())::date. */
export const monthKeyOf = (date: Date): string => {
    const year = date.getUTCFullYear();
    const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
    return `${year}-${month}-01`;
};

export const LIMIT_REACHED_STATUS = 402;

export interface LimitReachedBody {
    code: 'limit_reached' | 'fair_use_cap';
    metric: UsageMetric;
    limit: number;
    /** EffectiveTier, not BillingTier: a student refused a metered call is told so. */
    tier: EffectiveTier;
}

export const limitReachedBody = (metric: UsageMetric, limit: number, tier: EffectiveTier): LimitReachedBody => ({
    code: isFairUseCap(tier, metric) ? 'fair_use_cap' : 'limit_reached',
    metric,
    limit,
    tier,
});

export const freeEntitlements = (userId: string): Entitlements => ({
    user_id: userId,
    tier: 'free',
    status: null,
    source: 'none',
    current_period_end: null,
    limits: TIER_LIMITS.free,
});

/**
 * The get_entitlements() short-circuit, in TypeScript: a user flagged
 * app_metadata.user_type = 'student' is entitled by their teacher's plan rather
 * than by one of their own, so there is no subscription or seat to resolve and
 * nothing to expire.
 */
export const studentEntitlements = (userId: string): Entitlements => ({
    user_id: userId,
    tier: 'student',
    status: null,
    source: 'managed',
    current_period_end: null,
    limits: STUDENT_LIMITS,
});

/**
 * A cached entitlement can outlive the period it was issued for — a teacher who
 * goes offline on the Teacher tier and comes back after renewal failed must not
 * keep Teacher limits in the UI. Enforcement is server-side regardless; this
 * only keeps the offline display honest.
 */
export const downgradeExpired = (entitlements: Entitlements, nowMs: number): Entitlements => {
    // A student holds no period to outlive, and dropping them to free would take
    // away the assigned scores they are meant to be practising from.
    if (entitlements.tier === 'free' || entitlements.tier === 'student') {
        return entitlements;
    }
    const end = entitlements.current_period_end;
    if (!end) {
        return entitlements;
    }
    const endMs = Date.parse(end);
    if (Number.isFinite(endMs) && endMs > nowMs) {
        return entitlements;
    }
    return { ...freeEntitlements(entitlements.user_id), status: entitlements.status };
};

/**
 * The metered gate, expressed over an injected backend so it can be driven by a
 * fake in tests — the same shape `SyncEngine` uses for its API. ./quota.ts
 * supplies the Postgres-backed implementation.
 */
export interface QuotaBackend {
    getEntitlements: (userId: string) => Promise<Entitlements | null>;
    /** Mirrors consume_quota(): null means the call itself failed. */
    consumeQuota: (
        userId: string,
        metric: UsageMetric,
        limit: number,
    ) => Promise<{ ok: boolean; count: number } | null>;
}

export type EnforceOutcome =
    | {
          ok: true;
          entitlements: Entitlements;
          count: number;
          /**
           * Whether a unit was actually taken. False on an unlimited metric,
           * which short-circuits before consume_quota — and which is why a caller
           * must consult this before refunding: release_quota would otherwise
           * decrement a counter this call never incremented, handing a teacher who
           * upgraded mid-month their whole spent free allowance back.
           */
          consumed: boolean;
      }
    | { ok: false; status: number; body: LimitReachedBody | { error: string } };

export const enforceQuota = async (
    backend: QuotaBackend,
    userId: string,
    metric: UsageMetric,
): Promise<EnforceOutcome> => {
    const entitlements = await backend.getEntitlements(userId);
    if (!entitlements) {
        // Fail closed: an unresolvable tier must not silently grant unlimited use.
        return { ok: false, status: 500, body: { error: 'Could not resolve entitlements' } };
    }

    const limit = entitlements.limits[metric];
    if (isUnlimited(limit)) {
        return { ok: true, entitlements, count: 0, consumed: false };
    }

    const consumed = await backend.consumeQuota(userId, metric, limit);
    if (!consumed) {
        return { ok: false, status: 500, body: { error: 'Could not record usage' } };
    }

    if (!consumed.ok) {
        if (isFairUseCap(entitlements.tier, metric)) {
            // A paying teacher hitting the fair-use ceiling is an anomaly worth
            // seeing in the logs, not a growth prompt.
            console.warn(
                `fair-use cap hit: user=${userId} metric=${metric} tier=${entitlements.tier} ` +
                    `count=${consumed.count} limit=${limit}`,
            );
        }
        return { ok: false, status: LIMIT_REACHED_STATUS, body: limitReachedBody(metric, limit, entitlements.tier) };
    }

    return { ok: true, entitlements, count: consumed.count, consumed: true };
};

export interface SubscriptionLike {
    user_id: string;
    tier: BillingTier;
    status: string;
    current_period_end: string | null;
}

export interface EntitlementInput {
    userId: string;
    /** The user's own subscription rows. */
    subscriptions: SubscriptionLike[];
    /** Owner ids of every studio the user holds a seat in. */
    studioOwnerIds: string[];
    /** Subscription rows belonging to those studio owners. */
    ownerSubscriptions: SubscriptionLike[];
}

const isLive = (sub: SubscriptionLike, nowMs: number): boolean => {
    if (!isEntitlingStatus(sub.status)) {
        return false;
    }
    if (sub.current_period_end === null) {
        return true;
    }
    const endMs = Date.parse(sub.current_period_end);
    return Number.isFinite(endMs) ? endMs > nowMs : false;
};

const TIER_RANK: Record<BillingTier, number> = { free: 0, personal: 1, teacher: 2, academy: 3 };

/**
 * Executable specification of get_entitlements(): own live subscription first
 * (highest tier wins), then a seat in a studio whose owner holds a live Academy
 * subscription (the studios tables keep their v1 names), then free. Founding
 * Teacher needs no branch — the webhook stores tier 'teacher' for that price, so
 * a founding subscription is a teacher subscription.
 */
export const resolveEntitlements = (input: EntitlementInput, nowMs: number): Entitlements => {
    const own = input.subscriptions
        .filter((sub) => sub.user_id === input.userId && isLive(sub, nowMs))
        .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0];

    if (own) {
        return {
            user_id: input.userId,
            tier: own.tier,
            status: own.status,
            source: 'subscription',
            current_period_end: own.current_period_end,
            limits: TIER_LIMITS[own.tier],
        };
    }

    const owners = new Set(input.studioOwnerIds);
    const seat = input.ownerSubscriptions.find(
        (sub) => owners.has(sub.user_id) && sub.tier === 'academy' && isLive(sub, nowMs),
    );

    if (seat) {
        return {
            user_id: input.userId,
            tier: 'academy',
            status: seat.status,
            source: 'studio_member',
            current_period_end: seat.current_period_end,
            limits: TIER_LIMITS.academy,
        };
    }

    return freeEntitlements(input.userId);
};
