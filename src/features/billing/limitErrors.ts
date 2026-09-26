import { FREE_LIMITS } from '@/features/billing/entitlementsService';
import type { BillingTier, EffectiveTier, UsageMetric } from '@/types/database';

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
    limit: number;
    tier: BillingTier;
}

export class LimitReachedError extends Error {
    readonly code: LimitCode;
    readonly metric: UsageMetric;
    readonly limit: number;
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

const isBillingTier = (value: unknown): value is BillingTier =>
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
        limit: typeof record.limit === 'number' ? record.limit : 0,
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

/** Client-side stock-cap check: unarchived rows vs the plan's cloud-score limit. */
export const cloudScoreCapReached = (limit: number, documents: Array<{ archived_at: string | null }>): boolean => {
    if (limit < 0) {
        return false;
    }
    return documents.filter((row) => row.archived_at === null).length >= limit;
};

export const cloudScoresLimitError = (limit: number, tier: EffectiveTier): LimitReachedError =>
    new LimitReachedError({
        code: 'limit_reached',
        metric: 'cloud_scores',
        limit: limit < 0 ? 0 : limit,
        tier: tier === 'student' ? 'free' : tier,
    });

/**
 * Maps a stock-cap trigger's exception. The trigger raises P0001 with the
 * payload as JSON in DETAIL, which PostgREST surfaces as `details`.
 */
export const parsePostgrestLimitError = (
    error: {
        code?: string | null;
        message?: string | null;
        details?: string | null;
    } | null,
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
            // Fall through to the cloud-score default — DETAIL is best-effort.
        }
    }
    return cloudScoresLimitError(FREE_LIMITS.cloud_scores, 'free');
};

/**
 * Last-resort mapping when the refusal arrived as a plain Error ("Limit reached")
 * instead of the typed PostgREST/402 payload.
 */
export const parseLooseLimitError = (err: unknown): LimitReachedError | null => {
    if (isLimitReachedError(err)) {
        return err;
    }
    if (!err || typeof err !== 'object' || !('message' in err)) {
        return null;
    }
    const message = String((err as { message?: unknown }).message ?? '');
    if (looksLikeLimitReachedMessage(message) || /could not create document:\s*limit[_ ]reached/i.test(message)) {
        return cloudScoresLimitError(FREE_LIMITS.cloud_scores, 'free');
    }
    return null;
};

const METRIC_COPY: Record<UsageMetric, { spent: string; upgrade: string }> = {
    cloud_scores: {
        spent: 'You have reached your {limit} free cloud scores',
        upgrade: 'Upgrade for unlimited scores, or archive one to make room.',
    },
    omr_runs: {
        spent: 'You have used your {limit} free play-alongs this month',
        upgrade: 'Upgrade for unlimited play-along analysis.',
    },
    vision_reads: {
        spent: 'You have used your {limit} free fingering reads this month',
        upgrade: 'Upgrade for unlimited AI fingering reads.',
    },
    smart_imports: {
        spent: 'You have used your {limit} free smart imports this month',
        upgrade: 'Upgrade for unlimited smart imports.',
    },
    pdf_exports: {
        spent: 'You have used your {limit} free PDF export this month',
        upgrade: 'Upgrade for unlimited PDF exports.',
    },
    students: {
        // No plan carries a positive finite student cap any more — Teacher and
        // Academy are unlimited, everyone else is 0 — so the only way to reach
        // this is a plan with no roster at all. "Filled your 0 seats" was the
        // sentence that fell out of the old {limit} template.
        spent: 'Your plan doesn’t include a student roster',
        upgrade: 'Upgrade to Teacher to add students.',
    },
};

export const limitHeadline = (payload: LimitReachedPayload): string => {
    if (payload.code === 'fair_use_cap') {
        return 'You have hit this month’s fair-use ceiling';
    }
    return METRIC_COPY[payload.metric].spent.replace('{limit}', String(payload.limit));
};

export const limitAction = (payload: LimitReachedPayload): string => {
    if (payload.code === 'fair_use_cap') {
        return 'Your plan is unlimited in normal use — get in touch and we will lift it.';
    }
    return METRIC_COPY[payload.metric].upgrade;
};

const limitMessage = (payload: LimitReachedPayload): string => `${limitHeadline(payload)}. ${limitAction(payload)}`;
