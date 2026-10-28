import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEMO_DOC_ID, DEMO_PDF_REQUEST_URL } from '@/features/demo/demoScore';

const pdfBytes = () => new TextEncoder().encode('%PDF-1.7\n%%EOF\n').buffer;

/** Each test gets a fresh registry: localDocs is module state. */
const freshModule = async () => {
    vi.resetModules();
    return import('@/features/demo/loadDemoScore');
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('loadDemoScore', () => {
    it('fetches once, registers the bytes, and skips the fetch on a return visit', async () => {
        const { loadDemoScore: load } = await freshModule();
        const { getLocalDoc } = await import('@/lib/localDocs');
        const fetchMock = vi.fn(async () => new Response(pdfBytes(), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const [a, b] = await Promise.all([load(), load()]);
        expect(a).toBe(b);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(DEMO_PDF_REQUEST_URL);
        expect(getLocalDoc(DEMO_DOC_ID)).toBe(a);

        await load();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a 404, and lets the next call try again', async () => {
        const { loadDemoScore: load } = await freshModule();
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response('Not found', { status: 404 }))
            .mockResolvedValueOnce(new Response(pdfBytes(), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        const { DemoScoreUnavailableError } = await import('@/features/demo/loadDemoScore');
        await expect(load()).rejects.toBeInstanceOf(DemoScoreUnavailableError);
        await expect(load()).resolves.toBeInstanceOf(ArrayBuffer);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects the SPA rewrite’s index.html served with a 200', async () => {
        const { loadDemoScore: load } = await freshModule();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200 })),
        );

        const { DemoScoreUnavailableError } = await import('@/features/demo/loadDemoScore');
        await expect(load()).rejects.toBeInstanceOf(DemoScoreUnavailableError);
    });

    it('rejects when offline', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new TypeError('Failed to fetch');
            }),
        );
        const { loadDemoScore: load } = await freshModule();

        // A network failure is fetch's own TypeError, not the score being missing.
        await expect(load()).rejects.toBeInstanceOf(TypeError);
    });
});
