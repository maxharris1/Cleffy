import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CachedPdf, CachedThumbnail } from '@/sync/db';

// fake-indexeddb's structured clone strips jsdom Blob methods, so Dexie is
// replaced by in-memory maps that keep real Blobs readable (same shape as
// documentsService.test.ts).
const pdfCache = vi.hoisted(() => new Map<string, CachedPdf>());
const thumbnails = vi.hoisted(() => new Map<string, CachedThumbnail>());

vi.mock('@/sync/db', () => ({
    getDb: () => ({
        pdfCache: {
            get: (docId: string) => Promise.resolve(pdfCache.get(docId)),
        },
        thumbnails: {
            get: (docId: string) => Promise.resolve(thumbnails.get(docId)),
            put: (row: CachedThumbnail) => {
                thumbnails.set(row.docId, row);
                return Promise.resolve(row.docId);
            },
        },
    }),
}));

const renderFirstPagePng = vi.hoisted(() => vi.fn());
vi.mock('@/features/library/thumbnailRender', () => ({
    THUMB_MAX_SIDE: 256,
    renderFirstPagePng,
}));

const pngBlob = () => new Blob(['png-bytes'], { type: 'image/png' });

const cachePdf = (docId: string, contentRev: number | undefined) => {
    pdfCache.set(docId, {
        docId,
        bytes: new Blob(['%PDF-1.7']),
        title: 'Sonata',
        cachedAt: '2026-08-01T00:00:00Z',
        contentRev,
    });
};

const cacheThumb = (docId: string, contentRev: number, blob = pngBlob()) => {
    thumbnails.set(docId, { docId, contentRev, blob, width: 181, height: 256, createdAt: '2026-08-01T00:00:00Z' });
};

/**
 * inFlight / failed / queue are module-level and session-scoped, so every test
 * needs a fresh copy of the module rather than a fresh mock.
 */
const loadService = async () => {
    vi.resetModules();
    return import('@/features/library/thumbnailService');
};

beforeEach(() => {
    pdfCache.clear();
    thumbnails.clear();
    renderFirstPagePng.mockReset();
    renderFirstPagePng.mockResolvedValue({ blob: pngBlob(), width: 181, height: 256 });
});

describe('getThumbnail', () => {
    it('serves a cached thumbnail at the requested revision without rendering', async () => {
        const stored = pngBlob();
        cacheThumb('d1', 2, stored);
        cachePdf('d1', 2);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 2)).toBe(stored);
        expect(renderFirstPagePng).not.toHaveBeenCalled();
    });

    it('renders from the cached bytes on a miss and stores the render', async () => {
        cachePdf('d1', 3);
        const { getThumbnail } = await loadService();

        const blob = await getThumbnail('d1', 3);
        expect(blob).toBeInstanceOf(Blob);
        expect(renderFirstPagePng).toHaveBeenCalledTimes(1);
        // The revision stored is the one the BYTES carry, not the one asked for.
        expect(thumbnails.get('d1')).toMatchObject({ contentRev: 3, width: 181, height: 256 });
    });

    it('never fetches: no cached bytes means no thumbnail and no render', async () => {
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 0)).toBeNull();
        expect(renderFirstPagePng).not.toHaveBeenCalled();
    });

    it('re-renders when the document revision moves past the stored thumbnail', async () => {
        cacheThumb('d1', 0);
        cachePdf('d1', 1);
        const { getThumbnail } = await loadService();

        await getThumbnail('d1', 1);
        expect(renderFirstPagePng).toHaveBeenCalledTimes(1);
        expect(thumbnails.get('d1')?.contentRev).toBe(1);
    });

    it('keeps showing a stale thumbnail when the newer bytes are not cached here', async () => {
        const stale = pngBlob();
        cacheThumb('d1', 0, stale);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 1)).toBe(stale);
        expect(renderFirstPagePng).not.toHaveBeenCalled();
    });

    it('collapses concurrent requests for one score into a single render', async () => {
        cachePdf('d1', 0);
        const { getThumbnail } = await loadService();

        const [a, b] = await Promise.all([getThumbnail('d1', 0), getThumbnail('d1', 0)]);
        expect(renderFirstPagePng).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
    });

    it('remembers a failed render so a scrolling library does not retry it', async () => {
        cachePdf('d1', 0);
        renderFirstPagePng.mockRejectedValue(new Error('bad xref table'));
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 0)).toBeNull();
        expect(await getThumbnail('d1', 0)).toBeNull();
        expect(renderFirstPagePng).toHaveBeenCalledTimes(1);
    });
});
