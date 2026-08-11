import { describe, expect, it } from 'vitest';

import {
    isLimitReachedError,
    limitAction,
    limitHeadline,
    parseLimitResponse,
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
            jsonResponse({ code: 'fair_use_cap', metric: 'vision_reads', limit: 500, tier: 'pro' }, 402),
        );
        expect(error?.code).toBe('fair_use_cap');
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

    it('ignores a limit_reached with no usable detail', () => {
        expect(parsePostgrestLimitError({ code: 'P0001', message: 'limit_reached', details: null })).toBeNull();
        expect(parsePostgrestLimitError({ code: 'P0001', message: 'limit_reached', details: 'not json' })).toBeNull();
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
        const payload = { code: 'fair_use_cap', metric: 'vision_reads', limit: 500, tier: 'pro' } as const;
        expect(limitAction(payload)).not.toContain('Upgrade');
        expect(limitAction(payload)).toContain('get in touch');
    });

    it('suggests archiving as well as upgrading for the score cap', () => {
        expect(limitAction({ code: 'limit_reached', metric: 'cloud_scores', limit: 3, tier: 'free' })).toContain(
            'archive',
        );
    });
});
