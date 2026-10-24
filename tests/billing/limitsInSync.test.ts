import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    STUDENT_LIMITS,
    TIER_LIMITS,
    UNLIMITED,
    type BillingTier,
    type EffectiveTier,
    type EntitlementLimits,
    type UsageMetric,
} from '../../supabase/functions/_shared/entitlements';
import { FREE_LIMITS } from '../../src/features/billing/entitlementsService';
import { limitAction } from '../../src/features/billing/limitErrors';
import { PAID_VISION_READS } from '../../src/features/billing/paidAllowances';

/**
 * Drift guard.
 *
 * The tier ceilings exist in three places by necessity: tier_limits() in SQL is
 * what is actually enforced, TIER_LIMITS in TypeScript is what the Edge
 * Functions and tests reason about, and FREE_LIMITS is the client's offline
 * fallback. Nothing stops them being edited apart, so this parses the migration
 * and proves they agree.
 */

/**
 * The migration that most recently defined tier_limits(), not a fixed filename.
 *
 * The function is redefined by create-or-replace whenever the ceilings move, so
 * the last definition in timestamp order is the one the database is actually
 * running. Pinning this to the original billing migration would have quietly
 * gone on asserting superseded numbers.
 *
 * Resolved from the project root: the jsdom test environment gives import.meta a
 * non-file URL, so fileURLToPath cannot be used here.
 */
const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

const latestTierLimitsMigration = (): string => {
    const defining = readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .filter((name) => /function\s+public\.tier_limits/i.test(readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8')));

    const latest = defining.at(-1);
    if (!latest) {
        throw new Error('no migration defines tier_limits()');
    }
    return readFileSync(resolve(MIGRATIONS_DIR, latest), 'utf8');
};

const TIERS: BillingTier[] = ['free', 'personal', 'teacher', 'academy'];
const PAID_TIERS = ['personal', 'teacher', 'academy'] as const;

/**
 * Every branch tier_limits() answers. 'student' is not purchasable and so is not
 * in TIER_LIMITS, but the SQL carries it and it drifts just as easily.
 */
const SQL_TIERS: EffectiveTier[] = [...TIERS, 'student'];

const LIMITS_BY_TIER: Record<EffectiveTier, EntitlementLimits> = { ...TIER_LIMITS, student: STUDENT_LIMITS };

const METRICS: UsageMetric[] = ['cloud_scores', 'omr_runs', 'vision_reads', 'smart_imports', 'pdf_exports', 'students'];

/** Pulls the jsonb_build_object(...) body for one tier out of tier_limits(). */
const limitsFromSql = (sql: string, tier: EffectiveTier): Record<string, number> => {
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
    const sql = latestTierLimitsMigration();

    it.each(SQL_TIERS)('%s matches tier_limits() in SQL', (tier) => {
        expect(limitsFromSql(sql, tier)).toEqual(LIMITS_BY_TIER[tier]);
    });

    it('covers every metric in every tier', () => {
        for (const tier of SQL_TIERS) {
            expect(Object.keys(LIMITS_BY_TIER[tier]).sort()).toEqual([...METRICS].sort());
        }
    });

    it('keeps TIER_LIMITS to the tiers someone can actually buy', () => {
        // The student ceilings live in STUDENT_LIMITS on purpose: a tier nobody
        // pays for must not be reachable from the table the pricing UI iterates.
        expect(Object.keys(TIER_LIMITS).sort()).toEqual([...TIERS].sort());
    });

    it('gives a provisioned student nothing to create and no export gate', () => {
        // Students are never billed and never gated: zero everywhere they would be
        // creating something of their own, unlimited on the one thing they do —
        // print the score their teacher assigned.
        expect(STUDENT_LIMITS.cloud_scores).toBe(0);
        expect(STUDENT_LIMITS.omr_runs).toBe(0);
        expect(STUDENT_LIMITS.vision_reads).toBe(0);
        expect(STUDENT_LIMITS.smart_imports).toBe(0);
        expect(STUDENT_LIMITS.students).toBe(0);
        expect(STUDENT_LIMITS.pdf_exports).toBe(UNLIMITED);
    });

    it('matches the client’s offline free-tier fallback', () => {
        expect(FREE_LIMITS).toEqual(TIER_LIMITS.free);
    });

    it('keeps the paid tiers at least as generous as free on every metered budget', () => {
        // `students` is the one deliberate exception, asserted on its own below:
        // Personal sits BELOW free there, because the roster is a Teacher feature
        // rather than a quantity Personal is given less of.
        const metered = METRICS.filter((metric) => metric !== 'students');
        expect(metered).toHaveLength(METRICS.length - 1);

        for (const metric of metered) {
            const free = TIER_LIMITS.free[metric];
            for (const tier of PAID_TIERS) {
                const paid = TIER_LIMITS[tier][metric];
                expect(paid < 0 || paid >= free).toBe(true);
            }
        }
    });

    it('starts the roster at Teacher, with Free and Personal carrying none', () => {
        // Spelled out so it cannot be "fixed" by mistake: Free is a taste of
        // Personal, the individual licence, not a miniature studio. A free
        // account that could run three students indefinitely never reaches the
        // tier the roster is sold on, so both sit at 0 and Teacher is the step up.
        expect(TIER_LIMITS.free.students).toBe(0);
        expect(TIER_LIMITS.personal.students).toBe(0);

        expect(TIER_LIMITS.teacher.students).toBe(UNLIMITED);
        expect(TIER_LIMITS.academy.students).toBe(UNLIMITED);
    });
});

describe('the pricing page describes the limits it actually enforces', () => {
    /** Play-along and fingering are switched off for this release (src/lib/features.ts). */
    const RELEASE = { playalong: false, fingering: false } as const;
    const ALL_ON = { playalong: true, fingering: true } as const;

    const cardCopy = async (tier: BillingTier, flags: { playalong: boolean; fingering: boolean } = RELEASE) => {
        const { tierCards } = await import('../../src/features/billing/pricing');
        const card = tierCards(flags).find((c) => c.tier === tier);
        return card?.features.join(' ') ?? '';
    };

    it('quotes the free-tier numbers on the free card', async () => {
        const copy = await cardCopy('free');

        expect(copy).toContain(`${TIER_LIMITS.free.cloud_scores} active cloud scores`);
        // smart_imports is what an IMSLP import spends; vision_reads is Import marks' AI pass.
        expect(copy).toContain(`${TIER_LIMITS.free.smart_imports} IMSLP imports a month`);
        expect(copy).toContain(`${TIER_LIMITS.free.vision_reads} AI page reads for Import marks a month`);
        expect(copy).toContain(`${TIER_LIMITS.free.pdf_exports} PDF export a month`);
        // Nothing on this card may advertise a roster it does not have, the same
        // rule the Personal card is held to below.
        expect(copy).not.toMatch(/student/i);
        expect(TIER_LIMITS.free.students).toBe(0);
        // Export left the unlimited line when it became a metered free allowance.
        expect(copy).toContain('Unlimited annotation');
        expect(copy).not.toMatch(/unlimited pdf/i);
    });

    it('sells nothing this release switches off, on any card', async () => {
        // omr_runs is still enforced in SQL (above) — it just must not be sold
        // while play-along is hidden, and neither may fingering.
        const { tierCards } = await import('../../src/features/billing/pricing');
        for (const card of tierCards(RELEASE)) {
            const copy = `${card.tagline} ${card.features.join(' ')}`;
            expect(copy).not.toMatch(/play-?along|fingering|playback|omr/i);
        }
    });

    it('quotes the play-along and fingering allowances in a build that ships them', async () => {
        const copy = await cardCopy('free', ALL_ON);

        expect(copy).toContain(`${TIER_LIMITS.free.omr_runs} play-along analyses a month`);
        expect(copy).toContain(`${TIER_LIMITS.free.vision_reads} AI page reads (Import marks and fingering) a month`);
        expect(copy).toContain('Unlimited annotation and fingering tools');
        expect(await cardCopy('personal', ALL_ON)).toContain('Unlimited play-along analysis');
        // Unlimited is only promised where every paid tier really is uncapped.
        for (const tier of PAID_TIERS) {
            expect(TIER_LIMITS[tier].omr_runs).toBe(UNLIMITED);
        }
    });

    it('promises Personal exactly the IMSLP imports and AI page reads it enforces', async () => {
        const copy = await cardCopy('personal');

        expect(copy).toContain('Unlimited IMSLP imports');
        expect(TIER_LIMITS.personal.smart_imports).toBe(UNLIMITED);
        // AI reads are a fair-use ceiling on paid plans, not unlimited.
        expect(copy).toContain(
            `${TIER_LIMITS.personal.vision_reads} AI page reads for Import marks a month (fair use)`,
        );
        expect(copy).not.toMatch(/unlimited ai/i);
        expect(TIER_LIMITS.personal.pdf_exports).toBe(UNLIMITED);
    });

    it('sells the cards this build is configured for', async () => {
        const { TIER_CARDS, tierCards } = await import('../../src/features/billing/pricing');
        const { features } = await import('../../src/lib/features');
        expect(TIER_CARDS).toEqual(tierCards(features));
    });

    it('promises no student features on the Personal card, whose roster limit is zero', async () => {
        const { TIER_CARDS } = await import('../../src/features/billing/pricing');
        const personal = TIER_CARDS.find((card) => card.tier === 'personal');

        expect(personal).toBeDefined();
        expect(personal?.tagline).toMatch(/practice/i);
        // Nothing on this card may advertise a roster it does not have.
        expect(personal?.features.join(' ')).not.toMatch(/student/i);
        expect(TIER_LIMITS.personal.students).toBe(0);
    });

    it('promises an unlimited roster on the Teacher card, which is what it sells', async () => {
        const { TIER_CARDS } = await import('../../src/features/billing/pricing');
        const teacher = TIER_CARDS.find((card) => card.tier === 'teacher');

        expect(teacher?.features.join(' ')).toContain('Unlimited students');
        expect(TIER_LIMITS.teacher.students).toBe(UNLIMITED);
    });
});

describe('the upgrade prompts promise only what the paid tiers enforce', () => {
    it('quotes the paid AI page-read allowance the SQL actually grants', () => {
        for (const tier of PAID_TIERS) {
            expect(TIER_LIMITS[tier].vision_reads).toBe(PAID_VISION_READS);
        }
    });

    it.each(METRICS)('never sells "unlimited" %s unless every paid tier is uncapped', (metric) => {
        const action = limitAction({ code: 'limit_reached', metric, limit: TIER_LIMITS.free[metric], tier: 'free' });
        const everyPaidTierUnlimited = PAID_TIERS.every((tier) => TIER_LIMITS[tier][metric] === UNLIMITED);
        if (!everyPaidTierUnlimited) {
            expect(action).not.toMatch(/unlimited/i);
        }
    });

    it('tells a free user the real paid AI page-read allowance', () => {
        const action = limitAction({ code: 'limit_reached', metric: 'vision_reads', limit: 5, tier: 'free' });
        expect(action).toContain(`${TIER_LIMITS.personal.vision_reads} AI page reads a month`);
    });

    it('does not call a capped paid plan unlimited when its fair-use ceiling is hit', () => {
        const action = limitAction({ code: 'fair_use_cap', metric: 'vision_reads', limit: 500, tier: 'personal' });
        expect(action).not.toMatch(/unlimited/i);
    });
});
