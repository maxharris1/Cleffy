import { THUMB_MAX_SIDE } from '@/features/library/thumbnailSize';
import { getDb } from '@/sync/db';

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
 * Renders run one at a time. Each render spins up its own pdf.js worker and
 * a full-page canvas, so a library of fifty scores rendering in parallel is a
 * reliable way to hit the iOS per-tab canvas-memory ceiling and lose the tab.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * First-page PNG for a library row, or null when there is nothing to show yet.
 *
 * Strictly offline: the bytes come from the Dexie PDF cache and nowhere else.
 * A score whose bytes have never been downloaded gets no thumbnail rather than
 * a background download — the library must not turn a scroll into fifty
 * multi-megabyte fetches, and a metered connection must not pay for art.
 */
export const getThumbnail = (docId: string, contentRev: number): Promise<Blob | null> => {
    // Synchronous, before any await: two rows mounting in the same tick must
    // find each other here, not both fall through to a render.
    const existing = inFlight.get(docId);
    if (existing) {
        return existing;
    }
    const pending = resolveThumbnail(docId, contentRev).finally(() => {
        inFlight.delete(docId);
    });
    inFlight.set(docId, pending);
    return pending;
};

const resolveThumbnail = async (docId: string, contentRev: number): Promise<Blob | null> => {
    const db = getDb();
    const thumb = await db.thumbnails.get(docId);
    // `?? 0` is load-bearing: rows cached before the shelf existed have no
    // maxSide at all, and `undefined < THUMB_MAX_SIDE` is false — reading the
    // field raw would keep serving 256px renders into a 208px cover forever.
    const tooSmall = (thumb?.maxSide ?? 0) < THUMB_MAX_SIDE;
    if (thumb && thumb.contentRev >= contentRev && !tooSmall) {
        return thumb.blob;
    }

    const key = `${docId}:${contentRev}`;
    if (failed.has(key)) {
        return thumb?.blob ?? null;
    }

    const cached = await db.pdfCache.get(docId);
    if (!cached) {
        // A stale thumbnail beats an empty box: the title has not changed.
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
    if (thumb && thumb.contentRev >= bytesRev && !tooSmall) {
        return thumb.blob;
    }

    const render = queue.then(async (): Promise<Blob | null> => {
        try {
            // Dynamic: this is the boundary that keeps pdf.js out of the shell.
            const { renderFirstPagePng } = await import('@/features/library/thumbnailRender');
            const { blob, width, height } = await renderFirstPagePng(await cached.bytes.arrayBuffer());
            await db.thumbnails.put({
                docId,
                // Tag the render with the revision the BYTES carry, not the one
                // asked for — otherwise a stale cache would mint a thumbnail
                // claiming to be current and never regenerate.
                contentRev: cached.contentRev ?? 0,
                // Stamped so a future bump to THUMB_MAX_SIDE invalidates this row.
                maxSide: THUMB_MAX_SIDE,
                blob,
                width,
                height,
                createdAt: new Date().toISOString(),
            });
            return blob;
        } catch {
            // Best-effort decoration: a thumbnail is never worth an error state.
            failed.add(key);
            return thumb?.blob ?? null;
        }
    });
    queue = render.catch(() => undefined);
    return render;
};
