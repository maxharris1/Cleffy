import {
    fetchPublishedThumbnail,
    noteThumbnailObjectMissing,
    publishThumbnail,
    shouldPublishThumbnail,
} from '@/features/library/thumbnailRemote';
import { THUMB_MAX_SIDE } from '@/features/library/thumbnailSize';
import { getDb } from '@/sync/db';
import { getCachedPdf, readCachedPdfBytes } from '@/sync/pdfCache';

/**
 * Renders in flight, keyed by docId — concurrent rows asking for the same
 * score share one render instead of racing each other into Dexie.
 */
const inFlight = new Map<string, Promise<Blob | null>>();

/**
 * `${docId}:${contentRev}` pairs whose render already failed. Session-scoped
 * and deliberately not persisted: a corrupt or unsupported PDF would otherwise
 * re-run pdf.js on every scroll, and a fixed one recovers on the next reload.
 */
const failed = new Set<string>();

/**
 * Renders this session produced but could not store, keyed by
 * `${docId}:${bytesRev}:${maxSide}`. A browser that refuses the Dexie write —
 * WebKit private browsing cannot back an IndexedDB Blob with a file, and a
 * denied quota fails the same way — would otherwise re-run pdf.js every time
 * a row scrolls back into view, since nothing was ever persisted to find.
 *
 * Capped, and evicted oldest-first: this stands in for a store that refused
 * us, so it must not become the unbounded one. A teacher scrolling a library
 * of fifty scores would otherwise pin every cover in memory for the life of
 * the tab — on iOS, the same budget the render queue below exists to protect.
 */
const unstored = new Map<string, Blob>();

/** Roughly two screens of covers — enough that scrolling back is free. */
const UNSTORED_LIMIT = 24;

const rememberUnstored = (key: string, blob: Blob): void => {
    unstored.set(key, blob);
    while (unstored.size > UNSTORED_LIMIT) {
        // Map iterates in insertion order, so the first key is the oldest.
        const oldest = unstored.keys().next();
        if (oldest.done) {
            return;
        }
        unstored.delete(oldest.value);
    }
};

/**
 * Renders run one at a time. Each render spins up its own pdf.js worker and
 * a full-page canvas, so a library of fifty scores rendering in parallel is a
 * reliable way to hit the iOS per-tab canvas-memory ceiling and lose the tab.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * First-page image for a library row, or null when there is nothing to show yet.
 *
 * Two sources, in order. The Dexie PDF cache: a score whose bytes are on this
 * device is rendered here (and, when this browser is the owner's and nothing
 * newer is published, the render is published for everyone else). Otherwise
 * the published copy: `thumbRev` is documents.thumb_rev, the revision of the
 * cover in the `thumbnails` bucket, null for none. What this never does is
 * download the PDF itself — the library must not turn a scroll into fifty
 * multi-megabyte fetches, and a metered connection must not pay for art.
 */
export const getThumbnail = (
    docId: string,
    contentRev: number,
    thumbRev: number | null = null,
): Promise<Blob | null> => {
    // Synchronous, before any await: two rows mounting in the same tick must
    // find each other here, not both fall through to a render.
    const existing = inFlight.get(docId);
    if (existing) {
        return existing;
    }
    const pending = resolveThumbnail(docId, contentRev, thumbRev).finally(() => {
        inFlight.delete(docId);
    });
    inFlight.set(docId, pending);
    return pending;
};

const resolveThumbnail = async (docId: string, contentRev: number, thumbRev: number | null): Promise<Blob | null> => {
    const db = getDb();
    const thumb = await db.thumbnails.get(docId).catch(() => undefined);
    // `?? 0` is load-bearing: rows cached before the shelf existed have no
    // maxSide at all, and `undefined < THUMB_MAX_SIDE` is false — reading the
    // field raw would keep serving 256px renders into a 208px cover forever.
    const tooSmall = (thumb?.maxSide ?? 0) < THUMB_MAX_SIDE;
    if (thumb && thumb.contentRev >= contentRev && !tooSmall) {
        if (shouldPublishThumbnail(docId, thumb.contentRev, thumbRev)) {
            if (thumb.blob.type === 'image/jpeg') {
                // Rendered here earlier, never published (the feature is newer
                // than the render, or the upload failed on another device).
                void publishThumbnail(docId, thumb.contentRev, thumb.blob);
            } else if (await getCachedPdf(docId)) {
                // A PNG from before the JPEG encoder; the bucket takes JPEG only.
                // Fall through to render it again from the bytes, once — the
                // publish attempt is remembered whether or not it succeeds.
                return renderAndStore(docId, contentRev, thumbRev, thumb, true);
            }
        } else if (thumbRev === thumb.contentRev && thumb.blob.type === 'image/jpeg') {
            // Row says this revision is published, but the object may be gone.
            // One probe per session; a 404 republishes the local JPEG.
            void verifyPublishedOrRepublish(docId, thumb.contentRev, thumb.blob);
        }
        return thumb.blob;
    }

    const key = `${docId}:${contentRev}`;
    if (failed.has(key)) {
        return thumb?.blob ?? null;
    }

    const cached = await getCachedPdf(docId);
    if (!cached) {
        // Not on this device. The published copy, if there is one newer than
        // what we hold — else a stale thumbnail beats an empty box: the title
        // has not changed.
        const haveRev = thumb && !tooSmall ? thumb.contentRev : -1;
        if (thumbRev !== null && thumbRev > haveRev) {
            return fetchAndStore(docId, thumbRev, thumb);
        }
        return thumb?.blob ?? null;
    }
    return renderAndStore(docId, contentRev, thumbRev, thumb);
};

/**
 * `${docId}:${rev}` pairs already probed for a published object this session.
 * A current local JPEG must not download on every scroll just to learn the
 * object is still there.
 */
const publishedProbed = new Set<string>();

/** Row names this rev, local JPEG is current — confirm the object, republish on 404. */
const verifyPublishedOrRepublish = async (docId: string, contentRev: number, localJpeg: Blob): Promise<void> => {
    const key = `${docId}:${contentRev}`;
    if (publishedProbed.has(key)) {
        return;
    }
    publishedProbed.add(key);
    const published = await fetchPublishedThumbnail(docId, contentRev);
    if (published) {
        return;
    }
    noteThumbnailObjectMissing(docId, contentRev);
    if (shouldPublishThumbnail(docId, contentRev, contentRev, true)) {
        await publishThumbnail(docId, contentRev, localJpeg);
    }
};

/** Published cover → Dexie → caller. A miss is remembered for the session like a failed render. */
const fetchAndStore = async (
    docId: string,
    thumbRev: number,
    fallback: { blob: Blob; contentRev?: number } | undefined,
): Promise<Blob | null> => {
    const key = `${docId}:remote:${thumbRev}`;
    if (failed.has(key)) {
        return fallback?.blob ?? null;
    }
    const blob = await fetchPublishedThumbnail(docId, thumbRev);
    if (!blob) {
        failed.add(key);
        noteThumbnailObjectMissing(docId, thumbRev);
        // The row still points at this revision, but the object is gone —
        // republish only a JPEG that was rendered at this same revision.
        if (
            fallback?.blob.type === 'image/jpeg' &&
            fallback.contentRev === thumbRev &&
            shouldPublishThumbnail(docId, thumbRev, thumbRev, true)
        ) {
            void publishThumbnail(docId, thumbRev, fallback.blob);
        }
        return fallback?.blob ?? null;
    }
    try {
        await getDb().thumbnails.put({
            docId,
            contentRev: thumbRev,
            maxSide: THUMB_MAX_SIDE,
            blob,
            // Not decoded here — the cover is object-fit anyway, and decoding
            // a hundred images to learn their size would cost what the fetch saved.
            width: 0,
            height: 0,
            createdAt: new Date().toISOString(),
        });
    } catch {
        rememberUnstored(`${docId}:${thumbRev}:${THUMB_MAX_SIDE}`, blob);
    }
    return blob;
};

const renderAndStore = async (
    docId: string,
    contentRev: number,
    thumbRev: number | null,
    thumb: { blob: Blob; contentRev: number; maxSide?: number } | undefined,
    /** Re-encode even though the stored render is current (legacy PNG → publishable JPEG). */
    reencode = false,
): Promise<Blob | null> => {
    const db = getDb();
    const key = `${docId}:${contentRev}`;
    const tooSmall = (thumb?.maxSide ?? 0) < THUMB_MAX_SIDE;
    const cached = await getCachedPdf(docId);
    if (!cached) {
        return thumb?.blob ?? null;
    }

    // The bytes on this device can lag the revision the row asks for: a replace
    // (smart-import cleanup) on another device bumps content_rev long before
    // those bytes are ever downloaded here, and rows seeded by uploadDocument
    // carry no contentRev at all. Rendering them again would reproduce, byte for
    // byte, the PNG already stored — and because the write below stamps the
    // BYTES' revision, the check above could never be satisfied, so every single
    // library visit paid another pdf.js document open. Serve what we have; the
    // check above takes over as soon as ensureLocalPdf caches the newer bytes.
    const bytesRev = cached.contentRev ?? 0;
    if (!reencode && thumb && thumb.contentRev >= bytesRev && !tooSmall) {
        return thumb.blob;
    }

    // Rendered earlier this session but never stored — serve it rather than
    // paying for a second identical pdf.js pass.
    const memo = unstored.get(`${docId}:${bytesRev}:${THUMB_MAX_SIDE}`);
    if (memo && !reencode) {
        return memo;
    }

    const render = queue.then(async (): Promise<Blob | null> => {
        let png: { blob: Blob; width: number; height: number };
        try {
            // Dynamic: this is the boundary that keeps pdf.js out of the shell.
            const { renderFirstPageJpeg } = await import('@/features/library/thumbnailRender');
            png = await renderFirstPageJpeg(await readCachedPdfBytes(cached.bytes));
        } catch {
            // Best-effort decoration: a thumbnail is never worth an error state.
            failed.add(key);
            return thumb?.blob ?? null;
        }
        try {
            await db.thumbnails.put({
                docId,
                // Tag the render with the revision the BYTES carry, not the one
                // asked for — otherwise a stale cache would mint a thumbnail
                // claiming to be current and never regenerate.
                contentRev: bytesRev,
                // Stamped so a future bump to THUMB_MAX_SIDE invalidates this row.
                maxSide: THUMB_MAX_SIDE,
                blob: png.blob,
                width: png.width,
                height: png.height,
                createdAt: new Date().toISOString(),
            });
        } catch (err) {
            // Storing the PNG is the only part that failed, and the render is a
            // decoration — show it. Discarding it here left private browsing
            // with a library of blank covers.
            console.warn('Could not cache the thumbnail', err);
            rememberUnstored(`${docId}:${bytesRev}:${THUMB_MAX_SIDE}`, png.blob);
        }
        // Publish for every other device, detached: the render is on screen
        // already, and Storage RLS turns a member's attempt into a quiet no.
        if (shouldPublishThumbnail(docId, bytesRev, thumbRev)) {
            void publishThumbnail(docId, bytesRev, png.blob);
        }
        return png.blob;
    });
    queue = render.catch(() => undefined);
    return render;
};
