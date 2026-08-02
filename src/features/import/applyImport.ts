import type { ProposedItem } from '@/features/import/importTypes';
import type { AnnotationStore } from '@/sync/annotationStore';

/**
 * Commit accepted proposals as native annotations — ONE undo batch, through
 * the store's single write path (Dexie mirror + outbox + realtime for free).
 * The review overlay must be cleared first: commit() is a no-op in history
 * mode (annotationStore.ts), so creating while overlaid would silently drop.
 */
/** Items per bulk chunk — small enough for smooth progress, big enough to amortize transactions. */
const APPLY_CHUNK_ITEMS = 150;

export const applyProposals = async (
    store: AnnotationStore,
    items: ProposedItem[],
    onProgress?: (doneItems: number, totalItems: number) => void,
): Promise<number> => {
    if (store.isHistoryMode) {
        store.setHistoryOverlay(null);
    }
    store.beginBatch();
    let created = 0;
    try {
        for (let start = 0; start < items.length; start += APPLY_CHUNK_ITEMS) {
            const slice = items.slice(start, start + APPLY_CHUNK_ITEMS);
            const annotations = slice.flatMap((item) => item.annotations);
            await store.createMany(annotations);
            created += annotations.length;
            onProgress?.(Math.min(start + slice.length, items.length), items.length);
        }
    } finally {
        store.endBatch();
    }
    return created;
};
