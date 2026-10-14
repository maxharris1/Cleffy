import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    DOWNLOAD_QUEUE_SIGNAL_MS,
    IMSLP_DOWNLOAD_BUSY_MESSAGE,
    IMSLP_DOWNLOAD_TIMEOUT_MESSAGE,
    ImslpImportCancelledError,
    importImslpPdfToStorage,
    type ImslpDownloadStage,
    type ImslpImportRequest,
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

const importNocturnes = (overrides: Partial<ImslpImportRequest> = {}) =>
    importImslpPdfToStorage({
        filename: 'nocturnes.pdf',
        documentId: 'doc-1',
        title: 'Nocturnes',
        acceptedDisclaimer: true,
        workTitle: 'Nocturnes',
        ...overrides,
    });

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
        const result = await importNocturnes({ onStage });
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
        const promise = importNocturnes({ onStage: (s) => stages.push(s) });

        await vi.advanceTimersByTimeAsync(DOWNLOAD_QUEUE_SIGNAL_MS - 1);
        expect(stages).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(stages).toEqual(['queued']);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(9_000 - DOWNLOAD_QUEUE_SIGNAL_MS);
        expect(stages).toEqual(['queued', 'downloading']);
        await expect(promise).resolves.toMatchObject({ ok: true, storagePath: 'doc-1/original.pdf' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('stays silent when the pacing wait is too short to notice', async () => {
        fetchMock.mockResolvedValueOnce(queued(1)).mockResolvedValueOnce(json(stored));
        const onStage = vi.fn();
        const promise = importNocturnes({ onStage });
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(promise).resolves.toMatchObject({ ok: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(onStage).not.toHaveBeenCalled();
    });

    it('gives up with the busy copy once the total wait would pass the cap', async () => {
        fetchMock.mockResolvedValue(queued(30));
        const onStage = vi.fn();
        const promise = importNocturnes({ onStage, maxWaitMs: 60_000 });
        const outcome = promise.then(
            () => 'resolved',
            (err: Error) => err.message,
        );
        // 30 s + 30 s fit inside 60 s; the third 30 s would not.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await outcome).toBe(IMSLP_DOWNLOAD_BUSY_MESSAGE);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(onStage).toHaveBeenCalledWith('queued');
    });

    it('backs successive retries off so a long queue stays under the per-caller limit', async () => {
        fetchMock.mockResolvedValue(queued(1));
        const promise = importNocturnes({ maxWaitMs: 90_000 });
        const outcome = promise.then(
            () => 'resolved',
            (err: Error) => err.message,
        );
        // Retries at 1, 2, 4, 8, 15, 15, 15 s: eight requests in the first minute,
        // under imslp-download's 10/min per-caller limit.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchMock).toHaveBeenCalledTimes(8);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await outcome).toBe(IMSLP_DOWNLOAD_BUSY_MESSAGE);
        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
    });

    it('treats a code-less 429 (the per-address guard) as an error, not a retry', async () => {
        fetchMock.mockResolvedValueOnce(json({ error: 'Too many requests', retryAfterSec: 30 }, 429));
        await expect(importNocturnes()).rejects.toThrow('Too many requests');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('waits out the per-user limit like the pacing queue, since queued teachers can reach it', async () => {
        fetchMock
            .mockResolvedValueOnce(
                json({ ok: false, code: 'caller_rate_limited', error: 'wait', retryAfterSec: 20 }, 429),
            )
            .mockResolvedValueOnce(json(stored));
        const stages: ImslpDownloadStage[] = [];
        const promise = importNocturnes({ onStage: (s) => stages.push(s) });
        await vi.advanceTimersByTimeAsync(20_000);
        await expect(promise).resolves.toMatchObject({ ok: true });
        expect(stages).toEqual(['queued', 'downloading']);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('importImslpPdfToStorage — the server creates the score', () => {
    it('asks the function to create the row, with the title, rather than importing into one', async () => {
        fetchMock.mockResolvedValueOnce(json(stored));
        await importNocturnes({ title: 'Nocturnes, Op.9' });
        const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
        expect(sent).toMatchObject({
            filename: 'nocturnes.pdf',
            documentId: 'doc-1',
            acceptedDisclaimer: true,
            workTitle: 'Nocturnes',
            create: true,
            title: 'Nocturnes, Op.9',
        });
    });

    it('surfaces the cloud-score cap the function refused with as the typed limit error', async () => {
        fetchMock.mockResolvedValueOnce(
            json({ code: 'limit_reached', metric: 'cloud_scores', limit: 3, tier: 'free' }, 402),
        );
        await expect(importNocturnes()).rejects.toMatchObject({ name: 'LimitReachedError', metric: 'cloud_scores' });
    });
});

describe('importImslpPdfToStorage — cancelling a queued import', () => {
    it('stops waiting the moment it is cancelled, and sends no retry', async () => {
        fetchMock.mockResolvedValue(queued(30));
        const controller = new AbortController();
        const promise = importNocturnes({ signal: controller.signal });
        const outcome = promise.then(
            () => 'resolved',
            (err: unknown) => err,
        );
        await vi.advanceTimersByTimeAsync(5_000);
        controller.abort();
        expect(await outcome).toBeInstanceOf(ImslpImportCancelledError);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('sends nothing when cancelled before it starts', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(importNocturnes({ signal: controller.signal })).rejects.toBeInstanceOf(ImslpImportCancelledError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('never aborts a request already sent: its answer is still returned', async () => {
        const controller = new AbortController();
        let answer: ((res: Response) => void) | undefined;
        fetchMock.mockImplementationOnce(
            () =>
                new Promise<Response>((resolve) => {
                    answer = resolve;
                }),
        );
        const promise = importNocturnes({ signal: controller.signal });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        // The request carries only its own deadline, not the cancel signal.
        expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
        answer?.(json(stored));
        await expect(promise).resolves.toMatchObject({ ok: true });
    });
});

describe('importImslpPdfToStorage — bounded call', () => {
    it('sends every call with an abort deadline', async () => {
        fetchMock.mockResolvedValueOnce(json(stored));
        await importNocturnes();
        const init = fetchMock.mock.calls[0]?.[1];
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('turns a timed-out call into a clear try-again message', async () => {
        fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
        await expect(importNocturnes()).rejects.toThrow(IMSLP_DOWNLOAD_TIMEOUT_MESSAGE);
        expect(IMSLP_DOWNLOAD_TIMEOUT_MESSAGE).toMatch(/try again/i);
    });

    it('passes other network failures through unchanged', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(importNocturnes()).rejects.toThrow('Failed to fetch');
    });

    it.each(['forbidden', 'timeout'] as const)(
        'hands an IMSLP %s refusal to the open-on-IMSLP fallback rather than throwing',
        async (code) => {
            fetchMock.mockResolvedValueOnce(
                json(
                    {
                        ok: false,
                        code,
                        message: 'IMSLP said no',
                        openUrl: 'https://imslp.org/wiki/Special:ImagefromIndex/nocturnes.pdf',
                        filename: 'nocturnes.pdf',
                    },
                    409,
                ),
            );
            await expect(importNocturnes()).resolves.toEqual({
                ok: false,
                code,
                message: 'IMSLP said no',
                openUrl: 'https://imslp.org/wiki/Special:ImagefromIndex/nocturnes.pdf',
                filename: 'nocturnes.pdf',
            });
        },
    );
});
