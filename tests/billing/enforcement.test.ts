import { describe, expect, it } from 'vitest';

import {
    METRIC_BY_FUNCTION,
    STUDENT_LIMITS,
    TIER_LIMITS,
    UNLIMITED,
    enforceQuota,
    studentEntitlements,
    type UsageMetric,
} from '../../supabase/functions/_shared/entitlements';
import { parsePostgrestLimitError } from '../../src/features/billing/limitErrors';
import { FakeBilling } from './fakeBilling';

/**
 * The integration test the brief asks for: a free teacher's 4th cloud score and
 * 4th play-along run are both refused with the typed error, while a paid tier
 * sails through.
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
        const gate = await enforceQuota(billing, 'teacher', 'smart_imports');
        // What the caller refunds on: a metered gate really did take a unit.
        expect(gate).toMatchObject({ ok: true, consumed: true, count: 1 });
        expect(billing.countOf('teacher', 'smart_imports')).toBe(1);

        billing.releaseQuota('teacher', 'smart_imports');
        expect(billing.countOf('teacher', 'smart_imports')).toBe(0);
        expect((await enforceQuota(billing, 'teacher', 'smart_imports')).ok).toBe(true);
    });
});

describe('paid tiers', () => {
    it('lets a Teacher past the free cloud-score cap', async () => {
        const billing = new FakeBilling();
        billing.subscribe('teacher', 'teacher');

        for (let i = 0; i < FREE_SCORES + 5; i += 1) {
            await expect(billing.insertScore('teacher', `score-${i}`)).resolves.toBeUndefined();
        }
        expect(billing.activeScores.get('teacher')).toHaveLength(FREE_SCORES + 5);
    });

    it('lets a Teacher run play-alongs without limit, and without metering them', async () => {
        const billing = new FakeBilling();
        billing.subscribe('teacher', 'teacher');

        for (let i = 0; i < FREE_OMR + 20; i += 1) {
            expect((await enforceQuota(billing, 'teacher', 'omr_runs')).ok).toBe(true);
        }
        // Unlimited metrics short-circuit before consume_quota, so nothing is counted.
        expect(billing.countOf('teacher', 'omr_runs')).toBe(0);
    });

    it('has nothing to refund on an unlimited metric, even with a counter left from the free days', async () => {
        // The mid-month upgrade: a teacher spends both free smart imports, then
        // buys Teacher. The counter row survives the month, but the gate now
        // short-circuits on the unlimited limit without touching it — so a failure
        // path that refunded unconditionally would give that spent allowance back,
        // and give it back again on every later failed import.
        const billing = new FakeBilling();
        const FREE_IMPORTS = TIER_LIMITS.free.smart_imports;
        for (let i = 0; i < FREE_IMPORTS; i += 1) {
            await enforceQuota(billing, 'teacher', 'smart_imports');
        }
        expect(billing.countOf('teacher', 'smart_imports')).toBe(FREE_IMPORTS);

        billing.subscribe('teacher', 'teacher');
        const gate = await enforceQuota(billing, 'teacher', 'smart_imports');
        expect(gate).toMatchObject({ ok: true, consumed: false });

        // Exactly what imslp-download's failure paths do with it.
        if (gate.ok && gate.consumed) {
            billing.releaseQuota('teacher', 'smart_imports');
        }
        expect(billing.countOf('teacher', 'smart_imports')).toBe(FREE_IMPORTS);
    });

    it('gives a Personal subscriber the same unlimited scores and runs', async () => {
        // Personal is only cheaper in what it unlocks (no roster), never in the
        // ceilings a solo player actually meets while working.
        const billing = new FakeBilling();
        billing.subscribe('soloist', 'personal');

        for (let i = 0; i < FREE_SCORES + 5; i += 1) {
            await expect(billing.insertScore('soloist', `score-${i}`)).resolves.toBeUndefined();
        }
        for (let i = 0; i < FREE_OMR + 5; i += 1) {
            expect((await enforceQuota(billing, 'soloist', 'omr_runs')).ok).toBe(true);
        }
        expect((await enforceQuota(billing, 'soloist', 'smart_imports')).ok).toBe(true);
        expect(billing.countOf('soloist', 'omr_runs')).toBe(0);
    });

    it('gives an Academy member the same treatment as the paying owner', async () => {
        const billing = new FakeBilling();
        billing.subscribe('owner', 'academy');
        billing.seatIn('member', 'owner');

        for (let i = 0; i < FREE_SCORES + 2; i += 1) {
            await expect(billing.insertScore('member', `score-${i}`)).resolves.toBeUndefined();
        }
        expect((await enforceQuota(billing, 'member', 'omr_runs')).ok).toBe(true);
    });

    it('still applies the silent fair-use ceiling to vision reads', async () => {
        const billing = new FakeBilling();
        billing.subscribe('teacher', 'teacher');
        const cap = TIER_LIMITS.teacher.vision_reads;

        for (let i = 0; i < cap; i += 1) {
            expect((await enforceQuota(billing, 'teacher', 'vision_reads')).ok).toBe(true);
        }

        const refused = await enforceQuota(billing, 'teacher', 'vision_reads');
        expect(refused.ok).toBe(false);
        if (refused.ok) {
            throw new Error('expected the fair-use ceiling to apply');
        }
        // A different code, so the UI points at support rather than at Checkout.
        expect(refused.body).toMatchObject({ code: 'fair_use_cap', tier: 'teacher' });
    });

    it('drops a lapsed Teacher back to free limits', async () => {
        const billing = new FakeBilling();
        billing.subscribe('teacher', 'teacher', { status: 'canceled' });

        for (let i = 0; i < FREE_OMR; i += 1) {
            expect((await enforceQuota(billing, 'teacher', 'omr_runs')).ok).toBe(true);
        }
        expect((await enforceQuota(billing, 'teacher', 'omr_runs')).ok).toBe(false);
    });
});

describe('the student roster is a stock, not a metered flow', () => {
    it('is drawn on by no metered endpoint, so no usage counter ever moves for it', async () => {
        const billing = new FakeBilling();

        // The roster is enforced where a seat row is written, exactly like the
        // cloud-score cap. No Edge Function meters it, so nothing can quietly bill
        // a teacher a "student" unit for adding a pupil.
        expect(Object.values(METRIC_BY_FUNCTION)).not.toContain('students');

        for (const metric of Object.values(METRIC_BY_FUNCTION)) {
            expect((await enforceQuota(billing, 'teacher', metric)).ok).toBe(true);
            expect(billing.countOf('teacher', metric)).toBeGreaterThan(0);
        }
        expect(billing.countOf('teacher', 'students')).toBe(0);
    });

    it('gates the roster by tier instead: Personal gets none, Teacher and Academy no ceiling', () => {
        // The limits table those seats are checked against. The stock itself —
        // provisioning, archiving, the restore that must re-claim its seat — is
        // driven against FakeBilling in tests/billing/roster.test.ts.
        expect(TIER_LIMITS.personal.students).toBe(0);
        expect(TIER_LIMITS.teacher.students).toBe(-1);
        expect(TIER_LIMITS.academy.students).toBe(-1);
        expect(TIER_LIMITS.free.students).toBe(3);
    });
});

describe('student accounts', () => {
    /**
     * A provisioned student, as get_entitlements() answers for one: the backend
     * short-circuits to tier 'student' on app_metadata.user_type, so there is no
     * subscription or seat to resolve. Only getEntitlements is swapped — the
     * counters underneath stay the real fake's, which is what lets the "never
     * incremented" assertions below mean anything.
     */
    const studentBackend = (billing: FakeBilling, userId: string) => ({
        ...billing,
        getEntitlements: async () => studentEntitlements(userId),
    });

    /** Everything a student would be creating something of their own with. */
    const CREATION_METRICS: UsageMetric[] = ['omr_runs', 'vision_reads', 'smart_imports'];

    it('carry zero creation limits and an unlimited export', () => {
        for (const metric of CREATION_METRICS) {
            expect(STUDENT_LIMITS[metric]).toBe(0);
        }
        // cloud_scores is zero for the same reason, though the refusal that
        // matters there is the documents_insert policy in the roster migration,
        // which keeps a student off the table entirely rather than at 0 rows.
        expect(STUDENT_LIMITS.cloud_scores).toBe(0);
        expect(STUDENT_LIMITS.students).toBe(0);

        // The one thing they do: print the piece their teacher assigned. A
        // student has no plan to upgrade to, so a gate here would just be a wall.
        expect(STUDENT_LIMITS.pdf_exports).toBe(UNLIMITED);
    });

    it('are refused every metered call with limit 0, and never consume one', async () => {
        const billing = new FakeBilling();
        const student = studentBackend(billing, 'student-1');

        for (const metric of CREATION_METRICS) {
            const refused = await enforceQuota(student, 'student-1', metric);
            expect(refused.ok).toBe(false);
            if (refused.ok) {
                throw new Error(`expected ${metric} to be refused for a student`);
            }
            expect(refused.status).toBe(402);
            expect(refused.body).toEqual({ code: 'limit_reached', metric, limit: 0, tier: 'student' });
        }

        // A refusal at zero must not leave a counter behind: a student is not
        // spending anyone's allowance, so there is nothing to have spent.
        for (const metric of CREATION_METRICS) {
            expect(billing.countOf('student-1', metric)).toBe(0);
        }
    });

    it('are told limit_reached rather than fair_use_cap — their zeroes are a feature they lack', async () => {
        const billing = new FakeBilling();
        const refused = await enforceQuota(studentBackend(billing, 'student-1'), 'student-1', 'vision_reads');

        expect(refused.ok).toBe(false);
        if (refused.ok) {
            throw new Error('expected the vision read to be refused');
        }
        // fair_use_cap would send them to support to have a ceiling lifted that
        // is not a ceiling; limit_reached is the honest answer for a feature the
        // account does not have at all.
        expect(refused.body).toMatchObject({ code: 'limit_reached' });
    });

    it('export PDFs without a gate, and without metering them', async () => {
        const billing = new FakeBilling();
        const student = studentBackend(billing, 'student-1');

        for (let i = 0; i < TIER_LIMITS.free.pdf_exports + 5; i += 1) {
            const allowed = await enforceQuota(student, 'student-1', 'pdf_exports');
            expect(allowed.ok).toBe(true);
            if (!allowed.ok) {
                throw new Error('expected the export to be allowed');
            }
            expect(allowed.entitlements.tier).toBe('student');
        }

        // Unlimited short-circuits ahead of consume_quota, so nothing is counted.
        expect(billing.countOf('student-1', 'pdf_exports')).toBe(0);
    });

    it('are never billed for the seat they occupy', async () => {
        // The teacher's roster is the stock that pays for them, and it is checked
        // where the seat is claimed. Nothing a student does draws on a budget.
        const billing = new FakeBilling();
        const student = studentBackend(billing, 'student-1');

        await enforceQuota(student, 'student-1', 'omr_runs');
        expect(billing.countOf('student-1', 'students')).toBe(0);
        expect(billing.activeStudents('student-1')).toHaveLength(0);
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
