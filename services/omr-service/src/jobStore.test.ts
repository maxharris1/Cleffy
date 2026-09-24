import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLAIM_MAX_PRIORITY_ENV } from './claimPriority.js';
import { claimJob, hasQueuedWork } from './jobStore.js';

const rpc = vi.fn();
let controlResult: { data: { paused: boolean } | null; error: unknown } = { data: { paused: false }, error: null };
const controlRead = vi.fn();
const filters: Array<[string, unknown, unknown]> = [];
let countResult: { count: number | null; error: unknown } = { count: 0, error: null };

/** Minimal PostgREST builder: records each filter and resolves to `countResult`. */
const builder = () => {
    const b = {
        select: () => b,
        eq: (col: string, v: unknown) => {
            filters.push(['eq', col, v]);
            return b;
        },
        lte: (col: string, v: unknown) => {
            filters.push(['lte', col, v]);
            return b;
        },
        then: (resolve: (v: typeof countResult) => unknown) => Promise.resolve(countResult).then(resolve),
    };
    return b;
};

vi.mock('./supabaseClient.js', () => ({
    serviceClient: () => ({
        rpc: (...args: unknown[]) => rpc(...args),
        from: (table: string) => {
            if (table !== 'playalong_corpus_control') return builder();
            const control = {
                select: () => control,
                eq: () => control,
                maybeSingle: () => {
                    controlRead();
                    return Promise.resolve(controlResult);
                },
            };
            return control;
        },
    }),
}));

const original = process.env[CLAIM_MAX_PRIORITY_ENV];

const jobRow = (priority: number) => ({
    id: 7,
    document_id: '0c7fdd18-7d2d-4d24-b4dc-a17971a2b3a4',
    status: 'running',
    attempt: 1,
    max_attempts: 3,
    storage_path: 'doc/original.pdf',
    page_count: 2,
    created_by: null,
    priority,
});

beforeEach(() => {
    rpc.mockReset();
    controlRead.mockClear();
    controlResult = { data: { paused: false }, error: null };
    filters.length = 0;
    countResult = { count: 0, error: null };
    delete process.env[CLAIM_MAX_PRIORITY_ENV];
});

afterEach(() => {
    if (original === undefined) {
        delete process.env[CLAIM_MAX_PRIORITY_ENV];
    } else {
        process.env[CLAIM_MAX_PRIORITY_ENV] = original;
    }
});

describe('claimJob', () => {
    it('calls omr_claim_job without p_max_priority when the env is unset (user worker)', async () => {
        rpc.mockResolvedValue({ data: jobRow(0), error: null });
        const job = await claimJob('worker-a');
        expect(rpc).toHaveBeenCalledWith('omr_claim_job', { p_worker_id: 'worker-a', p_lease_seconds: 300 });
        expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty('p_max_priority');
        expect(job?.id).toBe(7);
    });

    it('passes p_max_priority from CLEFFY_CLAIM_MAX_PRIORITY (seed pool)', async () => {
        process.env[CLAIM_MAX_PRIORITY_ENV] = '-1';
        rpc.mockResolvedValue({ data: [jobRow(-10)], error: null });
        const job = await claimJob('seed-a');
        expect(rpc).toHaveBeenCalledWith('omr_claim_job', {
            p_worker_id: 'seed-a',
            p_lease_seconds: 300,
            p_max_priority: -1,
        });
        expect(job?.id).toBe(7);
    });

    it('honours an explicit filter argument over the env', async () => {
        process.env[CLAIM_MAX_PRIORITY_ENV] = '-1';
        rpc.mockResolvedValue({ data: null, error: null });
        await claimJob('w', null);
        expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty('p_max_priority');
        await claimJob('w', -5);
        expect(rpc.mock.calls[1]?.[1]).toMatchObject({ p_max_priority: -5 });
    });

    it('returns null on an RPC error or an all-null row (empty queue) instead of claiming', async () => {
        process.env[CLAIM_MAX_PRIORITY_ENV] = '-1';
        rpc.mockResolvedValueOnce({
            data: null,
            error: { message: 'function omr_claim_job(text, integer, integer) does not exist' },
        });
        expect(await claimJob('seed-b')).toBeNull();
        rpc.mockResolvedValueOnce({ data: { id: null, document_id: null, status: null }, error: null });
        expect(await claimJob('seed-b')).toBeNull();
    });
});

describe('hasQueuedWork', () => {
    it('counts every queued, due row when no filter is set', async () => {
        countResult = { count: 2, error: null };
        expect(await hasQueuedWork()).toBe(true);
        expect(filters.map(([op, col]) => `${op}:${col}`)).toEqual(['eq:status', 'lte:run_after']);
    });

    it('applies the same priority ceiling as claimJob so a seed instance never fans out on user rows', async () => {
        process.env[CLAIM_MAX_PRIORITY_ENV] = '-1';
        countResult = { count: 0, error: null };
        expect(await hasQueuedWork()).toBe(false);
        expect(filters).toContainEqual(['lte', 'priority', -1]);
        expect(filters.map(([op, col]) => `${op}:${col}`)).toEqual(['eq:status', 'lte:run_after', 'lte:priority']);
    });

    it('takes an explicit ceiling and is false on a query error', async () => {
        countResult = { count: 3, error: null };
        expect(await hasQueuedWork(-10)).toBe(true);
        expect(filters).toContainEqual(['lte', 'priority', -10]);
        countResult = { count: null, error: { message: 'boom' } };
        expect(await hasQueuedWork(-10)).toBe(false);
    });
});

describe('seed pool soft pause', () => {
    it('stops claims and fan-out with due jobs still queued, then resumes', async () => {
        countResult = { count: 4, error: null };
        rpc.mockResolvedValue({ data: jobRow(-10), error: null });
        controlResult = { data: { paused: true }, error: null };
        expect(await claimJob('seed', -1)).toBeNull();
        expect(await hasQueuedWork(-1)).toBe(false);
        expect(rpc).not.toHaveBeenCalled();
        expect(filters).toEqual([]);
        controlResult = { data: { paused: false }, error: null };
        expect((await claimJob('seed', -1))?.id).toBe(7);
        expect(await hasQueuedWork(-1)).toBe(true);
    });

    it.each([
        { data: null, error: null },
        { data: null, error: { message: 'control unavailable' } },
    ])('fails closed when seed control cannot be read: %j', async (result) => {
        controlResult = result;
        countResult = { count: 4, error: null };
        expect(await claimJob('seed', -1)).toBeNull();
        expect(await hasQueuedWork(-1)).toBe(false);
        expect(rpc).not.toHaveBeenCalled();
    });

    it.each([null, 0])('leaves user workers unaffected with priority %s', async (priority) => {
        controlResult = { data: { paused: true }, error: null };
        countResult = { count: 4, error: null };
        rpc.mockResolvedValue({ data: jobRow(0), error: null });
        expect((await claimJob('user', priority))?.id).toBe(7);
        expect(await hasQueuedWork(priority)).toBe(true);
        expect(controlRead).not.toHaveBeenCalled();
    });
});
