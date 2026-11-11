import { getDb, type LocalAnnotation } from '@/sync/db';
import { isCloudDocId } from '@/sync/docIds';
import { heldInkForExport, openMarksFor, overtakes } from '@/sync/inkRecovery';
import { foreignMarkIds } from '@/sync/opOwnership';
import type { Annotation } from '@/types/models';

/** The marks an export bakes in, and what the user must be told about them. */
export interface ExportMarks {
    annotations: Annotation[];
    /**
     * Set when the export leaves marks out: this device's storage could not
     * be read and no viewer of the score is open, so only the marks not yet
     * saved (still in memory) are in it — `unsaved` of them.
     */
    incomplete: { unsaved: number } | null;
    /**
     * This account's unsaved versions of marks a newer version overtook
     * (inkRecovery.overtakes): baked in beside the newer one, so both show.
     */
    conflicts: number;
    /** Of this account's unsaved erases, those a newer version overtook: nothing to draw, but said. */
    erasedConflicts?: number;
    /**
     * Set when `userId` has signed out and this tab still holds its unsaved
     * marks (inkRecovery.retireAccountInk): the export has only those —
     * `unsaved` of them — not the score's saved marks, which are no longer
     * its own to read here.
     */
    signedOut?: { unsaved: number } | null;
    /**
     * Set when the score was lost to this device (removed from it, deleted by
     * someone else, access taken back) and this tab still holds unsaved marks
     * of it (inkRecovery.closeDocInk): the export has only those.
     */
    lostAccess?: { unsaved: number } | null;
}

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
 * ink in this tab never reaches its export. A device-only score's viewer
 * draws for no account, so its held ink is under none, whoever is signed in.
 *
 * A held mark a newer version has overtaken (another tab's edit, stored or
 * uploaded) does not replace or hide that version: both are baked in, the
 * user's under an id of its own, and `conflicts` says so.
 *
 * When the database cannot be read at all — the failure that held the marks
 * may be a closed or broken database — the open viewer's memory is the
 * export: every mark it draws, held ones included. With no viewer open, the
 * held marks alone, and `incomplete` says so.
 */
export const loadExportMarks = async (
    docId: string,
    userId: string | null,
    pageIndex?: number,
    /** Export the ink this tab kept of a score lost to this device (inkRecovery.closeDocInk). */
    { lostAccess = false }: { lostAccess?: boolean } = {},
): Promise<ExportMarks> => {
    const wanted = (a: Annotation) => !a.deletedAt && (pageIndex === undefined || a.page === pageIndex);
    const inkAuthor = isCloudDocId(docId) ? userId : null;
    const ink = heldInkForExport(inkAuthor, docId, lostAccess);
    const kept = ink.conflicts.map(asConflict).filter(wanted);
    const erasedConflicts = ink.conflicts.filter(
        (a) => a.deletedAt && (pageIndex === undefined || a.page === pageIndex),
    ).length;
    if (lostAccess) {
        // Purged here: only the unsaved marks this tab kept are left to export.
        const held = ink.held.filter(wanted);
        return {
            annotations: [...held, ...kept],
            incomplete: null,
            conflicts: kept.length,
            erasedConflicts,
            lostAccess: { unsaved: held.length + kept.length },
        };
    }
    if (ink.signedOut) {
        // Signed out: only its own unsaved marks are its to export here.
        const held = ink.held.filter(wanted);
        return {
            annotations: [...held, ...kept],
            incomplete: null,
            conflicts: kept.length,
            erasedConflicts,
            signedOut: { unsaved: held.length + kept.length },
        };
    }
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
        const held = (open ?? ink.held).filter(wanted);
        return {
            annotations: [...held, ...kept],
            incomplete: open ? null : { unsaved: held.length + kept.length },
            conflicts: kept.length,
            erasedConflicts,
        };
    }
    const mirror = new Map(rows.map((row) => [row.id, row]));
    const marks = new Map<string, Annotation>(rows.map(({ pending: _pending, ...a }) => [a.id, a]));
    const overtaken: Annotation[] = [];
    for (const [id, { base, latest }] of ink.chains) {
        if (overtakes(mirror.get(id), base, latest)) {
            overtaken.push(asConflict(latest));
        } else {
            marks.set(id, latest);
        }
    }
    const conflicts = [...kept, ...overtaken.filter(wanted)];
    return {
        annotations: [...[...marks.values()].filter((a) => wanted(a) && !foreign.has(a.id)), ...conflicts],
        incomplete: null,
        conflicts: conflicts.length,
        erasedConflicts,
    };
};

/** loadExportMarks' marks alone. */
export const loadExportAnnotations = async (
    docId: string,
    userId: string | null,
    pageIndex?: number,
    options?: { lostAccess?: boolean },
): Promise<Annotation[]> => (await loadExportMarks(docId, userId, pageIndex, options)).annotations;

/** An overtaken mark's unsaved version, baked in beside the newer one under an id of its own. */
const asConflict = (held: Annotation): Annotation => ({ ...held, id: `${held.id}:unsaved` });

const marksWord = (n: number): string => (n === 1 ? 'mark' : 'marks');

/**
 * What the export menu tells the user about an export that is not simply
 * every mark: one that leaves marks out (and which), or that has two
 * versions of some. Null when it is complete and has no conflicts.
 */
export const exportNotice = ({
    incomplete,
    conflicts,
    erasedConflicts = 0,
    signedOut = null,
    lostAccess = null,
}: Pick<ExportMarks, 'incomplete' | 'conflicts' | 'erasedConflicts' | 'signedOut' | 'lostAccess'>): string | null => {
    const parts: string[] = [];
    if (signedOut) {
        parts.push(
            `You’re signed out, so this export has only the ${signedOut.unsaved} unsaved ${marksWord(signedOut.unsaved)} this tab still holds, not the score’s saved marks.`,
        );
    }
    if (lostAccess) {
        parts.push(
            `You no longer have this score, so this export has only the ${lostAccess.unsaved} unsaved ${marksWord(lostAccess.unsaved)} still on this device, not the score’s saved marks.`,
        );
    }
    if (incomplete) {
        parts.push(
            `This export is missing marks. This device’s storage couldn’t be read, so it has only the ${incomplete.unsaved} unsaved ${marksWord(incomplete.unsaved)} this tab still holds, not the score’s saved marks.`,
        );
    }
    if (conflicts > 0) {
        parts.push(
            conflicts === 1
                ? 'One of your unsaved marks changed elsewhere before it could be saved here: the export has both versions.'
                : `${conflicts} of your unsaved marks changed elsewhere before they could be saved here: the export has both versions.`,
        );
    }
    if (erasedConflicts > 0) {
        // Signed out, the export has only the unsaved marks (the PDF still
        // builds: a signed-out export claims nothing), so the newer version
        // that overtook an erase is not in it and the copy must not say so.
        if (signedOut || lostAccess) {
            parts.push(
                erasedConflicts === 1
                    ? 'One of your unsaved erases was overtaken by a newer version made elsewhere. That version is a saved mark, so it isn’t in this export.'
                    : `${erasedConflicts} of your unsaved erases were overtaken by newer versions made elsewhere. Those versions are saved marks, so they aren’t in this export.`,
            );
        } else {
            parts.push(
                erasedConflicts === 1
                    ? 'One of your unsaved erases was overtaken by a newer version made elsewhere: the export shows that version.'
                    : `${erasedConflicts} of your unsaved erases were overtaken by newer versions made elsewhere: the export shows those versions.`,
            );
        }
    }
    return parts.length > 0 ? parts.join(' ') : null;
};
