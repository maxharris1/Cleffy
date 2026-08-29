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

/**
 * Cache a document's bytes, returning whether they actually landed. Legacy
 * Blob rows are normalized on the way through, so any write path also
 * migrates a row that a pre-ArrayBuffer build left behind.
 */
export const putCachedPdf = async (row: CachedPdf): Promise<boolean> => {
    try {
        await getDb().pdfCache.put({ ...row, bytes: await readCachedPdfBytes(row.bytes) });
        return true;
    } catch (err) {
        // Private browsing, a denied quota, evicted storage — all mean "no
        // offline copy", none mean "this score is unopenable".
        console.warn('Could not cache score for offline use', err);
        return false;
    }
};
