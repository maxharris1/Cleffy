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

const renderFirstPageJpeg = vi.hoisted(() => vi.fn());
// The service reads THUMB_MAX_SIDE from thumbnailSize (the real module, kept
// separate precisely so importing it cannot drag pdf.js into the bundle); only
// the renderer itself is mocked away here.
vi.mock('@/features/library/thumbnailRender', () => ({ renderFirstPageJpeg }));

// The published copy: Storage upload/download and the row update that stamps
// documents.thumb_rev. The real thumbnailRemote module runs over this stub.
const storageUpload = vi.hoisted(() => vi.fn());
const storageDownload = vi.hoisted(() => vi.fn());
const rowUpdate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        storage: {
            from: (bucket: string) => ({
                upload: (...args: unknown[]) => storageUpload(bucket, ...args),
                download: (...args: unknown[]) => storageDownload(bucket, ...args),
            }),
        },
        from: (table: string) => ({
            update: (patch: unknown) => ({
                eq: (column: string, value: unknown) => rowUpdate(table, patch, column, value),
            }),
        }),
    }),
}));

/** What the renderer produces today, and what the bucket accepts. */
const pngBlob = () => new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
/** A render from before the JPEG encoder — still in many browsers' Dexie stores. */
const legacyPngBlob = () => new Blob(['png-bytes'], { type: 'image/png' });

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

/** Lets every detached publish/fetch settle before asserting on it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    pdfCache.clear();
    thumbnails.clear();
    storeFailure.put = null;
    renderFirstPageJpeg.mockReset();
    renderFirstPageJpeg.mockResolvedValue({ blob: pngBlob(), width: 181, height: 256 });
    storageUpload.mockReset();
    storageUpload.mockResolvedValue({ data: null, error: null });
    storageDownload.mockReset();
    storageDownload.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
    rowUpdate.mockReset();
    rowUpdate.mockResolvedValue({ data: null, error: null });
});

describe('getThumbnail', () => {
    it('serves a cached thumbnail at the requested revision without rendering', async () => {
        const stored = pngBlob();
        cacheThumb('d1', 2, stored);
        cachePdf('d1', 2);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 2)).toBe(stored);
        expect(renderFirstPageJpeg).not.toHaveBeenCalled();
    });

    it('renders from the cached bytes on a miss and stores the render', async () => {
        cachePdf('d1', 3);
        const { getThumbnail } = await loadService();

        const blob = await getThumbnail('d1', 3);
        expect(blob).toBeInstanceOf(Blob);
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(1);
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
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(1);
    });

    // The memo stands in for a store that refused us, so it must not become the
    // unbounded one: a long library scroll would otherwise pin every cover in
    // memory for the life of the tab.
    it('caps the renders it holds for a browser that cannot store them', async () => {
        storeFailure.put = new Error('Error preparing Blob/File data to be stored in object store');
        const { getThumbnail } = await loadService();
        // 25 distinct scores against a limit of 24 — the first is evicted.
        for (let i = 0; i < 25; i += 1) {
            cachePdf(`d${i}`, 1);
            await getThumbnail(`d${i}`, 1);
        }
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(25);

        // Still held: asking again is free.
        await getThumbnail('d24', 1);
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(25);

        // Evicted: asking again pays for another render rather than growing.
        await getThumbnail('d0', 1);
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(26);
    });

    it('never fetches: no cached bytes means no thumbnail and no render', async () => {
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 0)).toBeNull();
        expect(renderFirstPageJpeg).not.toHaveBeenCalled();
    });

    it('re-renders when the document revision moves past the stored thumbnail', async () => {
        cacheThumb('d1', 0);
        cachePdf('d1', 1);
        const { getThumbnail } = await loadService();

        await getThumbnail('d1', 1);
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(1);
        expect(thumbnails.get('d1')?.contentRev).toBe(1);
    });

    it('keeps showing a stale thumbnail when the newer bytes are not cached here', async () => {
        const stale = pngBlob();
        cacheThumb('d1', 0, stale);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 1)).toBe(stale);
        expect(renderFirstPageJpeg).not.toHaveBeenCalled();
    });

    it('renders bytes that lag the requested revision once, not on every library visit', async () => {
        // Shaped like a row uploadDocument wrote: bytes cached with no contentRev.
        // A replace on another device bumped documents.content_rev to 1, but
        // those newer bytes have never been downloaded here.
        cachePdf('d1', undefined);
        const { getThumbnail } = await loadService();

        const first = await getThumbnail('d1', 1);
        const second = await getThumbnail('d1', 1);

        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(1);
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
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(1);
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
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(1);
        expect(thumbnails.get('d1')?.maxSide).toBe(THUMB_MAX_SIDE);
    });

    it('collapses concurrent requests for one score into a single render', async () => {
        cachePdf('d1', 0);
        const { getThumbnail } = await loadService();

        const [a, b] = await Promise.all([getThumbnail('d1', 0), getThumbnail('d1', 0)]);
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
    });

    it('remembers a failed render so a scrolling library does not retry it', async () => {
        cachePdf('d1', 0);
        renderFirstPageJpeg.mockRejectedValue(new Error('bad xref table'));
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 0)).toBeNull();
        expect(await getThumbnail('d1', 0)).toBeNull();
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(1);
    });
});

describe('published covers', () => {
    it('publishes a fresh render and stamps the row when nothing newer is published', async () => {
        cachePdf('d1', 3);
        const { getThumbnail } = await loadService();

        const blob = await getThumbnail('d1', 3, null);
        await settle();

        expect(storageUpload).toHaveBeenCalledWith(
            'thumbnails',
            'd1/3.jpg',
            blob,
            expect.objectContaining({ contentType: 'image/jpeg', upsert: true }),
        );
        expect(rowUpdate).toHaveBeenCalledWith('documents', { thumb_rev: 3 }, 'id', 'd1');
    });

    it('publishes a fresh upload — content_rev 0 with nothing published is not "already at 0"', async () => {
        // Shaped like the row uploadDocument just seeded: bytes with no contentRev.
        cachePdf('d1', undefined);
        const { getThumbnail } = await loadService();

        const blob = await getThumbnail('d1', 0, null);
        await settle();

        expect(storageUpload).toHaveBeenCalledWith('thumbnails', 'd1/0.jpg', blob, expect.anything());
        expect(rowUpdate).toHaveBeenCalledWith('documents', { thumb_rev: 0 }, 'id', 'd1');
    });

    it('does not publish when the published revision is already current', async () => {
        cachePdf('d1', 3);
        const { getThumbnail } = await loadService();

        await getThumbnail('d1', 3, 3);
        await settle();

        expect(storageUpload).not.toHaveBeenCalled();
        expect(rowUpdate).not.toHaveBeenCalled();
    });

    it('republishes a current local JPEG when the published object 404s', async () => {
        const stored = pngBlob();
        cacheThumb('d1', 3, stored);
        cachePdf('d1', 3);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 3, 3)).toBe(stored);
        await settle();

        expect(storageDownload).toHaveBeenCalledWith('thumbnails', 'd1/3.jpg');
        expect(storageUpload).toHaveBeenCalledTimes(1);
        expect(storageUpload).toHaveBeenCalledWith('thumbnails', 'd1/3.jpg', stored, expect.anything());
        expect(rowUpdate).toHaveBeenCalledWith('documents', { thumb_rev: 3 }, 'id', 'd1');
    });

    it('does not republish when the published-object probe returns 503', async () => {
        const stored = pngBlob();
        storageDownload.mockResolvedValue({
            data: null,
            error: { message: 'Service unavailable', statusCode: '503' },
        });
        cacheThumb('d1', 3, stored);
        cachePdf('d1', 3);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 3, 3)).toBe(stored);
        await settle();

        expect(storageDownload).toHaveBeenCalledWith('thumbnails', 'd1/3.jpg');
        expect(storageUpload).not.toHaveBeenCalled();
        expect(rowUpdate).not.toHaveBeenCalled();
    });

    it('does not republish when the published-object download throws', async () => {
        const stored = pngBlob();
        storageDownload.mockRejectedValue(new Error('network down'));
        cacheThumb('d1', 3, stored);
        cachePdf('d1', 3);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 3, 3)).toBe(stored);
        await settle();

        expect(storageDownload).toHaveBeenCalledWith('thumbnails', 'd1/3.jpg');
        expect(storageUpload).not.toHaveBeenCalled();
        expect(rowUpdate).not.toHaveBeenCalled();
    });

    it('does not republish a current local JPEG when the published object is still there', async () => {
        const stored = pngBlob();
        const published = new Blob(['published-jpeg'], { type: 'image/jpeg' });
        storageDownload.mockResolvedValue({ data: published, error: null });
        cacheThumb('d1', 3, stored);
        cachePdf('d1', 3);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 3, 3)).toBe(stored);
        await settle();

        expect(storageDownload).toHaveBeenCalledWith('thumbnails', 'd1/3.jpg');
        expect(storageUpload).not.toHaveBeenCalled();
    });

    it('publishes an earlier JPEG render found in the cache without rendering again', async () => {
        const stored = pngBlob();
        cacheThumb('d1', 2, stored);
        cachePdf('d1', 2);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 2, null)).toBe(stored);
        await settle();

        expect(renderFirstPageJpeg).not.toHaveBeenCalled();
        expect(storageUpload).toHaveBeenCalledWith('thumbnails', 'd1/2.jpg', stored, expect.anything());
    });

    it('re-encodes a legacy PNG render once so the bucket will take it', async () => {
        cacheThumb('d1', 2, legacyPngBlob());
        cachePdf('d1', 2);
        const { getThumbnail } = await loadService();

        const first = await getThumbnail('d1', 2, null);
        await settle();
        expect(first?.type).toBe('image/jpeg');
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(1);
        expect(storageUpload).toHaveBeenCalledWith('thumbnails', 'd1/2.jpg', first, expect.anything());

        // The attempt is remembered: no second pass on the next scroll.
        await getThumbnail('d1', 2, null);
        await settle();
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(1);
        expect(storageUpload).toHaveBeenCalledTimes(1);
    });

    it('keeps a legacy PNG when the bytes to re-encode it are not here', async () => {
        const legacy = legacyPngBlob();
        cacheThumb('d1', 2, legacy);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 2, null)).toBe(legacy);
        await settle();
        expect(renderFirstPageJpeg).not.toHaveBeenCalled();
        expect(storageUpload).not.toHaveBeenCalled();
    });

    it('attempts a refused publish once per session, not on every scroll', async () => {
        storageUpload.mockResolvedValue({ data: null, error: { message: 'new row violates row-level security' } });
        cachePdf('d1', 1);
        const { getThumbnail } = await loadService();

        await getThumbnail('d1', 1, null);
        await settle();
        await getThumbnail('d1', 1, null);
        await settle();

        expect(storageUpload).toHaveBeenCalledTimes(1);
        expect(rowUpdate).not.toHaveBeenCalled();
    });

    it('downloads the published cover when the bytes are not on this device, then serves it from Dexie', async () => {
        const published = new Blob(['published-jpeg'], { type: 'image/jpeg' });
        storageDownload.mockResolvedValue({ data: published, error: null });
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 2, 2)).toBe(published);
        expect(storageDownload).toHaveBeenCalledWith('thumbnails', 'd1/2.jpg');
        expect(thumbnails.get('d1')).toMatchObject({ contentRev: 2, maxSide: THUMB_MAX_SIDE });
        expect(renderFirstPageJpeg).not.toHaveBeenCalled();

        expect(await getThumbnail('d1', 2, 2)).toBe(published);
        expect(storageDownload).toHaveBeenCalledTimes(1);
    });

    it('never downloads when nothing is published', async () => {
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 2, null)).toBeNull();
        expect(storageDownload).not.toHaveBeenCalled();
    });

    it('prefers the local bytes over a download when both are available', async () => {
        cachePdf('d1', 2);
        const { getThumbnail } = await loadService();

        await getThumbnail('d1', 2, 2);
        expect(renderFirstPageJpeg).toHaveBeenCalledTimes(1);
        expect(storageDownload).not.toHaveBeenCalled();
    });

    it('keeps a stale local cover rather than downloading one no newer than it', async () => {
        const stale = pngBlob();
        cacheThumb('d1', 2, stale);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 3, 2)).toBe(stale);
        expect(storageDownload).not.toHaveBeenCalled();
    });

    it('downloads a published cover newer than the stale local one', async () => {
        const published = new Blob(['newer'], { type: 'image/jpeg' });
        storageDownload.mockResolvedValue({ data: published, error: null });
        cacheThumb('d1', 1, pngBlob());
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 3, 3)).toBe(published);
        expect(thumbnails.get('d1')?.contentRev).toBe(3);
    });

    it('remembers a failed download for the session and shows what it has', async () => {
        const stale = pngBlob();
        cacheThumb('d1', 1, stale);
        const { getThumbnail } = await loadService();

        expect(await getThumbnail('d1', 3, 3)).toBe(stale);
        expect(await getThumbnail('d1', 3, 3)).toBe(stale);
        expect(storageDownload).toHaveBeenCalledTimes(1);
    });

    it('runs at most four downloads at a time', async () => {
        let inFlightNow = 0;
        let peak = 0;
        const gates: Array<() => void> = [];
        storageDownload.mockImplementation(
            () =>
                new Promise((resolve) => {
                    inFlightNow += 1;
                    peak = Math.max(peak, inFlightNow);
                    gates.push(() => {
                        inFlightNow -= 1;
                        resolve({ data: new Blob(['x'], { type: 'image/jpeg' }), error: null });
                    });
                }),
        );
        const { getThumbnail } = await loadService();

        const all = Promise.all(Array.from({ length: 10 }, (_, i) => getThumbnail(`d${i}`, 1, 1)));
        await settle();
        expect(peak).toBe(4);
        while (gates.length > 0) {
            gates.shift()?.();
            await settle();
        }
        await all;
        expect(storageDownload).toHaveBeenCalledTimes(10);
        expect(peak).toBe(4);
    });
});
