import { groupStrokeIds, type StrokeGroup } from '@/features/viewer/ink/handwriting/grouper';
import type { AnnotationStore } from '@/sync/annotationStore';
import type { Annotation, TextPayload } from '@/types/models';

/**
 * One convert at a time per store. Two groups that overlap at an `await`
 * (first Bravura load + two dynamics, two Gemini lines) must not both open
 * frames — `pushInverse` records into the innermost, so a nested convert
 * would glue or drop Cmd+Z.
 */
const convertTails = new WeakMap<AnnotationStore, Promise<unknown>>();

const enqueueConvert = <T>(store: AnnotationStore, task: () => Promise<T>): Promise<T> => {
    const prev = convertTails.get(store) ?? Promise.resolve();
    const run = prev.then(task, task);
    convertTails.set(
        store,
        run.then(
            () => undefined,
            () => undefined,
        ),
    );
    return run;
};

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
export const convertGroupToText = (
    store: AnnotationStore,
    group: StrokeGroup,
    payload: TextPayload,
): Promise<Annotation | null> => enqueueConvert(store, () => convertGroupToTextExclusive(store, group, payload));

const convertGroupToTextExclusive = async (
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
    const batch = store.beginBatch();
    const deleted: string[] = [];
    const abort = async (): Promise<null> => {
        for (const gone of deleted) {
            await store.restore(gone);
        }
        store.cancelBatch(batch);
        return null;
    };
    try {
        for (const id of ids) {
            const live = store.get(id);
            if (!live || live.deletedAt || live.kind !== 'stroke') {
                return abort();
            }
            const did = await store.delete(id);
            if (!did) {
                return abort();
            }
            deleted.push(id);
        }
        await store.create(text);
        store.endBatch(batch);
        return text;
    } catch (err) {
        await abort();
        throw err;
    }
};
