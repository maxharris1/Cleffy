import { PAID_VISION_READS } from '@/features/billing/paidAllowances';
import type { BillingTier, EffectiveTier, Entitlements, UsageMetric } from '@/types/database';

/**
 * The one typed shape for "you have run out", however the server said it.
 *
 * There are two wire formats, because there are two enforcement points:
 *  - Edge Functions return HTTP 402 with a JSON body (metered analysis, imports).
 *  - The stock caps (cloud scores, student seats) are database triggers, so they
 *    arrive through PostgREST as an error with the payload in `details`.
 *
 * Both normalize to this. Client-side checks are UX only — the server has
 * already refused by the time any of this runs.
 */

export type LimitCode = 'limit_reached' | 'fair_use_cap';

export interface LimitReachedPayload {
    code: LimitCode;
    metric: UsageMetric;
    /**
     * The cap that was hit, or null when the refusal did not say and the caller
     * could not vouch for it either. Null is worded without a number rather than
     * guessed: telling a paying teacher they hit "3 free scores" is worse than
     * telling them they hit their plan's limit.
     */
    limit: number | null;
    tier: BillingTier;
}

export class LimitReachedError extends Error {
    readonly code: LimitCode;
    readonly metric: UsageMetric;
    readonly limit: number | null;
    readonly tier: BillingTier;

    constructor(payload: LimitReachedPayload) {
        super(limitMessage(payload));
        this.name = 'LimitReachedError';
        this.code = payload.code;
        this.metric = payload.metric;
        this.limit = payload.limit;
        this.tier = payload.tier;
    }
}

export const isLimitReachedError = (err: unknown): err is LimitReachedError => err instanceof LimitReachedError;

const KNOWN_METRICS: UsageMetric[] = [
    'cloud_scores',
    'omr_runs',
    'vision_reads',
    'smart_imports',
    'pdf_exports',
    'students',
];

export const isBillingTier = (value: unknown): value is BillingTier =>
    value === 'free' || value === 'personal' || value === 'teacher' || value === 'academy';

const asPayload = (value: unknown): LimitReachedPayload | null => {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const record = value as Record<string, unknown>;
    const code = record.code;
    if (code !== 'limit_reached' && code !== 'fair_use_cap') {
        return null;
    }
    const metric = record.metric;
    if (typeof metric !== 'string' || !KNOWN_METRICS.includes(metric as UsageMetric)) {
        return null;
    }
    const tier = record.tier;
    return {
        code,
        metric: metric as UsageMetric,
        limit: typeof record.limit === 'number' ? record.limit : null,
        tier: isBillingTier(tier) ? tier : 'free',
    };
};

/** Reads a 402 body from a raw fetch Response. Returns null if it is not one. */
export const parseLimitResponse = async (response: Response): Promise<LimitReachedError | null> => {
    if (response.status !== 402) {
        return null;
    }
    try {
        const payload = asPayload(await response.clone().json());
        return payload ? new LimitReachedError(payload) : null;
    } catch {
        return null;
    }
};

const looksLikeLimitReachedMessage = (message: string | null | undefined): boolean => {
    const text = message?.trim() ?? '';
    if (!text || /seat_limit_reached/i.test(text)) {
        return false;
    }
    return text === 'limit_reached' || /^limit reached$/i.test(text);
};

/** Client-side stock-cap check: unarchived *owned* rows vs the plan's cloud-score limit. */
export const cloudScoreCapReached = (
    limit: number,
    documents: Array<{ owner_id: string; archived_at: string | null }>,
    ownerId: string,
): boolean => {
    if (limit < 0) {
        return false;
    }
    return documents.filter((row) => row.archived_at === null && row.owner_id === ownerId).length >= limit;
};

export const cloudScoresLimitError = (limit: number, tier: EffectiveTier): LimitReachedError =>
    new LimitReachedError({
        code: 'limit_reached',
        metric: 'cloud_scores',
        limit: limit < 0 ? 0 : limit,
        tier: tier === 'student' ? 'free' : tier,
    });

/**
 * A cloud-score refusal that arrived without its payload. Only the caller's own
 * entitlements can put a number on it, and only when they name a finite,
 * positive cap -- the plan the server must have refused against. Anything else
 * (no entitlements, or a cached plan that says unlimited, which the refusal
 * itself just contradicted) gets the neutral wording rather than the free tier's
 * "3 free cloud scores", which would be a lie to anyone on a paid plan.
 */
const cloudScoresFallback = (entitlements: Entitlements | null | undefined): LimitReachedError => {
    const limit = entitlements?.limits.cloud_scores;
    if (entitlements && typeof limit === 'number' && limit > 0) {
        return cloudScoresLimitError(limit, entitlements.tier);
    }
    return new LimitReachedError({
        code: 'limit_reached',
        metric: 'cloud_scores',
        limit: null,
        tier: entitlements && entitlements.tier !== 'student' ? entitlements.tier : 'free',
    });
};

/**
 * Maps a stock-cap trigger's exception. The trigger raises P0001 with the
 * payload as JSON in DETAIL, which PostgREST surfaces as `details`.
 *
 * `entitlements` is the caller's last-known plan, used only when DETAIL is
 * missing or unreadable (see cloudScoresFallback).
 */
export const parsePostgrestLimitError = (
    error: {
        code?: string | null;
        message?: string | null;
        details?: string | null;
    } | null,
    entitlements?: Entitlements | null,
): LimitReachedError | null => {
    if (!error || !looksLikeLimitReachedMessage(error.message)) {
        return null;
    }
    if (error.details) {
        try {
            const payload = asPayload(JSON.parse(error.details));
            if (payload) {
                return new LimitReachedError(payload);
            }
        } catch {
            // Fall through to the cloud-score fallback — DETAIL is best-effort.
        }
    }
    return cloudScoresFallback(entitlements);
};

/**
 * Last-resort mapping when the refusal arrived as a plain Error ("Limit reached")
 * instead of the typed PostgREST/402 payload. Same `entitlements` fallback as
 * parsePostgrestLimitError.
 */
export const parseLooseLimitError = (err: unknown, entitlements?: Entitlements | null): LimitReachedError | null => {
    if (isLimitReachedError(err)) {
        return err;
    }
    if (!err || typeof err !== 'object' || !('message' in err)) {
        return null;
    }
    const message = String((err as { message?: unknown }).message ?? '');
    if (looksLikeLimitReachedMessage(message) || /could not create document:\s*limit[_ ]reached/i.test(message)) {
        return cloudScoresFallback(entitlements);
    }
    return null;
};

/**
 * `spent` carries the number; `spentUnknown` is the same sentence for a refusal
 * whose cap nobody could vouch for (limit: null), worded so it is true on any
 * plan.
 */
const METRIC_COPY: Record<UsageMetric, { spent: string; spentUnknown: string; upgrade: string }> = {
    cloud_scores: {
        spent: 'You have reached your {limit} free cloud scores',
        spentUnknown: 'You have reached your plan’s cloud-score limit',
        // Delete, not archive: the library offers no archive action, and the cap
        // (documents_enforce_score_cap) counts the owner's unarchived scores, so
        // deleting one is what makes room.
        upgrade: 'Upgrade for unlimited scores, or delete one to make room.',
    },
    omr_runs: {
        spent: 'You have used your {limit} free play-alongs this month',
        spentUnknown: 'You have used this month’s play-alongs',
        upgrade: 'Upgrade for unlimited play-along analysis.',
    },
    // Named for what spends them, not the internal metric: the AI pass of
    // Import marks (and fingering note reads, where that ships) draws on
    // vision_reads, and an IMSLP import on smart_imports. Paid plans carry a
    // fair-use ceiling on AI reads, so the upgrade quotes it — "unlimited"
    // here would be a promise the paid tier then breaks.
    vision_reads: {
        spent: 'You have used your {limit} free AI page reads this month',
        spentUnknown: 'You have used this month’s AI page reads',
        upgrade: `Upgrade for up to ${PAID_VISION_READS} AI page reads a month.`,
    },
    smart_imports: {
        spent: 'You have used your {limit} free IMSLP imports this month',
        spentUnknown: 'You have used this month’s IMSLP imports',
        upgrade: 'Upgrade for unlimited IMSLP imports.',
    },
    pdf_exports: {
        spent: 'You have used your {limit} free PDF export this month',
        spentUnknown: 'You have used this month’s PDF exports',
        upgrade: 'Upgrade for unlimited PDF exports.',
    },
    students: {
        // No plan carries a positive finite student cap any more — Teacher and
        // Academy are unlimited, everyone else is 0 — so the only way to reach
        // this is a plan with no roster at all. "Filled your 0 seats" was the
        // sentence that fell out of the old {limit} template.
        spent: 'Your plan doesn’t include a student roster',
        spentUnknown: 'Your plan doesn’t include a student roster',
        upgrade: 'Upgrade to Teacher to add students.',
    },
};

export const limitHeadline = (payload: LimitReachedPayload): string => {
    if (payload.code === 'fair_use_cap') {
        return 'You have hit this month’s fair-use ceiling';
    }
    const copy = METRIC_COPY[payload.metric];
    if (payload.limit === null) {
        return copy.spentUnknown;
    }
    return copy.spent.replace('{limit}', String(payload.limit));
};

export const limitAction = (payload: LimitReachedPayload): string => {
    if (payload.code === 'fair_use_cap') {
        // Only paid AI page reads carry a fair-use ceiling, and the pricing
        // card states the number — so this must not call the plan unlimited.
        return 'Your allowance resets at the start of next month — get in touch if you need more before then.';
    }
    return METRIC_COPY[payload.metric].upgrade;
};

const limitMessage = (payload: LimitReachedPayload): string => `${limitHeadline(payload)}. ${limitAction(payload)}`;
