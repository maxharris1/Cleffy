import { getSupabase } from '@/lib/supabase';
import { getDb } from '@/sync/db';
import type { BillingTier, Entitlements, EntitlementLimits, UsageMetric } from '@/types/database';

/**
 * Entitlements for the signed-in teacher.
 *
 * The server is the only authority: get_entitlements() resolves the tier
 * (including Academy seats, which a member cannot derive themselves — RLS hides
 * the owner's subscription row). Everything here is display state, cached in
 * Dexie so an offline start still shows the right plan.
 */

export const FREE_LIMITS: EntitlementLimits = {
    cloud_scores: 3,
    omr_runs: 3,
    vision_reads: 5,
    smart_imports: 2,
    pdf_exports: 1,
    students: 3,
};

export const freeEntitlements = (userId: string): Entitlements => ({
    user_id: userId,
    tier: 'free',
    status: null,
    source: 'none',
    current_period_end: null,
    limits: FREE_LIMITS,
});

/**
 * A cached entitlement can outlive the period it was issued for. A teacher who
 * goes offline on a paid plan and comes back after renewal failed must not
 * still see paid limits — the server would refuse the work anyway, and showing
 * the truth is kinder than a surprise mid-lesson.
 */
export const downgradeExpired = (entitlements: Entitlements, nowMs: number): Entitlements => {
    if (entitlements.tier === 'free' || !entitlements.current_period_end) {
        return entitlements;
    }
    const endMs = Date.parse(entitlements.current_period_end);
    if (Number.isFinite(endMs) && endMs > nowMs) {
        return entitlements;
    }
    return { ...freeEntitlements(entitlements.user_id), status: entitlements.status };
};

export const isPaidTier = (tier: BillingTier): boolean => tier !== 'free';

export const limitOf = (entitlements: Entitlements, metric: UsageMetric): number => entitlements.limits[metric];

export const isUnlimited = (limit: number): boolean => limit < 0;

/** Cached-only read, for a start with no network. */
export const readCachedEntitlements = async (userId: string): Promise<Entitlements | null> => {
    const row = await getDb().entitlements.get(userId);
    if (!row) {
        return null;
    }
    return downgradeExpired(row.entitlements, Date.now());
};

const cacheEntitlements = async (userId: string, entitlements: Entitlements): Promise<void> => {
    await getDb().entitlements.put({ userId, entitlements, cachedAt: new Date().toISOString() });
};

/**
 * Fetch from the server and refresh the cache. Falls back to the last known
 * value when offline, and to free only when nothing has ever been cached —
 * never upgrade someone on a network failure, never strand a payer either.
 */
export const loadEntitlements = async (userId: string): Promise<Entitlements> => {
    try {
        const { data, error } = await getSupabase().rpc('get_entitlements', {});
        if (error || !data) {
            throw new Error(error?.message ?? 'no entitlements returned');
        }
        const entitlements = { ...data, user_id: userId };
        await cacheEntitlements(userId, entitlements);
        return entitlements;
    } catch {
        const cached = await readCachedEntitlements(userId);
        return cached ?? freeEntitlements(userId);
    }
};

/** Drop the cache on sign-out so a shared device never leaks the previous plan. */
export const clearCachedEntitlements = async (userId: string): Promise<void> => {
    await getDb().entitlements.delete(userId);
};

/**
 * Current usage for the metered metrics this calendar month. The stocks
 * (`cloud_scores`, `students`) never appear here — they are counted live.
 */
export const loadUsage = async (): Promise<Partial<Record<UsageMetric, number>>> => {
    const month = new Date();
    const key = `${month.getUTCFullYear()}-${`${month.getUTCMonth() + 1}`.padStart(2, '0')}-01`;
    const { data, error } = await getSupabase().from('usage_counters').select('metric, count').eq('month', key);
    if (error || !data) {
        return {};
    }
    const usage: Partial<Record<UsageMetric, number>> = {};
    for (const row of data) {
        usage[row.metric] = row.count;
    }
    return usage;
};
