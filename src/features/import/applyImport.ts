import type { ProposedItem } from '@/features/import/importTypes';
import type { AnnotationStore } from '@/sync/annotationStore';

/**
 * Commit accepted proposals as native annotations — ONE undo batch, through
 * the store's single write path (Dexie mirror + outbox + realtime for free).
 * The review overlay must be cleared first: commit() is a no-op in history
 * mode (annotationStore.ts), so creating while overlaid would silently drop.
 */
export const applyProposals = async (store: AnnotationStore, items: ProposedItem[]): Promise<number> => {
    if (store.isHistoryMode) {
        store.setHistoryOverlay(null);
    }
    store.beginBatch();
    let created = 0;
    try {
        for (const item of items) {
            for (const annotation of item.annotations) {
                await store.create(annotation);
                created++;
            }
        }
    } finally {
        store.endBatch();
    }
    return created;
};
