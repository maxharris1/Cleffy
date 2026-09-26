import { describe, expect, it } from 'vitest';

import {
    cloudScoreCapReached,
    cloudScoresLimitError,
    isLimitReachedError,
    limitAction,
    limitHeadline,
    parseLimitResponse,
    parseLooseLimitError,
    parsePostgrestLimitError,
} from '@/features/billing/limitErrors';

const jsonResponse = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('parseLimitResponse (Edge Function 402s)', () => {
    it('reads a well-formed limit body', async () => {
        const error = await parseLimitResponse(
            jsonResponse({ code: 'limit_reached', metric: 'omr_runs', limit: 3, tier: 'free' }, 402),
        );
        expect(error?.metric).toBe('omr_runs');
        expect(error?.limit).toBe(3);
        expect(error?.tier).toBe('free');
        expect(isLimitReachedError(error)).toBe(true);
    });

    it('reads the fair-use variant', async () => {
        const error = await parseLimitResponse(
            jsonResponse({ code: 'fair_use_cap', metric: 'vision_reads', limit: 500, tier: 'teacher' }, 402),
        );
        expect(error?.code).toBe('fair_use_cap');
        expect(error?.tier).toBe('teacher');
    });

    it('reads the student-roster metric', async () => {
        const error = await parseLimitResponse(
            jsonResponse({ code: 'limit_reached', metric: 'students', limit: 3, tier: 'free' }, 402),
        );
        expect(error?.metric).toBe('students');
        expect(error?.limit).toBe(3);
    });

    it('ignores any status other than 402', async () => {
        const body = { code: 'limit_reached', metric: 'omr_runs', limit: 3, tier: 'free' };
        expect(await parseLimitResponse(jsonResponse(body, 403))).toBeNull();
        expect(await parseLimitResponse(jsonResponse(body, 200))).toBeNull();
    });

    it('ignores a 402 whose body is not a limit payload', async () => {
        expect(await parseLimitResponse(jsonResponse({ error: 'nope' }, 402))).toBeNull();
        expect(await parseLimitResponse(new Response('not json', { status: 402 }))).toBeNull();
    });

    it('rejects an unknown metric rather than trusting it', async () => {
        const error = await parseLimitResponse(
            jsonResponse({ code: 'limit_reached', metric: 'made_up', limit: 3, tier: 'free' }, 402),
        );
        expect(error).toBeNull();
    });

    it('falls back to free for a tier it does not recognise', async () => {
        // The body is server-sent, but a retired or mistyped tier name must not
        // reach the copy as if it were a plan we sell.
        const error = await parseLimitResponse(
            jsonResponse({ code: 'limit_reached', metric: 'omr_runs', limit: 3, tier: 'mystery' }, 402),
        );
        expect(error?.tier).toBe('free');
    });

    it('leaves the response readable for the caller', async () => {
        // parseLimitResponse clones, so a non-limit response can still be parsed.
        const response = jsonResponse({ error: 'boom' }, 402);
        await parseLimitResponse(response);
        await expect(response.json()).resolves.toEqual({ error: 'boom' });
    });
});

describe('parsePostgrestLimitError (the cloud-score cap trigger)', () => {
    const triggerError = {
        code: 'P0001',
        message: 'limit_reached',
        details: JSON.stringify({ code: 'limit_reached', metric: 'cloud_scores', limit: 3, tier: 'free' }),
    };

    it('reads the payload the trigger puts in DETAIL', () => {
        const error = parsePostgrestLimitError(triggerError);
        expect(error?.metric).toBe('cloud_scores');
        expect(error?.limit).toBe(3);
    });

    it('ignores ordinary database errors', () => {
        expect(parsePostgrestLimitError({ code: '23505', message: 'duplicate key', details: null })).toBeNull();
        expect(parsePostgrestLimitError(null)).toBeNull();
    });

    it('falls back to the 3-score free cap when DETAIL is missing', () => {
        const error = parsePostgrestLimitError({ code: 'P0001', message: 'limit_reached', details: null });
        expect(error?.metric).toBe('cloud_scores');
        expect(error?.limit).toBe(3);
        expect(parsePostgrestLimitError({ code: 'P0001', message: 'limit_reached', details: 'not json' })?.limit).toBe(
            3,
        );
        expect(parsePostgrestLimitError({ code: 'P0001', message: 'Limit reached', details: null })?.limit).toBe(3);
    });
});

describe('client-side cloud-score cap', () => {
    it('is reached when unarchived rows meet the limit', () => {
        expect(cloudScoreCapReached(3, [{ archived_at: null }, { archived_at: null }, { archived_at: null }])).toBe(
            true,
        );
        expect(cloudScoreCapReached(3, [{ archived_at: null }, { archived_at: '2026-01-01' }])).toBe(false);
        expect(cloudScoreCapReached(-1, [{ archived_at: null }])).toBe(false);
    });

    it('maps a bare Limit reached Error onto the amber cloud-score payload', () => {
        const error = parseLooseLimitError(new Error('Limit reached'));
        expect(error?.metric).toBe('cloud_scores');
        expect(error?.limit).toBe(3);
        expect(isLimitReachedError(cloudScoresLimitError(3, 'free'))).toBe(true);
        expect(parseLooseLimitError(new Error('seat_limit_reached'))).toBeNull();
    });
});

describe('limit copy', () => {
    it('names the metric and the number the teacher ran out of', () => {
        expect(limitHeadline({ code: 'limit_reached', metric: 'omr_runs', limit: 3, tier: 'free' })).toContain(
            '3 free play-alongs',
        );
        expect(limitAction({ code: 'limit_reached', metric: 'omr_runs', limit: 3, tier: 'free' })).toContain('Upgrade');
    });

    it('points a paying teacher at support rather than at an upsell', () => {
        const payload = { code: 'fair_use_cap', metric: 'vision_reads', limit: 500, tier: 'teacher' } as const;
        expect(limitAction(payload)).not.toContain('Upgrade');
        expect(limitAction(payload)).toContain('get in touch');
    });

    it('suggests archiving as well as upgrading for the score cap', () => {
        expect(limitAction({ code: 'limit_reached', metric: 'cloud_scores', limit: 3, tier: 'free' })).toContain(
            'archive',
        );
    });

    it('names the roster and points at Teacher when the plan has none', () => {
        // The only reachable students refusal now: Teacher and Academy are
        // unlimited and everyone else is 0, so there is no "you have used N of
        // your M seats" case left to word.
        const payload = { code: 'limit_reached', metric: 'students', limit: 0, tier: 'free' } as const;
        expect(limitHeadline(payload)).toMatch(/student/i);
        expect(limitHeadline(payload)).not.toContain('0');
        expect(limitAction(payload)).toContain('Upgrade');
    });
});
