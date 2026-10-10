import { getDb } from '@/sync/db';
import { foreignMarkIds } from '@/sync/opOwnership';
import type { Annotation } from '@/types/models';

/**
 * The marks an export bakes in: what `userId`'s viewer draws, read from the
 * device's mirror. Another account's unsynced changes queued on this device
 * (an expired session, a guest who signed in to their own account) are left
 * out, as the viewer leaves them out — see AnnotationStore.foreign.
 */
export const loadExportAnnotations = async (
    docId: string,
    userId: string | null,
    pageIndex?: number,
): Promise<Annotation[]> => {
    const db = getDb();
    const [rows, foreign] = await Promise.all([
        db.annotations.where('docId').equals(docId).toArray(),
        foreignMarkIds(db, docId, userId),
    ]);
    return rows
        .filter((row) => !row.deletedAt && !foreign.has(row.id) && (pageIndex === undefined || row.page === pageIndex))
        .map(({ pending: _pending, ...a }) => a);
};
