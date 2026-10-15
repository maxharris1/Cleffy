import { getDb, type CachedPdf, type CachedPdfBytes, type CachedPdfMeta, type ScribblerDb } from '@/sync/db';

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

/** The row's metadata, as pdfMeta stores it. */
const metaOf = (row: CachedPdf): CachedPdfMeta => {
    const { bytes, ...meta } = row;
    return { ...meta, size: cachedPdfSize(bytes) };
};

/**
 * A cached score's metadata without its bytes, read from `db` (opOwnership
 * passes its own). Metadata counts only beside a cached file — checked by key,
 * which reads none of it — so a delete that removed one and not the other
 * never makes a copy that is gone look present. A row cached before pdfMeta
 * existed is read whole this once, and its metadata kept for every later read.
 */
export const readCachedPdfMeta = async (db: ScribblerDb, docId: string): Promise<CachedPdfMeta | null> => {
    const [meta, present] = await Promise.all([db.pdfMeta.get(docId), db.pdfCache.where(':id').equals(docId).count()]);
    if (!present) {
        if (meta) {
            await db.pdfMeta.delete(docId).catch(() => undefined);
        }
        return null;
    }
    if (meta) {
        return meta;
    }
    const row = await db.pdfCache.get(docId);
    if (!row) {
        return null;
    }
    const backfill = metaOf(row);
    // add, not put: a metadata write that landed meanwhile is newer than this.
    await db.pdfMeta.add(backfill).catch(() => undefined);
    return backfill;
};

/**
 * What most callers want to know about a cached score — whose copy it is, in
 * which role, at which revision, archived or not — without reading the file.
 * Null when there is no cached copy, or IndexedDB refuses the read.
 */
export const getCachedPdfMeta = async (docId: string): Promise<CachedPdfMeta | null> => {
    try {
        return await readCachedPdfMeta(getDb(), docId);
    } catch (err) {
        console.warn('Could not read the offline score cache', err);
        return null;
    }
};

/**
 * A cached row, bytes and all, or null when there isn't one. Reads the whole
 * file: callers that do not need the bytes use getCachedPdfMeta. A browser
 * that refuses IndexedDB outright (Safari with all cookies blocked) throws on
 * the read rather than returning nothing; that is still just a cache miss.
 */
export const getCachedPdf = async (docId: string): Promise<CachedPdf | null> => {
    try {
        const db = getDb();
        const [row, meta] = await Promise.all([db.pdfCache.get(docId), db.pdfMeta.get(docId)]);
        if (!row) {
            return null;
        }
        if (!meta) {
            await db.pdfMeta.add(metaOf(row)).catch(() => undefined);
            return row;
        }
        // Metadata changes are written to pdfMeta alone, so its fields win.
        const { size: _size, ...fields } = meta;
        return { ...row, ...fields };
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
 * A row passing to another account first hands the score's unstamped ops to
 * the account it leaves. Those predate PendingOp.userId, and opOwnerFor counts
 * them as the cache owner's: restamped as they were, they would become the
 * next account's, and its viewer would upload them under its own name.
 */
const keepLegacyOpsWith = async (
    db: ScribblerDb,
    docId: string,
    previous: string | undefined,
    next: string | undefined,
): Promise<void> => {
    if (previous !== undefined && previous !== next) {
        await db.ops
            .where('docId')
            .equals(docId)
            .filter((op) => op.userId === undefined)
            .modify({ userId: previous });
    }
};

/**
 * Cache a document's bytes, returning whether they actually landed. Legacy
 * Blob rows are normalized on the way through, so any write path also
 * migrates a row that a pre-ArrayBuffer build left behind. The metadata is
 * written beside it, in the same transaction.
 */
export const putCachedPdf = async (row: CachedPdf): Promise<boolean> => {
    try {
        const db = getDb();
        // Before the transaction: awaiting a Blob read inside one would let
        // IndexedDB commit it early.
        const stored = { ...row, bytes: await readCachedPdfBytes(row.bytes) };
        await db.transaction('rw', db.pdfCache, db.pdfMeta, db.ops, async () => {
            const previous = (await readCachedPdfMeta(db, row.docId))?.userId;
            await keepLegacyOpsWith(db, row.docId, previous, row.userId);
            await db.pdfCache.put(stored);
            await db.pdfMeta.put(metaOf(stored));
        });
        return true;
    } catch (err) {
        // Private browsing, a denied quota, evicted storage — all mean "no
        // offline copy", none mean "this score is unopenable".
        console.warn('Could not cache score for offline use', err);
        return false;
    }
};

/** The metadata a cached copy can have changed without its bytes changing. */
export type CachedPdfMetaPatch = Partial<Pick<CachedPdfMeta, 'title' | 'myRole' | 'archivedAt' | 'userId'>>;

/**
 * Change a cached copy's metadata — a rename, the role or archive state the
 * server just confirmed, whose copy it is — without reading or rewriting the
 * file (384 ms for a 23 MB scan with the CPU slowed 4x, done the old way).
 * Resolves to whether there was a cached copy to change. Best-effort, like
 * every write here.
 */
export const updateCachedPdfMeta = async (docId: string, patch: CachedPdfMetaPatch): Promise<boolean> => {
    try {
        const db = getDb();
        return await db.transaction('rw', db.pdfCache, db.pdfMeta, db.ops, async () => {
            const meta = await readCachedPdfMeta(db, docId);
            if (!meta) {
                return false;
            }
            if ('userId' in patch) {
                await keepLegacyOpsWith(db, docId, meta.userId, patch.userId);
            }
            await db.pdfMeta.put({ ...meta, ...patch });
            return true;
        });
    } catch (err) {
        console.warn('Could not update the offline score cache', err);
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
