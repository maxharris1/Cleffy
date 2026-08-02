import { isCloudDocId } from '@/features/library/documentsService';
import {
    localDateString,
    type LocalAnnotationSnapshot,
} from '@/features/viewer/history/snapshotTypes';
import { getSupabase } from '@/lib/supabase';
import { getDb, type ScribblerDb } from '@/sync/db';
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
    const existing = await db.annotationSnapshots.where('[docId+capturedOn]').equals([docId, capturedOn]).first();
    if (existing) {
        return null;
    }

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

    await db.annotationSnapshots.put(snapshot);

    if (isCloudDocId(docId)) {
        void pushSnapshotRemote(db, snapshot).catch((err: unknown) => {
            console.warn('Snapshot sync failed', err);
        });
    }

    return snapshot;
};

export const listSnapshots = async (docId: string): Promise<LocalAnnotationSnapshot[]> => {
    const db = getDb();
    if (isCloudDocId(docId)) {
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

const pushSnapshotRemote = async (db: ScribblerDb, snapshot: LocalAnnotationSnapshot): Promise<void> => {
    const { error } = await getSupabase().from('annotation_snapshots').upsert(
        {
            id: snapshot.id,
            document_id: snapshot.docId,
            captured_on: snapshot.capturedOn,
            label: snapshot.label,
            payload: snapshot.payload,
            created_by: snapshot.createdBy,
        },
        { onConflict: 'document_id,captured_on', ignoreDuplicates: true },
    );
    if (error) {
        throw new Error(error.message);
    }
    await db.annotationSnapshots.update(snapshot.id, { pending: 0 });
};

const pullSnapshotsRemote = async (db: ScribblerDb, docId: string): Promise<void> => {
    const { data, error } = await getSupabase()
        .from('annotation_snapshots')
        .select('*')
        .eq('document_id', docId)
        .order('captured_on', { ascending: false });
    if (error) {
        throw new Error(error.message);
    }
    if (!data || data.length === 0) {
        return;
    }
    const rows: LocalAnnotationSnapshot[] = data.map((row) => ({
        id: row.id,
        docId: row.document_id,
        capturedOn: row.captured_on,
        label: row.label,
        payload: row.payload as Annotation[],
        createdAt: row.created_at,
        createdBy: row.created_by,
        pending: 0,
    }));
    await db.annotationSnapshots.bulkPut(rows);
};
