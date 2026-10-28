import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEMO_DOC_ID, DEMO_PDF_REQUEST_URL, DEMO_PDF_URL } from '@/features/demo/demoScore';
import { isCloudDocId } from '@/sync/docIds';

const pdfBytes = () => new TextEncoder().encode('%PDF-1.7\n%%EOF\n').buffer;

/** Each test gets a fresh registry: localDocs is module state. */
const freshModule = async () => {
    vi.resetModules();
    return import('@/features/demo/demoScore');
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('demo score', () => {
    it('is a local doc id, never a cloud one', () => {
        expect(DEMO_DOC_ID.startsWith('local-')).toBe(true);
        expect(isCloudDocId(DEMO_DOC_ID)).toBe(false);
    });

    it('requests the file versioned by the doc id, so a new edition busts the cache', () => {
        expect(DEMO_PDF_REQUEST_URL).toBe(`${DEMO_PDF_URL}?v=${DEMO_DOC_ID}`);
    });

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

        await expect(load()).rejects.toThrow('HTTP 404');
        await expect(load()).resolves.toBeInstanceOf(ArrayBuffer);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('rejects the SPA rewrite’s index.html served with a 200', async () => {
        const { loadDemoScore: load } = await freshModule();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200 })),
        );

        await expect(load()).rejects.toThrow('not a PDF');
    });

    it('rejects when offline', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new TypeError('Failed to fetch');
            }),
        );
        const { loadDemoScore: load } = await freshModule();

        await expect(load()).rejects.toThrow('Failed to fetch');
    });
});
