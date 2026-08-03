import { beforeEach, describe, expect, it } from 'vitest';

import { applyProposals } from '@/features/import/applyImport';
import type { ProposedItem } from '@/features/import/importTypes';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import type { Annotation } from '@/types/models';

const DOC = 'local-importdoc';

const makeAnnotation = (id: string, page = 0): Annotation => ({
    id,
    docId: DOC,
    page,
    kind: 'stroke',
    color: '#2563eb',
    payload: { pts: [0.1, 0.1, 0.5, 0.2, 0.2, 0.5], w: 0.005 },
    createdBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    seq: 0,
});

const item = (id: string, annotations: Annotation[]): ProposedItem => ({
    id,
    pageIndex: 0,
    clusterIds: [id],
    annotations,
    label: 'mark',
    isText: false,
    confidence: null,
});

let db: ScribblerDb;
let store: AnnotationStore;

beforeEach(async () => {
    db = new ScribblerDb(`test-${crypto.randomUUID()}`);
    store = new AnnotationStore(db, DOC);
    await store.load();
});

describe('applyProposals', () => {
    it('creates every annotation of every item through the store', async () => {
        const created = await applyProposals(store, [
            item('i1', [makeAnnotation('a1'), makeAnnotation('a2')]),
            item('i2', [makeAnnotation('a3', 4)]),
        ]);
        expect(created).toBe(3);
        expect(store.liveAnnotations()).toHaveLength(3);
        expect(store.getPage(4).has('a3')).toBe(true);
        // Outbox got one create op per annotation — they sync like hand-drawn ink.
        const ops = await db.ops.toArray();
        expect(ops.filter((op) => op.type === 'create')).toHaveLength(3);
    });

    it('is one undo step for the whole import', async () => {
        await applyProposals(store, [
            item('i1', [makeAnnotation('a1'), makeAnnotation('a2')]),
            item('i2', [makeAnnotation('a3')]),
        ]);
        expect(store.liveAnnotations()).toHaveLength(3);
        await store.undoLast();
        expect(store.liveAnnotations()).toHaveLength(0);
        await store.redoLast();
        expect(store.liveAnnotations()).toHaveLength(3);
    });

    it('clears a lingering review overlay before committing (commit is a no-op in history mode)', async () => {
        store.setHistoryOverlay([makeAnnotation('preview-only')]);
        const created = await applyProposals(store, [item('i1', [makeAnnotation('a1')])]);
        expect(created).toBe(1);
        expect(store.isHistoryMode).toBe(false);
        expect(store.liveAnnotations()).toHaveLength(1);
    });
});
