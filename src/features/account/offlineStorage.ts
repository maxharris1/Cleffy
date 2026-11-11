import { getDb } from '@/sync/db';
import { cancelBackgroundPdfCache, readCachedPdfMeta } from '@/sync/pdfCache';

export interface OfflineStorageUsage {
    /** Scores whose PDF bytes are held on this device. */
    scoreCount: number;
    /** Bytes held by cached PDFs and their first-page thumbnails combined. */
    bytes: number;
}

/**
 * How much of this device the offline cache is using.
 *
 * Sizes come from each copy's metadata (pdfMeta): the keys are listed without
 * reading a single file, where walking pdfCache read every cached PDF in full
 * just to add up their lengths. A copy cached before pdfMeta existed is read
 * once, here, and its metadata kept.
 */
export const readOfflineStorage = async (): Promise<OfflineStorageUsage> => {
    const db = getDb();
    const docIds = await db.pdfCache.toCollection().primaryKeys();
    let bytes = 0;
    for (const docId of docIds) {
        bytes += (await readCachedPdfMeta(db, docId))?.size ?? 0;
    }
    await db.thumbnails.each((row) => {
        bytes += row.blob?.size ?? 0;
    });
    return { scoreCount: docIds.length, bytes };
};

/**
 * Drop the downloaded copies, and only those.
 *
 * `annotations`, `ops` and `syncState` are deliberately untouched: the op queue
 * can hold marks a teacher made offline that the server has never seen, and
 * clearing them would destroy work with no way to get it back. PDFs and
 * thumbnails are both re-derivable from the server, so losing them costs a
 * download and nothing more.
 */
export const clearOfflineStorage = async (): Promise<void> => {
    // Nor may a download still finishing in the background put one back.
    cancelBackgroundPdfCache();
    const db = getDb();
    await db.pdfCache.clear();
    await db.pdfMeta.clear();
    await db.thumbnails.clear();
};

/** Megabytes to one decimal — the only precision worth showing for a cache. */
export const formatMegabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;
