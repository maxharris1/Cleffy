import { groupStrokeIds, type StrokeGroup } from '@/features/viewer/ink/handwriting/grouper';
import type { AnnotationStore } from '@/sync/annotationStore';
import type { Annotation, TextPayload } from '@/types/models';

/**
 * Swap a group of committed strokes for ONE print `text` annotation.
 *
 * `kind` cannot be patched, so this is delete + create inside a single undo
 * batch: Cmd+Z restores the handwriting and removes the print in one step,
 * exactly like an eraser drag of several marks. Remote peers see the ordinary
 * DELETE and INSERT broadcasts — no new wire event.
 *
 * Returns the created annotation, or null when any stroke of the group is no
 * longer live (erased, undone, or replaced by a peer) — then nothing changes.
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
    try {
        for (const id of ids) {
            await store.delete(id);
        }
        await store.create(text);
    } finally {
        store.endBatch();
    }
    return text;
};
