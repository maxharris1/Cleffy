import { beforeEach, describe, expect, it, vi } from 'vitest';

import { THUMB_MAX_SIDE } from '@/features/library/thumbnailSize';
import type { CachedPdf, CachedThumbnail } from '@/sync/db';

// fake-indexeddb's structured clone strips jsdom Blob methods, so Dexie is
// replaced by in-memory maps that keep real Blobs readable (same shape as
// documentsService.test.ts).
const pdfCache = vi.hoisted(() => new Map<string, CachedPdf>());
const thumbnails = vi.hoisted(() => new Map<string, CachedThumbnail>());
// Flipped on to simulate WebKit refusing an IndexedDB write (private browsing).
const storeFailure = vi.hoisted(() => ({ put: null as Error | null }));

vi.mock('@/sync/db', () => ({
    getDb: () => ({
        pdfCache: {
            get: (docId: string) => Promise.resolve(pdfCache.get(docId)),
        },
        thumbnails: {
            get: (docId: string) => Promise.resolve(thumbnails.get(docId)),
            put: (row: CachedThumbnail) => {
                if (storeFailure.put) {
                    return Promise.reject(storeFailure.put);
                }
                thumbnails.set(row.docId, row);
                return Promise.resolve(row.docId);
            },
        },
    }),
}));

const renderFirstPagePng = vi.hoisted(() => vi.fn());
// The service reads THUMB_MAX_SIDE from thumbnailSize (the real module, kept
// separate precisely so importing it cannot drag pdf.js into the bundle); only
// the renderer itself is mocked away here.
vi.mock('@/features/library/thumbnailRender', () => ({ renderFirstPagePng }));

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

const cacheThumb = (docId: string, contentRev: number, blob = pngBlob(), maxSide = THUMB_MAX_SIDE) => {
    thumbnails.set(docId, {
        docId,
        contentRev,
        maxSide,
        blob,
        width: 181,
        height: 256,
        createdAt: '2026-08-01T00:00:00Z',
    });
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
    storeFailure.put = null;
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
        expect(thumbnails.get('d1')).toMatchObject({
            contentRev: 3,
            maxSide: THUMB_MAX_SIDE,
            width: 181,
            height: 256,
        });
    });

    // WebKit cannot back an IndexedDB Blob with a file in a private-browsing
    // origin, so the store rejects. Only the write failed — discarding the PNG
    // left the library showing blank covers for scores that rendered fine.
    it('shows a render the browser refused to store', async () => {
        cachePdf('d1', 1);
        storeFailure.put = new Error('Error preparing Blob/File data to be stored in object store');
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 1)).toBeInstanceOf(Blob);
        expect(thumbnails.has('d1')).toBe(false);
    });

    it('does not re-render a score whose thumbnail could not be stored', async () => {
        cachePdf('d1', 1);
        storeFailure.put = new Error('Error preparing Blob/File data to be stored in object store');
        const { getThumbnail } = await loadService();

        const first = await getThumbnail('d1', 1);
        const second = await getThumbnail('d1', 1);
        expect(second).toBe(first);
        expect(renderFirstPagePng).toHaveBeenCalledTimes(1);
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

    it('renders bytes that lag the requested revision once, not on every library visit', async () => {
        // Shaped like a row uploadDocument wrote: bytes cached with no contentRev.
        // A replace on another device bumped documents.content_rev to 1, but
        // those newer bytes have never been downloaded here.
        cachePdf('d1', undefined);
        const { getThumbnail } = await loadService();

        const first = await getThumbnail('d1', 1);
        const second = await getThumbnail('d1', 1);

        expect(renderFirstPagePng).toHaveBeenCalledTimes(1);
        expect(second).toBe(first);
        // Still stamped with the BYTES' revision, so the render regenerates as
        // soon as ensureLocalPdf caches the replacement.
        expect(thumbnails.get('d1')?.contentRev).toBe(0);
    });

    it('re-renders a thumbnail cached at the old, smaller size', async () => {
        // Covers are ~208px wide, so a 256px render is soft on a 2x display.
        cacheThumb('d1', 2, pngBlob(), 256);
        cachePdf('d1', 2);
        const { getThumbnail } = await loadService();

        await getThumbnail('d1', 2);
        expect(renderFirstPagePng).toHaveBeenCalledTimes(1);
        expect(thumbnails.get('d1')?.maxSide).toBe(THUMB_MAX_SIDE);
        expect(THUMB_MAX_SIDE).toBe(512);
    });

    it('re-renders a row written before maxSide existed, which undefined comparisons would keep', async () => {
        const legacy = pngBlob();
        // Deliberately shaped like a pre-shelf row: no maxSide at all.
        thumbnails.set('d1', {
            docId: 'd1',
            contentRev: 2,
            blob: legacy,
            width: 181,
            height: 256,
            createdAt: '2026-08-01T00:00:00Z',
        } as CachedThumbnail);
        cachePdf('d1', 2);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 2)).not.toBe(legacy);
        expect(renderFirstPagePng).toHaveBeenCalledTimes(1);
        expect(thumbnails.get('d1')?.maxSide).toBe(THUMB_MAX_SIDE);
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
