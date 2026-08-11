import { describe, expect, it } from 'vitest';

import {
    TIER_LIMITS,
    downgradeExpired,
    isFairUseCap,
    limitReachedBody,
    monthKeyOf,
    resolveEntitlements,
    type SubscriptionLike,
} from '../../supabase/functions/_shared/entitlements';
import { FakeBilling } from './fakeBilling';

const NOW = Date.parse('2026-08-11T12:00:00Z');

const sub = (overrides: Partial<SubscriptionLike> & { user_id: string }): SubscriptionLike => ({
    tier: 'pro',
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

    it('grants pro from the teacher’s own live subscription', () => {
        const result = resolve('teacher', [sub({ user_id: 'teacher' })]);
        expect(result.tier).toBe('pro');
        expect(result.source).toBe('subscription');
        expect(result.limits.cloud_scores).toBe(-1);
    });

    it('treats a Founding Teacher subscription as plain pro', () => {
        // The webhook resolves the founding price to tier 'pro', so there is no
        // founding branch to get wrong here — that is the point of the design.
        const founding = sub({ user_id: 'teacher', tier: 'pro' });
        expect(resolve('teacher', [founding]).tier).toBe('pro');
        expect(resolve('teacher', [founding]).limits).toEqual(TIER_LIMITS.pro);
    });

    it('grants studio to a member through the owner’s subscription', () => {
        const result = resolve('member', [sub({ user_id: 'owner', tier: 'studio' })], ['owner']);
        expect(result.tier).toBe('studio');
        expect(result.source).toBe('studio_member');
    });

    it('does not grant studio from an owner who only has pro', () => {
        const result = resolve('member', [sub({ user_id: 'owner', tier: 'pro' })], ['owner']);
        expect(result.tier).toBe('free');
    });

    it('does not grant studio to someone holding no seat', () => {
        const result = resolve('stranger', [sub({ user_id: 'owner', tier: 'studio' })], []);
        expect(result.tier).toBe('free');
    });

    it('prefers the teacher’s own subscription over a studio seat', () => {
        const result = resolve(
            'member',
            [sub({ user_id: 'member', tier: 'pro' }), sub({ user_id: 'owner', tier: 'studio' })],
            ['owner'],
        );
        expect(result.source).toBe('subscription');
        expect(result.tier).toBe('pro');
    });

    it('takes the highest tier when more than one subscription is live', () => {
        const result = resolve('teacher', [
            sub({ user_id: 'teacher', tier: 'pro' }),
            sub({ user_id: 'teacher', tier: 'studio' }),
        ]);
        expect(result.tier).toBe('studio');
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
            expect(resolve('teacher', [sub({ user_id: 'teacher', status: 'trialing' })]).tier).toBe('pro');
        });

        it('honours a subscription with no period end', () => {
            expect(resolve('teacher', [sub({ user_id: 'teacher', current_period_end: null })]).tier).toBe('pro');
        });

        it('revokes a studio seat when the owner’s subscription expires', () => {
            const result = resolve(
                'member',
                [sub({ user_id: 'owner', tier: 'studio', current_period_end: '2026-08-01T00:00:00Z' })],
                ['owner'],
            );
            expect(result.tier).toBe('free');
        });
    });

    describe('downgradeExpired (the offline cache path)', () => {
        it('keeps a cached tier that is still within its period', () => {
            const cached = resolve('teacher', [sub({ user_id: 'teacher' })]);
            expect(downgradeExpired(cached, NOW).tier).toBe('pro');
        });

        it('degrades a cached tier whose period ended while offline', () => {
            const cached = resolve('teacher', [sub({ user_id: 'teacher' })]);
            const later = Date.parse('2026-10-01T00:00:00Z');
            expect(downgradeExpired(cached, later).tier).toBe('free');
            expect(downgradeExpired(cached, later).limits).toEqual(TIER_LIMITS.free);
        });

        it('leaves free alone', () => {
            const cached = resolve('teacher', []);
            expect(downgradeExpired(cached, Date.parse('2030-01-01T00:00:00Z')).tier).toBe('free');
        });
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
        expect(isFairUseCap('pro', 'vision_reads')).toBe(true);
        expect(isFairUseCap('studio', 'vision_reads')).toBe(true);
        expect(isFairUseCap('pro', 'omr_runs')).toBe(false);
        expect(isFairUseCap('free', 'vision_reads')).toBe(false);
    });

    it('reports a different code so the UI can avoid an upsell', () => {
        expect(limitReachedBody('vision_reads', 5, 'free').code).toBe('limit_reached');
        expect(limitReachedBody('vision_reads', 500, 'pro').code).toBe('fair_use_cap');
    });
});
