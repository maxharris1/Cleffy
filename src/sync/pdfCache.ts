import { getDb, type CachedPdf, type CachedPdfBytes } from '@/sync/db';

/**
 * Offline PDF cache access, isolated here because storing bytes in IndexedDB
 * is the one Dexie write that browsers routinely refuse.
 *
 * WebKit backs IndexedDB Blobs with files on disk, and a private-browsing
 * origin has no such disk — every `put` of a Blob there rejects with
 * `UnknownError: Error preparing Blob/File data to be stored in object store`.
 * So bytes go in as ArrayBuffers (structured-cloned into the record itself,
 * no file backing) and every write is best-effort: the cache is an offline
 * nicety, and losing it must never stop a score from opening.
 */

/**
 * A cached row, or null when there isn't one. A browser that refuses
 * IndexedDB outright (Safari with all cookies blocked) throws on the read
 * rather than returning nothing; that is still just a cache miss.
 */
export const getCachedPdf = async (docId: string): Promise<CachedPdf | null> => {
    try {
        return (await getDb().pdfCache.get(docId)) ?? null;
    } catch (err) {
        console.warn('Could not read the offline score cache', err);
        return null;
    }
};

/** ArrayBuffer view of a cached row's bytes, whichever shape it was stored in. */
export const readCachedPdfBytes = async (bytes: CachedPdfBytes): Promise<ArrayBuffer> =>
    bytes instanceof Blob ? bytes.arrayBuffer() : bytes;

/** Size of a cached row's bytes, without reading them. */
export const cachedPdfSize = (bytes: CachedPdfBytes | undefined): number =>
    bytes instanceof Blob ? bytes.size : (bytes?.byteLength ?? 0);

/**
 * Cache a document's bytes, returning whether they actually landed. Legacy
 * Blob rows are normalized on the way through, so any write path also
 * migrates a row that a pre-ArrayBuffer build left behind.
 *
 * A row passing to another account (fetchMyRole stamps whoever opens the
 * score online) first hands the score's unstamped ops to the account it
 * leaves. Those predate PendingOp.userId, and opOwnerFor counts them as the
 * cache owner's: restamped as they were, they would become the next
 * account's, and its viewer would upload them under its own name.
 */
export const putCachedPdf = async (row: CachedPdf): Promise<boolean> => {
    try {
        const db = getDb();
        const bytes = await readCachedPdfBytes(row.bytes);
        const previous = (await db.pdfCache.get(row.docId))?.userId;
        if (previous !== undefined && previous !== row.userId) {
            await db.ops
                .where('docId')
                .equals(row.docId)
                .filter((op) => op.userId === undefined)
                .modify({ userId: previous });
        }
        await db.pdfCache.put({ ...row, bytes });
        return true;
    } catch (err) {
        // Private browsing, a denied quota, evicted storage — all mean "no
        // offline copy", none mean "this score is unopenable".
        console.warn('Could not cache score for offline use', err);
        return false;
    }
};

/**
 * Score downloads that outlived the viewer which started them, each still on
 * its way to becoming the offline copy (see cacheStreamedDocument). Every
 * path that removes offline copies (purging one score, sign-out, clearing the
 * downloads) stops them first, so none writes a copy back after it.
 */
const finishing = new Map<string, () => void>();

/**
 * Let `complete` finish after its viewer closed, then `write` it. `abort`
 * stops the download when the write is no longer wanted; `write` is handed a
 * check to make after each of its awaits. One per score: a newer one replaces
 * an older one.
 */
export const finishPdfCacheInBackground = (
    docId: string,
    complete: Promise<ArrayBuffer>,
    abort: () => void,
    write: (bytes: ArrayBuffer, isCancelled: () => boolean) => Promise<void>,
): void => {
    finishing.get(docId)?.();
    let cancelled = false;
    const cancel = () => {
        if (cancelled) {
            return;
        }
        cancelled = true;
        if (finishing.get(docId) === cancel) {
            finishing.delete(docId);
        }
        abort();
    };
    finishing.set(docId, cancel);
    complete
        .then(async (bytes) => {
            if (!cancelled) {
                await write(bytes, () => cancelled);
            }
        })
        .catch((err: unknown) => {
            if (!cancelled) {
                console.warn('Could not finish downloading the score for offline use', err);
            }
        })
        .finally(() => {
            if (finishing.get(docId) === cancel) {
                finishing.delete(docId);
            }
        });
};

/** Stop the background download of one score, or of every score. */
export const cancelBackgroundPdfCache = (docId?: string): void => {
    if (docId !== undefined) {
        finishing.get(docId)?.();
        return;
    }
    for (const cancel of [...finishing.values()]) {
        cancel();
    }
};
