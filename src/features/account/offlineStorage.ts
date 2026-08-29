import { getDb } from '@/sync/db';
import { cachedPdfSize } from '@/sync/pdfCache';

export interface OfflineStorageUsage {
    /** Scores whose PDF bytes are held on this device. */
    scoreCount: number;
    /** Bytes held by cached PDFs and their first-page thumbnails combined. */
    bytes: number;
}

/**
 * How much of this device the offline cache is using.
 *
 * Read with Dexie's cursor walk rather than `toArray()`: a teacher with fifty
 * cached scores would otherwise hold every PDF in memory at once just to add up
 * their sizes. `each` hands back one row at a time and lets the previous one go,
 * so peak memory is one score rather than the whole library.
 */
export const readOfflineStorage = async (): Promise<OfflineStorageUsage> => {
    const db = getDb();
    let scoreCount = 0;
    let bytes = 0;
    await db.pdfCache.each((row) => {
        scoreCount += 1;
        bytes += cachedPdfSize(row.bytes);
    });
    await db.thumbnails.each((row) => {
        bytes += row.blob?.size ?? 0;
    });
    return { scoreCount, bytes };
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
    const db = getDb();
    await db.pdfCache.clear();
    await db.thumbnails.clear();
};

/** Megabytes to one decimal — the only precision worth showing for a cache. */
export const formatMegabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;
