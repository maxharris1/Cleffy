import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DOWNLOAD_QUEUE_SIGNAL_MS,
    IMSLP_DOWNLOAD_BUSY_MESSAGE,
    importImslpPdfToStorage,
    type ImslpDownloadStage,
} from '@/features/imslp/imslpApi';

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        auth: {
            getSession: () => Promise.resolve({ data: { session: { access_token: 'test-token' } } }),
        },
    }),
    requireSupabaseConfig: () => ({ url: 'https://test.supabase.co', anonKey: 'test-anon-key' }),
}));

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const stored = { ok: true, filename: 'nocturnes.pdf', byteLength: 1234, storagePath: 'doc-1/original.pdf' };
const queued = (retryAfterSec: number) =>
    json({ ok: false, code: 'download_queued', error: 'paced', retryAfterSec }, 429);

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('importImslpPdfToStorage — deployment-wide IMSLP pacing', () => {
    it('succeeds first try without reporting any stage', async () => {
        fetchMock.mockResolvedValueOnce(json(stored));
        const onStage = vi.fn();
        const result = await importImslpPdfToStorage(
            'nocturnes.pdf',
            'doc-1',
            true,
            'Nocturnes',
            undefined,
            onStage,
        );
        expect(result).toEqual({
            ok: true,
            filename: 'nocturnes.pdf',
            byteLength: 1234,
            storagePath: 'doc-1/original.pdf',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(onStage).not.toHaveBeenCalled();
    });

    it('waits the server retryAfterSec and retries; announces the queue only once a real wait is under way', async () => {
        fetchMock.mockResolvedValueOnce(queued(9)).mockResolvedValueOnce(json(stored));
        const stages: ImslpDownloadStage[] = [];
        const promise = importImslpPdfToStorage(
            'nocturnes.pdf',
            'doc-1',
            true,
            'Nocturnes',
            undefined,
            (s) => stages.push(s),
        );

        await vi.advanceTimersByTimeAsync(DOWNLOAD_QUEUE_SIGNAL_MS - 1);
        expect(stages).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(stages).toEqual(['downloadQueued']);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(9_000 - DOWNLOAD_QUEUE_SIGNAL_MS);
        expect(stages).toEqual(['downloadQueued', 'downloading']);
        await expect(promise).resolves.toMatchObject({ ok: true, storagePath: 'doc-1/original.pdf' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stays silent when the pacing wait is too short to notice', async () => {
        fetchMock.mockResolvedValueOnce(queued(1)).mockResolvedValueOnce(json(stored));
        const onStage = vi.fn();
        const promise = importImslpPdfToStorage(
            'nocturnes.pdf',
            'doc-1',
            true,
            'Nocturnes',
            undefined,
            onStage,
        );
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(promise).resolves.toMatchObject({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(onStage).not.toHaveBeenCalled();
    });

    it('gives up with the busy copy once the total wait would pass the cap', async () => {
        fetchMock.mockResolvedValue(queued(30));
        const onStage = vi.fn();
        const promise = importImslpPdfToStorage(
            'nocturnes.pdf',
            'doc-1',
            true,
            'Nocturnes',
            undefined,
            onStage,
            60_000,
        );
        const outcome = promise.then(
            () => 'resolved',
            (err: Error) => err.message,
        );
        // 30 s + 30 s fit inside 60 s; the third 30 s would not.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await outcome).toBe(IMSLP_DOWNLOAD_BUSY_MESSAGE);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(onStage).toHaveBeenCalledWith('downloadQueued');
    });

    it('leaves the per-caller limiter alone: a code-less 429 is still an error, not a retry', async () => {
        fetchMock.mockResolvedValueOnce(json({ error: 'Too many requests', retryAfterSec: 30 }, 429));
        await expect(importImslpPdfToStorage('nocturnes.pdf', 'doc-1', true, 'Nocturnes')).rejects.toThrow(
            'Too many requests',
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
