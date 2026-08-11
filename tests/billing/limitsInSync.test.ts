import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TIER_LIMITS, type BillingTier, type UsageMetric } from '../../supabase/functions/_shared/entitlements';
import { FREE_LIMITS } from '../../src/features/billing/entitlementsService';

/**
 * Drift guard.
 *
 * The tier ceilings exist in three places by necessity: tier_limits() in SQL is
 * what is actually enforced, TIER_LIMITS in TypeScript is what the Edge
 * Functions and tests reason about, and FREE_LIMITS is the client's offline
 * fallback. Nothing stops them being edited apart, so this parses the migration
 * and proves they agree.
 */

// Resolved from the project root: the jsdom test environment gives import.meta
// a non-file URL, so fileURLToPath cannot be used here.
const MIGRATION = resolve(process.cwd(), 'supabase/migrations/20260811120000_billing.sql');

const METRICS: UsageMetric[] = ['cloud_scores', 'omr_runs', 'vision_reads', 'smart_imports'];

/** Pulls the jsonb_build_object(...) body for one tier out of tier_limits(). */
const limitsFromSql = (sql: string, tier: BillingTier): Record<string, number> => {
    const branch =
        tier === 'free'
            ? /else\s+jsonb_build_object\(([\s\S]*?)\)\s*end/i
            : new RegExp(`when\\s+'${tier}'\\s+then\\s+jsonb_build_object\\(([\\s\\S]*?)\\)`, 'i');

    const match = sql.match(branch);
    if (!match?.[1]) {
        throw new Error(`could not find the ${tier} branch of tier_limits() in the migration`);
    }

    const limits: Record<string, number> = {};
    for (const pair of match[1].matchAll(/'(\w+)'\s*,\s*(-?\d+)/g)) {
        const key = pair[1];
        const value = pair[2];
        if (key && value) {
            limits[key] = Number.parseInt(value, 10);
        }
    }
    return limits;
};

describe('tier limits stay in sync with the migration', () => {
    const sql = readFileSync(MIGRATION, 'utf8');

    it.each(['free', 'pro', 'studio'] as const)('%s matches tier_limits() in SQL', (tier) => {
        expect(limitsFromSql(sql, tier)).toEqual(TIER_LIMITS[tier]);
    });

    it('covers every metric in every tier', () => {
        for (const tier of ['free', 'pro', 'studio'] as const) {
            expect(Object.keys(TIER_LIMITS[tier]).sort()).toEqual([...METRICS].sort());
        }
    });

    it('matches the client’s offline free-tier fallback', () => {
        expect(FREE_LIMITS).toEqual(TIER_LIMITS.free);
    });

    it('keeps the paid tiers at least as generous as free', () => {
        for (const metric of METRICS) {
            const free = TIER_LIMITS.free[metric];
            for (const tier of ['pro', 'studio'] as const) {
                const paid = TIER_LIMITS[tier][metric];
                expect(paid < 0 || paid >= free).toBe(true);
            }
        }
    });
});

describe('the pricing page describes the limits it actually enforces', () => {
    it('quotes the free-tier numbers on the free card', async () => {
        const { TIER_CARDS } = await import('../../src/features/billing/pricing');
        const free = TIER_CARDS.find((card) => card.tier === 'free');
        const copy = free?.features.join(' ') ?? '';

        expect(copy).toContain(`${TIER_LIMITS.free.cloud_scores} active cloud scores`);
        expect(copy).toContain(`${TIER_LIMITS.free.omr_runs} play-along`);
        expect(copy).toContain(`${TIER_LIMITS.free.smart_imports} smart import`);
        expect(copy).toContain(`${TIER_LIMITS.free.vision_reads} AI fingering reads`);
    });
});
