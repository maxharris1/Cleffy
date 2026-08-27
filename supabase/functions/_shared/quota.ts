import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
    enforceQuota,
    type Entitlements,
    type EnforceOutcome,
    type QuotaBackend,
    type UsageMetric,
} from './entitlements.ts';

/**
 * Postgres-backed implementation of the metered gate.
 *
 * Both halves of the decision run in the database: get_entitlements() resolves
 * the tier (including Studio seats), and consume_quota() does the check and the
 * increment in a single statement whose ON CONFLICT ... WHERE re-evaluates the
 * cap against the locked row — so there is no check-then-write window between
 * two concurrent requests.
 *
 * The decision logic itself lives in ./entitlements.ts behind QuotaBackend, so
 * it is exercised by tests/billing/enforcement.test.ts rather than only in
 * production.
 */

export const supabaseQuotaBackend = (admin: SupabaseClient): QuotaBackend => ({
    getEntitlements: async (userId) => {
        const { data, error } = await admin.rpc('get_entitlements', { p_user: userId });
        if (error || !data) {
            return null;
        }
        return data as Entitlements;
    },
    consumeQuota: async (userId, metric, limit) => {
        const { data, error } = await admin.rpc('consume_quota', {
            p_user: userId,
            p_metric: metric,
            p_limit: limit,
        });
        if (error || !data) {
            return null;
        }
        const result = data as { ok: boolean; count: number };
        return { ok: result.ok, count: result.count };
    },
});

export const enforce = (admin: SupabaseClient, userId: string, metric: UsageMetric): Promise<EnforceOutcome> =>
    enforceQuota(supabaseQuotaBackend(admin), userId, metric);

/**
 * Give a consumed unit back when the work it paid for failed. Callers should use
 * this on any error path after `enforce` succeeded, so a crashed analysis never
 * costs a teacher a credit.
 */
export const refund = async (admin: SupabaseClient, userId: string, metric: UsageMetric): Promise<void> => {
    const { error } = await admin.rpc('release_quota', { p_user: userId, p_metric: metric });
    if (error) {
        console.error(`could not refund ${metric} for ${userId}: ${error.message}`);
    }
};
