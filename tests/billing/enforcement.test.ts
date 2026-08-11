import { describe, expect, it } from 'vitest';

import { enforceQuota, TIER_LIMITS } from '../../supabase/functions/_shared/entitlements';
import { parsePostgrestLimitError } from '../../src/features/billing/limitErrors';
import { FakeBilling } from './fakeBilling';

/**
 * The integration test the brief asks for: a free teacher's 4th cloud score and
 * 4th play-along run are both refused with the typed error, while Pro sails
 * through.
 *
 * Real production code is under test on both paths — `enforceQuota` for the
 * metered endpoints and `parsePostgrestLimitError` for the database trigger.
 * Only the storage is faked (see fakeBilling.ts).
 */

const FREE_SCORES = TIER_LIMITS.free.cloud_scores;
const FREE_OMR = TIER_LIMITS.free.omr_runs;

describe('free tier limits', () => {
    it('refuses the 4th cloud score with the typed error, and does not lose the first three', async () => {
        const billing = new FakeBilling();

        for (let i = 0; i < FREE_SCORES; i += 1) {
            await expect(billing.insertScore('teacher', `score-${i}`)).resolves.toBeUndefined();
        }

        let raised: unknown;
        try {
            await billing.insertScore('teacher', 'score-4');
        } catch (err) {
            raised = err;
        }

        const limit = parsePostgrestLimitError(raised as { code: string; message: string; details: string });
        expect(limit).not.toBeNull();
        expect(limit?.code).toBe('limit_reached');
        expect(limit?.metric).toBe('cloud_scores');
        expect(limit?.limit).toBe(FREE_SCORES);
        expect(limit?.tier).toBe('free');

        expect(billing.activeScores.get('teacher')).toHaveLength(FREE_SCORES);
    });

    it('refuses the 4th play-along run with a 402 and the typed body', async () => {
        const billing = new FakeBilling();

        for (let i = 0; i < FREE_OMR; i += 1) {
            const allowed = await enforceQuota(billing, 'teacher', 'omr_runs');
            expect(allowed.ok).toBe(true);
        }

        const refused = await enforceQuota(billing, 'teacher', 'omr_runs');
        expect(refused.ok).toBe(false);
        if (refused.ok) {
            throw new Error('expected the run to be refused');
        }
        expect(refused.status).toBe(402);
        expect(refused.body).toEqual({
            code: 'limit_reached',
            metric: 'omr_runs',
            limit: FREE_OMR,
            tier: 'free',
        });
    });

    it('does not consume a unit on the refused call', async () => {
        const billing = new FakeBilling();
        for (let i = 0; i < FREE_OMR; i += 1) {
            await enforceQuota(billing, 'teacher', 'omr_runs');
        }
        await enforceQuota(billing, 'teacher', 'omr_runs');
        await enforceQuota(billing, 'teacher', 'omr_runs');
        expect(billing.countOf('teacher', 'omr_runs')).toBe(FREE_OMR);
    });

    it('meters both vision endpoints against one shared budget', async () => {
        const billing = new FakeBilling();
        const limit = TIER_LIMITS.free.vision_reads;

        // analyze-annotations and analyze-notes are two views of one feature.
        for (let i = 0; i < limit; i += 1) {
            expect((await enforceQuota(billing, 'teacher', 'vision_reads')).ok).toBe(true);
        }
        expect((await enforceQuota(billing, 'teacher', 'vision_reads')).ok).toBe(false);
    });

    it('keeps each metric on its own budget', async () => {
        const billing = new FakeBilling();
        for (let i = 0; i < FREE_OMR; i += 1) {
            await enforceQuota(billing, 'teacher', 'omr_runs');
        }
        expect((await enforceQuota(billing, 'teacher', 'omr_runs')).ok).toBe(false);
        expect((await enforceQuota(billing, 'teacher', 'smart_imports')).ok).toBe(true);
    });

    it('keeps each teacher on their own budget', async () => {
        const billing = new FakeBilling();
        for (let i = 0; i < FREE_OMR; i += 1) {
            await enforceQuota(billing, 'teacher-a', 'omr_runs');
        }
        expect((await enforceQuota(billing, 'teacher-a', 'omr_runs')).ok).toBe(false);
        expect((await enforceQuota(billing, 'teacher-b', 'omr_runs')).ok).toBe(true);
    });

    it('frees a slot when a score is archived rather than deleted', async () => {
        const billing = new FakeBilling();
        for (let i = 0; i < FREE_SCORES; i += 1) {
            await billing.insertScore('teacher', `score-${i}`);
        }
        billing.archiveScore('teacher', 'score-0');
        await expect(billing.insertScore('teacher', 'score-new')).resolves.toBeUndefined();
    });

    it('refunds a consumed unit when the work fails', async () => {
        const billing = new FakeBilling();
        await enforceQuota(billing, 'teacher', 'smart_imports');
        expect(billing.countOf('teacher', 'smart_imports')).toBe(1);

        billing.releaseQuota('teacher', 'smart_imports');
        expect(billing.countOf('teacher', 'smart_imports')).toBe(0);
        expect((await enforceQuota(billing, 'teacher', 'smart_imports')).ok).toBe(true);
    });
});

describe('paid tiers', () => {
    it('lets a Pro teacher past the free cloud-score cap', async () => {
        const billing = new FakeBilling();
        billing.subscribe('teacher', 'pro');

        for (let i = 0; i < FREE_SCORES + 5; i += 1) {
            await expect(billing.insertScore('teacher', `score-${i}`)).resolves.toBeUndefined();
        }
        expect(billing.activeScores.get('teacher')).toHaveLength(FREE_SCORES + 5);
    });

    it('lets a Pro teacher run play-alongs without limit, and without metering them', async () => {
        const billing = new FakeBilling();
        billing.subscribe('teacher', 'pro');

        for (let i = 0; i < FREE_OMR + 20; i += 1) {
            expect((await enforceQuota(billing, 'teacher', 'omr_runs')).ok).toBe(true);
        }
        // Unlimited metrics short-circuit before consume_quota, so nothing is counted.
        expect(billing.countOf('teacher', 'omr_runs')).toBe(0);
    });

    it('gives a Studio member the same treatment as the paying owner', async () => {
        const billing = new FakeBilling();
        billing.subscribe('owner', 'studio');
        billing.seatIn('member', 'owner');

        for (let i = 0; i < FREE_SCORES + 2; i += 1) {
            await expect(billing.insertScore('member', `score-${i}`)).resolves.toBeUndefined();
        }
        expect((await enforceQuota(billing, 'member', 'omr_runs')).ok).toBe(true);
    });

    it('still applies the silent fair-use ceiling to vision reads', async () => {
        const billing = new FakeBilling();
        billing.subscribe('teacher', 'pro');
        const cap = TIER_LIMITS.pro.vision_reads;

        for (let i = 0; i < cap; i += 1) {
            expect((await enforceQuota(billing, 'teacher', 'vision_reads')).ok).toBe(true);
        }

        const refused = await enforceQuota(billing, 'teacher', 'vision_reads');
        expect(refused.ok).toBe(false);
        if (refused.ok) {
            throw new Error('expected the fair-use ceiling to apply');
        }
        // A different code, so the UI points at support rather than at Checkout.
        expect(refused.body).toMatchObject({ code: 'fair_use_cap', tier: 'pro' });
    });

    it('drops a lapsed Pro teacher back to free limits', async () => {
        const billing = new FakeBilling();
        billing.subscribe('teacher', 'pro', { status: 'canceled' });

        for (let i = 0; i < FREE_OMR; i += 1) {
            expect((await enforceQuota(billing, 'teacher', 'omr_runs')).ok).toBe(true);
        }
        expect((await enforceQuota(billing, 'teacher', 'omr_runs')).ok).toBe(false);
    });
});

describe('failure modes', () => {
    it('fails closed when the tier cannot be resolved', async () => {
        const billing = new FakeBilling();
        const broken = { ...billing, getEntitlements: async () => null };

        const result = await enforceQuota(broken, 'teacher', 'omr_runs');
        expect(result.ok).toBe(false);
        if (result.ok) {
            throw new Error('expected a closed gate');
        }
        expect(result.status).toBe(500);
    });

    it('fails closed when usage cannot be recorded', async () => {
        const billing = new FakeBilling();
        const broken = { ...billing, consumeQuota: async () => null };

        const result = await enforceQuota(broken, 'teacher', 'omr_runs');
        expect(result.ok).toBe(false);
        if (result.ok) {
            throw new Error('expected a closed gate');
        }
        expect(result.status).toBe(500);
    });
});
