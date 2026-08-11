import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import {
    isFairUseCap,
    isUnlimited,
    limitReachedBody,
    type Entitlements,
    type LimitReachedBody,
    type UsageMetric,
} from './entitlements.ts';

/**
 * The metered gate. Every expensive endpoint calls `enforce` BEFORE doing any
 * work, and nothing about the decision comes from the client.
 *
 * Both halves run in Postgres: get_entitlements() resolves the tier (including
 * Studio seats), and consume_quota() does the check and the increment in a
 * single statement whose ON CONFLICT ... WHERE re-evaluates the cap against the
 * locked row — so there is no check-then-write window between two concurrent
 * requests.
 */

export type EnforceResult =
    | { ok: true; entitlements: Entitlements; count: number }
    | { ok: false; status: number; body: LimitReachedBody | { error: string } };

export const loadEntitlements = async (admin: SupabaseClient, userId: string): Promise<Entitlements | null> => {
    const { data, error } = await admin.rpc('get_entitlements', { p_user: userId });
    if (error || !data) {
        return null;
    }
    return data as Entitlements;
};

export const enforce = async (
    admin: SupabaseClient,
    userId: string,
    metric: UsageMetric,
): Promise<EnforceResult> => {
    const entitlements = await loadEntitlements(admin, userId);
    if (!entitlements) {
        // Fail closed: an unresolvable tier must not silently grant unlimited use.
        return { ok: false, status: 500, body: { error: 'Could not resolve entitlements' } };
    }

    const limit = entitlements.limits[metric];
    if (isUnlimited(limit)) {
        return { ok: true, entitlements, count: 0 };
    }

    const { data, error } = await admin.rpc('consume_quota', {
        p_user: userId,
        p_metric: metric,
        p_limit: limit,
    });
    if (error || !data) {
        return { ok: false, status: 500, body: { error: 'Could not record usage' } };
    }

    const result = data as { ok: boolean; count: number; limit: number };
    if (!result.ok) {
        if (isFairUseCap(entitlements.tier, metric)) {
            // A paying teacher hitting the fair-use ceiling is an anomaly worth
            // seeing in the logs, not a growth prompt — the body carries
            // `fair_use_cap` so the UI points at support instead of Checkout.
            console.warn(
                `fair-use cap hit: user=${userId} metric=${metric} tier=${entitlements.tier} ` +
                    `count=${result.count} limit=${limit}`,
            );
        }
        return {
            ok: false,
            status: 402,
            body: limitReachedBody(metric, limit, entitlements.tier),
        };
    }

    return { ok: true, entitlements, count: result.count };
};

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
