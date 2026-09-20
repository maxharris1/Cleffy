import { groupStrokeIds, type StrokeGroup } from '@/features/viewer/ink/handwriting/grouper';
import type { AnnotationStore } from '@/sync/annotationStore';
import type { Annotation, TextPayload } from '@/types/models';

/**
 * Swap a group of committed strokes for ONE print `text` annotation.
 *
 * `kind` cannot be patched, so this is delete + create inside a nested undo
 * batch: Cmd+Z restores the handwriting and removes the print in one step,
 * even if an eraser/drag/pinch batch is already open. Remote peers see the
 * ordinary DELETE and INSERT broadcasts — no new wire event.
 *
 * Returns the created annotation, or null when any stroke of the group is no
 * longer live (erased, undone, or replaced by a peer) — then nothing changes:
 * strokes already deleted in this attempt are restored and the batch is dropped.
 */
export const convertGroupToText = async (
    store: AnnotationStore,
    group: StrokeGroup,
    payload: TextPayload,
): Promise<Annotation | null> => {
    const ids = groupStrokeIds(group);
    for (const id of ids) {
        const live = store.get(id);
        if (!live || live.deletedAt || live.kind !== 'stroke') {
            return null;
        }
    }
    const now = new Date().toISOString();
    const text: Annotation = {
        id: crypto.randomUUID(),
        docId: store.docId,
        page: group.page,
        kind: 'text',
        color: group.color,
        payload: { ...payload, hw: 1 },
        createdBy: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        seq: 0,
    };
    store.beginBatch();
    const deleted: string[] = [];
    try {
        for (const id of ids) {
            const live = store.get(id);
            if (!live || live.deletedAt || live.kind !== 'stroke') {
                for (const gone of deleted) {
                    await store.restore(gone);
                }
                store.cancelBatch();
                return null;
            }
            await store.delete(id);
            deleted.push(id);
        }
        await store.create(text);
        store.endBatch();
        return text;
    } catch (err) {
        for (const gone of deleted) {
            await store.restore(gone);
        }
        store.cancelBatch();
        throw err;
    }
};
