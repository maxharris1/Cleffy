import { unsavedMarksFor } from '@/sync/annotationStore';
import { getDb } from '@/sync/db';
import { foreignMarkIds } from '@/sync/opOwnership';
import type { Annotation } from '@/types/models';

/**
 * The marks an export bakes in: what `userId`'s viewer draws, read from the
 * device's mirror. Another account's unsynced changes queued on this device
 * (an expired session, a guest who signed in to their own account) are left
 * out, as the viewer leaves them out — see AnnotationStore.foreign.
 *
 * Marks the open viewer could not write to the mirror (a full disk; see
 * AnnotationStore.hasPersistFailure) are taken from its memory instead: Export
 * is what the "couldn't be saved" banner offers to keep them, so it must not
 * read the older copy, or none at all.
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
    const marks = new Map<string, Annotation>(rows.map(({ pending: _pending, ...a }) => [a.id, a]));
    for (const unsaved of unsavedMarksFor(docId)) {
        marks.set(unsaved.id, unsaved);
    }
    return [...marks.values()].filter(
        (a) => !a.deletedAt && !foreign.has(a.id) && (pageIndex === undefined || a.page === pageIndex),
    );
};
