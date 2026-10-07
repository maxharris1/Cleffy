import { isCloudDocId } from '@/features/library/documentsService';
import { localDateString, type LocalAnnotationSnapshot } from '@/features/viewer/history/snapshotTypes';
import { getSupabase } from '@/lib/supabase';
import { getDb, type ScribblerDb } from '@/sync/db';
import type { AnnotationSnapshotRow } from '@/types/database';
import type { Annotation } from '@/types/models';

/**
 * Capture today's starting-point snapshot if one does not already exist.
 * `preEdit` must be the live annotation set *before* the triggering edit.
 */
export const ensureDayStartingSnapshot = async (
    db: ScribblerDb,
    docId: string,
    preEdit: Annotation[],
    createdBy: string | null = null,
): Promise<LocalAnnotationSnapshot | null> => {
    const capturedOn = localDateString();
    const snapshot: LocalAnnotationSnapshot = {
        id: crypto.randomUUID(),
        docId,
        capturedOn,
        label: null,
        payload: preEdit.map((a) => ({ ...a })),
        createdAt: new Date().toISOString(),
        createdBy,
        pending: isCloudDocId(docId) ? 1 : 0,
    };

    // Check-and-add in one rw transaction: two edits in the same tick (a
    // create applies to memory before this yields) would otherwise both see
    // "no snapshot yet", and the second add would trip the unique
    // [docId+capturedOn] index and fail the edit that called us.
    let added: boolean;
    try {
        added = await db.transaction('rw', db.annotationSnapshots, async () => {
            const existing = await db.annotationSnapshots
                .where('[docId+capturedOn]')
                .equals([docId, capturedOn])
                .first();
            if (existing) {
                return false;
            }
            await db.annotationSnapshots.add(snapshot);
            return true;
        });
    } catch (err) {
        // The day already has its starting point (another tab won the race).
        // The edit must still go through.
        if (isConstraintError(err)) {
            return null;
        }
        throw err;
    }
    if (!added) {
        return null;
    }

    if (isCloudDocId(docId)) {
        // Not awaited — the edit that triggered the capture must not wait on
        // the network. A failed upload leaves the row pending, and
        // retryPendingSnapshots picks it up on reconnect, on the next open,
        // when history is listed and before sign-out.
        void pushSnapshotRemote(db, snapshot).catch((err: unknown) => {
            console.warn('Snapshot sync failed; will retry', err);
        });
    }

    return snapshot;
};

export const listSnapshots = async (docId: string): Promise<LocalAnnotationSnapshot[]> => {
    const db = getDb();
    if (isCloudDocId(docId)) {
        // Upload first so the pull below reconciles this device's own
        // starting point against the server's choice for the day.
        await retryPendingSnapshots(db, docId).catch(() => undefined);
        await pullSnapshotsRemote(db, docId).catch(() => undefined);
    }
    const rows = await db.annotationSnapshots.where('docId').equals(docId).toArray();
    return rows.sort((a, b) => b.capturedOn.localeCompare(a.capturedOn));
};

export const getSnapshot = async (docId: string, snapshotId: string): Promise<LocalAnnotationSnapshot | null> => {
    const row = await getDb().annotationSnapshots.get(snapshotId);
    if (!row || row.docId !== docId) {
        return null;
    }
    return row;
};

/** PostgREST statuses that will not change on retry (RLS, invalid input). */
const isPermanentRejection = (status: number): boolean =>
    status >= 400 && status < 500 && ![401, 404, 408, 425, 429].includes(status);

const toLocal = (row: AnnotationSnapshotRow): LocalAnnotationSnapshot => ({
    id: row.id,
    docId: row.document_id,
    capturedOn: row.captured_on,
    label: row.label,
    payload: row.payload as Annotation[],
    createdAt: row.created_at,
    createdBy: row.created_by,
    pending: 0,
});

/**
 * Replace whatever this device holds for `row`'s day with the server's row.
 * The server keeps one snapshot per (document, day); when another device got
 * there first, its row is the day's starting point everywhere.
 */
const adoptServerSnapshot = async (db: ScribblerDb, row: LocalAnnotationSnapshot): Promise<void> => {
    await db.transaction('rw', db.annotationSnapshots, async () => {
        await db.annotationSnapshots
            .where('[docId+capturedOn]')
            .equals([row.docId, row.capturedOn])
            .filter((local) => local.id !== row.id)
            .delete();
        await db.annotationSnapshots.put(row);
    });
};

/**
 * Upload one local snapshot. Throws on a failure worth retrying (the row
 * stays pending); resolves once the day's row on the server is known and
 * mirrored locally.
 */
export const pushSnapshotRemote = async (db: ScribblerDb, snapshot: LocalAnnotationSnapshot): Promise<void> => {
    const supabase = getSupabase();
    const { data, error, status } = await supabase
        .from('annotation_snapshots')
        .upsert(
            {
                id: snapshot.id,
                document_id: snapshot.docId,
                captured_on: snapshot.capturedOn,
                label: snapshot.label,
                payload: snapshot.payload,
                created_by: snapshot.createdBy,
            },
            { onConflict: 'document_id,captured_on', ignoreDuplicates: true },
        )
        .select('id');
    if (error) {
        if (isPermanentRejection(status)) {
            // RLS refused (no longer an editor) or the payload is invalid —
            // retrying cannot help. The snapshot stays on this device as
            // history; it just stops asking to be uploaded.
            console.warn(`Snapshot ${snapshot.id} refused by the server: ${error.message}`);
            await db.annotationSnapshots.update(snapshot.id, { pending: 0 });
            return;
        }
        throw new Error(error.message);
    }
    if (data && data.length > 0) {
        await db.annotationSnapshots.update(snapshot.id, { pending: 0 });
        return;
    }

    // Nothing inserted: the day already has a row on the server — ours, from
    // an upload whose response was lost, or another device's. Mirror it.
    const existing = await supabase
        .from('annotation_snapshots')
        .select('*')
        .eq('document_id', snapshot.docId)
        .eq('captured_on', snapshot.capturedOn)
        .maybeSingle();
    if (existing.error) {
        throw new Error(existing.error.message);
    }
    if (!existing.data) {
        // Conflict reported but the row is not visible to us: leave pending.
        throw new Error('day snapshot conflict without a visible server row');
    }
    await adoptServerSnapshot(db, toLocal(existing.data));
};

let retryInFlight: Promise<void> | null = null;

/**
 * Upload every snapshot still waiting (optionally only one document's).
 * Single-flight: overlapping triggers (reconnect + open + history) share one
 * pass instead of racing duplicate uploads of the same row.
 */
export const retryPendingSnapshots = (db: ScribblerDb = getDb(), docId?: string): Promise<void> => {
    if (retryInFlight) {
        return retryInFlight;
    }
    retryInFlight = (async () => {
        try {
            // No pending index — the table holds one row per document-day and
            // is small; a filtered scan is cheaper than a schema version.
            const pending = await db.annotationSnapshots
                .filter((row) => row.pending === 1 && isCloudDocId(row.docId) && (!docId || row.docId === docId))
                .toArray();
            for (const snapshot of pending) {
                try {
                    await pushSnapshotRemote(db, snapshot);
                } catch (err) {
                    console.warn('Snapshot retry failed; will try again', err);
                }
            }
        } finally {
            retryInFlight = null;
        }
    })();
    return retryInFlight;
};

let retryInstalled = false;

/**
 * Retry pending snapshot uploads now and whenever the browser comes back
 * online. Idempotent; the viewer calls it when a cloud document opens with a
 * signed-in user, which is the earliest point an upload can succeed.
 */
export const installSnapshotRetry = (db: ScribblerDb = getDb()): void => {
    void retryPendingSnapshots(db).catch(() => undefined);
    if (retryInstalled || typeof window === 'undefined') {
        return;
    }
    retryInstalled = true;
    window.addEventListener('online', () => {
        void retryPendingSnapshots(db).catch(() => undefined);
    });
};

/** Pending day snapshots for cloud documents (sign-out counts these). */
export const countPendingSnapshots = async (db: ScribblerDb = getDb()): Promise<number> =>
    db.annotationSnapshots.filter((row) => row.pending === 1 && isCloudDocId(row.docId)).count();

/** Cap remote snapshot pull — lesson history UI is recent-first. */
export const SNAPSHOT_PULL_LIMIT = 30;

const pullSnapshotsRemote = async (db: ScribblerDb, docId: string): Promise<void> => {
    const { data, error } = await getSupabase()
        .from('annotation_snapshots')
        .select('*')
        .eq('document_id', docId)
        .order('captured_on', { ascending: false })
        .limit(SNAPSHOT_PULL_LIMIT);
    if (error) {
        throw new Error(error.message);
    }
    for (const row of data ?? []) {
        // Per row, replacing any local snapshot for the same day: a blind
        // bulkPut would now trip the unique index (and used to keep both).
        await adoptServerSnapshot(db, toLocal(row));
    }
};

const isConstraintError = (err: unknown): boolean => {
    if (!err || typeof err !== 'object') {
        return false;
    }
    const e = err as { name?: string; inner?: { name?: string } };
    return e.name === 'ConstraintError' || e.inner?.name === 'ConstraintError';
};
