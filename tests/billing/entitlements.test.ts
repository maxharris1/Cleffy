import { describe, expect, it } from 'vitest';

import {
    STUDENT_LIMITS,
    TIER_LIMITS,
    UNLIMITED,
    downgradeExpired,
    isFairUseCap,
    limitReachedBody,
    monthKeyOf,
    resolveEntitlements,
    studentEntitlements,
    type SubscriptionLike,
} from '../../supabase/functions/_shared/entitlements';
import { FakeBilling } from './fakeBilling';

const NOW = Date.parse('2026-08-11T12:00:00Z');

const sub = (overrides: Partial<SubscriptionLike> & { user_id: string }): SubscriptionLike => ({
    tier: 'teacher',
    status: 'active',
    current_period_end: '2026-09-11T12:00:00Z',
    ...overrides,
});

const resolve = (userId: string, subscriptions: SubscriptionLike[], studioOwnerIds: string[] = []) =>
    resolveEntitlements({ userId, subscriptions, studioOwnerIds, ownerSubscriptions: subscriptions }, NOW);

describe('entitlement resolution', () => {
    it('falls back to free with no subscription at all', () => {
        const result = resolve('teacher', []);
        expect(result.tier).toBe('free');
        expect(result.source).toBe('none');
        expect(result.limits).toEqual(TIER_LIMITS.free);
    });

    it('grants teacher from the teacher’s own live subscription', () => {
        const result = resolve('teacher', [sub({ user_id: 'teacher' })]);
        expect(result.tier).toBe('teacher');
        expect(result.source).toBe('subscription');
        expect(result.limits.cloud_scores).toBe(UNLIMITED);
        expect(result.limits.students).toBe(UNLIMITED);
    });

    it('grants personal to an individual, with the same paid ceilings but no roster', () => {
        // Personal and Teacher share every metered limit; students: 0 is the whole
        // difference, and it is what gates Personal out of the student features.
        const result = resolve('soloist', [sub({ user_id: 'soloist', tier: 'personal' })]);
        expect(result.tier).toBe('personal');
        expect(result.source).toBe('subscription');
        expect(result.limits.cloud_scores).toBe(UNLIMITED);
        expect(result.limits.smart_imports).toBe(UNLIMITED);
        expect(result.limits.students).toBe(0);
    });

    it('treats a Founding Teacher subscription as plain teacher', () => {
        // The webhook resolves the founding price to tier 'teacher', so there is no
        // founding branch to get wrong here — that is the point of the design.
        const founding = sub({ user_id: 'teacher', tier: 'teacher' });
        expect(resolve('teacher', [founding]).tier).toBe('teacher');
        expect(resolve('teacher', [founding]).limits).toEqual(TIER_LIMITS.teacher);
    });

    it('grants academy to a member through the owner’s subscription', () => {
        const result = resolve('member', [sub({ user_id: 'owner', tier: 'academy' })], ['owner']);
        expect(result.tier).toBe('academy');
        expect(result.source).toBe('studio_member');
    });

    it('does not grant academy from an owner who only has teacher', () => {
        const result = resolve('member', [sub({ user_id: 'owner', tier: 'teacher' })], ['owner']);
        expect(result.tier).toBe('free');
    });

    it('does not grant academy from an owner who only has personal', () => {
        const result = resolve('member', [sub({ user_id: 'owner', tier: 'personal' })], ['owner']);
        expect(result.tier).toBe('free');
    });

    it('does not grant academy to someone holding no seat', () => {
        const result = resolve('stranger', [sub({ user_id: 'owner', tier: 'academy' })], []);
        expect(result.tier).toBe('free');
    });

    it('prefers the teacher’s own subscription over an academy seat', () => {
        const result = resolve(
            'member',
            [sub({ user_id: 'member', tier: 'teacher' }), sub({ user_id: 'owner', tier: 'academy' })],
            ['owner'],
        );
        expect(result.source).toBe('subscription');
        expect(result.tier).toBe('teacher');
    });

    it('takes the highest tier when more than one subscription is live', () => {
        const result = resolve('teacher', [
            sub({ user_id: 'teacher', tier: 'personal' }),
            sub({ user_id: 'teacher', tier: 'academy' }),
        ]);
        expect(result.tier).toBe('academy');
    });

    describe('lapsed and expired subscriptions', () => {
        it('drops to free once the period end has passed', () => {
            const result = resolve('teacher', [
                sub({ user_id: 'teacher', current_period_end: '2026-08-01T00:00:00Z' }),
            ]);
            expect(result.tier).toBe('free');
        });

        it('drops to free on past_due even while the period is unexpired', () => {
            const result = resolve('teacher', [sub({ user_id: 'teacher', status: 'past_due' })]);
            expect(result.tier).toBe('free');
        });

        it('drops to free on canceled', () => {
            expect(resolve('teacher', [sub({ user_id: 'teacher', status: 'canceled' })]).tier).toBe('free');
        });

        it('honours trialing', () => {
            expect(resolve('teacher', [sub({ user_id: 'teacher', status: 'trialing' })]).tier).toBe('teacher');
        });

        it('honours a subscription with no period end', () => {
            expect(resolve('teacher', [sub({ user_id: 'teacher', current_period_end: null })]).tier).toBe('teacher');
        });

        it('revokes an academy seat when the owner’s subscription expires', () => {
            const result = resolve(
                'member',
                [sub({ user_id: 'owner', tier: 'academy', current_period_end: '2026-08-01T00:00:00Z' })],
                ['owner'],
            );
            expect(result.tier).toBe('free');
        });
    });

    describe('downgradeExpired (the offline cache path)', () => {
        it('keeps a cached tier that is still within its period', () => {
            const cached = resolve('teacher', [sub({ user_id: 'teacher' })]);
            expect(downgradeExpired(cached, NOW).tier).toBe('teacher');
        });

        it('degrades a cached tier whose period ended while offline', () => {
            const cached = resolve('teacher', [sub({ user_id: 'teacher' })]);
            const later = Date.parse('2026-10-01T00:00:00Z');
            expect(downgradeExpired(cached, later).tier).toBe('free');
            expect(downgradeExpired(cached, later).limits).toEqual(TIER_LIMITS.free);
        });

        it('degrades a cached personal tier the same way', () => {
            const cached = resolve('soloist', [sub({ user_id: 'soloist', tier: 'personal' })]);
            expect(downgradeExpired(cached, Date.parse('2026-10-01T00:00:00Z')).tier).toBe('free');
        });

        it('leaves free alone', () => {
            const cached = resolve('teacher', []);
            expect(downgradeExpired(cached, Date.parse('2030-01-01T00:00:00Z')).tier).toBe('free');
        });

        it('leaves a provisioned student alone forever', () => {
            // A student has no period to outlive, and degrading them to free would
            // take away the scores their teacher assigned — mid-lesson, offline.
            const student = studentEntitlements('student-1');
            expect(downgradeExpired(student, Date.parse('2099-01-01T00:00:00Z'))).toEqual(student);
        });
    });
});

describe('provisioned students', () => {
    it('are entitled by their teacher, not by a plan of their own', () => {
        expect(studentEntitlements('student-1')).toEqual({
            user_id: 'student-1',
            tier: 'student',
            status: null,
            source: 'managed',
            current_period_end: null,
            limits: STUDENT_LIMITS,
        });
    });

    it('are never a fair-use anomaly — their zeroes are a feature they lack', () => {
        expect(isFairUseCap('student', 'vision_reads')).toBe(false);
        expect(isFairUseCap('student', 'omr_runs')).toBe(false);
    });
});

describe('the limits table', () => {
    it('gives free a small allowance of everything it has, and no roster', () => {
        // Free is a taste of Personal, the individual licence: the whole practice
        // tool in small amounts, with the roster starting at Teacher.
        expect(TIER_LIMITS.free).toEqual({
            cloud_scores: 3,
            omr_runs: 3,
            vision_reads: 5,
            smart_imports: 2,
            pdf_exports: 1,
            students: 0,
        });
    });

    it('gives personal every paid ceiling but no roster at all', () => {
        expect(TIER_LIMITS.personal).toEqual({
            cloud_scores: UNLIMITED,
            omr_runs: UNLIMITED,
            vision_reads: 500,
            smart_imports: UNLIMITED,
            pdf_exports: UNLIMITED,
            students: 0,
        });
        // Said plainly, because this single 0 is the "no student features" gate.
        expect(TIER_LIMITS.personal.students).toBe(0);
    });

    it('gives teacher and academy an unlimited roster', () => {
        expect(TIER_LIMITS.teacher.students).toBe(UNLIMITED);
        expect(TIER_LIMITS.academy.students).toBe(UNLIMITED);
        expect(TIER_LIMITS.teacher).toEqual(TIER_LIMITS.academy);
    });

    it('keeps vision reads finite on every paid tier — the fair-use ceiling', () => {
        for (const tier of ['personal', 'teacher', 'academy'] as const) {
            expect(TIER_LIMITS[tier].vision_reads).toBe(500);
        }
    });
});

describe('usage counter months', () => {
    it('keys on the first of the calendar month, in UTC', () => {
        expect(monthKeyOf(new Date('2026-08-11T12:00:00Z'))).toBe('2026-08-01');
        expect(monthKeyOf(new Date('2026-08-01T00:00:00Z'))).toBe('2026-08-01');
        expect(monthKeyOf(new Date('2026-08-31T23:59:59Z'))).toBe('2026-08-01');
    });

    it('zero-pads single-digit months', () => {
        expect(monthKeyOf(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-01');
    });

    it('starts a fresh allowance when the month rolls over', async () => {
        const billing = new FakeBilling({ now: new Date('2026-08-31T23:00:00Z') });
        const limit = TIER_LIMITS.free.omr_runs;

        for (let i = 0; i < limit; i += 1) {
            expect((await billing.consumeQuota('teacher', 'omr_runs', limit))?.ok).toBe(true);
        }
        expect((await billing.consumeQuota('teacher', 'omr_runs', limit))?.ok).toBe(false);

        billing.now = new Date('2026-09-01T00:30:00Z');
        const first = await billing.consumeQuota('teacher', 'omr_runs', limit);
        expect(first?.ok).toBe(true);
        expect(first?.count).toBe(1);

        // Last month's tally is untouched, not reset — a new month is a new key.
        billing.now = new Date('2026-08-31T23:00:00Z');
        expect(billing.countOf('teacher', 'omr_runs')).toBe(limit);
    });
});

describe('fair-use ceiling', () => {
    it('applies only to paid tiers with a finite limit', () => {
        expect(isFairUseCap('personal', 'vision_reads')).toBe(true);
        expect(isFairUseCap('teacher', 'vision_reads')).toBe(true);
        expect(isFairUseCap('academy', 'vision_reads')).toBe(true);
        expect(isFairUseCap('teacher', 'omr_runs')).toBe(false);
        expect(isFairUseCap('free', 'vision_reads')).toBe(false);
    });

    it('reports a different code so the UI can avoid an upsell', () => {
        expect(limitReachedBody('vision_reads', 5, 'free').code).toBe('limit_reached');
        expect(limitReachedBody('vision_reads', 500, 'teacher').code).toBe('fair_use_cap');
        expect(limitReachedBody('vision_reads', 500, 'personal').code).toBe('fair_use_cap');
    });
});
