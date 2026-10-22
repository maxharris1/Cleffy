import { getDb, type LocalAnnotation } from '@/sync/db';
import { isCloudDocId } from '@/sync/docIds';
import { heldMarksFor, openMarksFor, supersededBy } from '@/sync/inkRecovery';
import { foreignMarkIds } from '@/sync/opOwnership';
import type { Annotation } from '@/types/models';

/**
 * The marks an export bakes in: what `userId`'s viewer draws, read from the
 * device's mirror. Another account's unsynced changes queued on this device
 * (an expired session, a guest who signed in to their own account) are left
 * out, as the viewer leaves them out — see AnnotationStore.foreign.
 *
 * Marks `userId` drew that this device could not write to the mirror (a full
 * disk; see inkRecovery) are taken from memory instead: Export is what the
 * "couldn't be saved" banner offers to keep them, so it must not read the
 * older copy, or none at all. Only `userId`'s own — another account's held
 * ink in this tab never reaches its export — and not where a later write on
 * this device has replaced one (supersededBy). A device-only score's viewer
 * draws for no account, so its held ink is under none, whoever is signed in.
 *
 * When the database cannot be read at all — the failure that held the marks
 * may be a closed or broken database — the open viewer's memory is the
 * export: every mark it draws, held ones included. With no viewer open, the
 * held marks alone (and a warning).
 */
export const loadExportAnnotations = async (
    docId: string,
    userId: string | null,
    pageIndex?: number,
): Promise<Annotation[]> => {
    const wanted = (a: Annotation) => !a.deletedAt && (pageIndex === undefined || a.page === pageIndex);
    const inkAuthor = isCloudDocId(docId) ? userId : null;
    let rows: LocalAnnotation[];
    let foreign: Set<string>;
    try {
        const db = getDb();
        [rows, foreign] = await Promise.all([
            db.annotations.where('docId').equals(docId).toArray(),
            foreignMarkIds(db, docId, userId),
        ]);
    } catch (err) {
        const open = openMarksFor(inkAuthor, docId);
        console.warn(
            open
                ? 'Could not read this device’s marks; exporting what the viewer has'
                : 'Could not read this device’s marks; exporting only the unsaved ones',
            err,
        );
        return (open ?? heldMarksFor(inkAuthor, docId)).filter(wanted);
    }
    const mirror = new Map(rows.map((row) => [row.id, row]));
    const marks = new Map<string, Annotation>(rows.map(({ pending: _pending, ...a }) => [a.id, a]));
    for (const held of heldMarksFor(inkAuthor, docId)) {
        if (!supersededBy(held, mirror.get(held.id))) {
            marks.set(held.id, held);
        }
    }
    return [...marks.values()].filter((a) => wanted(a) && !foreign.has(a.id));
};
