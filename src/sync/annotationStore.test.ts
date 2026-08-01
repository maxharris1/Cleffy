import { beforeEach, describe, expect, it } from 'vitest';

import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import type { Annotation } from '@/types/models';

const DOC = 'local-testdoc';

const makeStroke = (id: string, page = 0): Annotation => ({
    id,
    docId: DOC,
    page,
    kind: 'stroke',
    color: '#111111',
    payload: { pts: [0.1, 0.1, 0.5, 0.2, 0.2, 0.5], w: 0.005 },
    createdBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    seq: 0,
});

let db: ScribblerDb;
let store: AnnotationStore;

beforeEach(async () => {
    db = new ScribblerDb(`test-${crypto.randomUUID()}`);
    store = new AnnotationStore(db, DOC);
    await store.load();
});

describe('AnnotationStore', () => {
    it('creates annotations into memory, mirror, and outbox', async () => {
        await store.create(makeStroke('a1'));

        expect(store.getPage(0).has('a1')).toBe(true);
        const mirror = await db.annotations.get('a1');
        expect(mirror?.pending).toBe(1);
        const ops = await db.ops.toArray();
        expect(ops).toHaveLength(1);
        expect(ops[0]?.type).toBe('create');
        expect(ops[0]?.annotationId).toBe('a1');
    });

    it('hydrates from the mirror on load, skipping tombstones', async () => {
        await store.create(makeStroke('a1'));
        await store.create(makeStroke('a2', 3));
        await store.delete('a2');

        const fresh = new AnnotationStore(db, DOC);
        await fresh.load();
        expect(fresh.getPage(0).has('a1')).toBe(true);
        expect(fresh.getPage(3).has('a2')).toBe(false);
        // Tombstone still known by id (needed for LWW merge + restore).
        expect(fresh.get('a2')?.deletedAt).not.toBeNull();
    });

    it('delete is a soft tombstone and enqueues a delete op', async () => {
        await store.create(makeStroke('a1'));
        await store.delete('a1');

        expect(store.getPage(0).has('a1')).toBe(false);
        const mirror = await db.annotations.get('a1');
        expect(mirror?.deletedAt).not.toBeNull();
        const ops = await db.ops.toArray();
        expect(ops.map((o) => o.type)).toEqual(['create', 'delete']);
    });

    it('undo of a create tombstones; redo restores', async () => {
        await store.create(makeStroke('a1'));
        expect(store.canUndo).toBe(true);

        await store.undoLast();
        expect(store.getPage(0).has('a1')).toBe(false);
        expect(store.canRedo).toBe(true);

        await store.redoLast();
        expect(store.getPage(0).has('a1')).toBe(true);
    });

    it('undo of a delete restores the annotation', async () => {
        await store.create(makeStroke('a1'));
        await store.delete('a1');

        await store.undoLast(); // undo delete
        expect(store.getPage(0).has('a1')).toBe(true);
        expect(store.get('a1')?.deletedAt).toBeNull();
    });

    it('undo of an update restores previous fields', async () => {
        await store.create(makeStroke('a1'));
        await store.update('a1', { color: '#ff0000' });
        expect(store.get('a1')?.color).toBe('#ff0000');

        await store.undoLast();
        expect(store.get('a1')?.color).toBe('#111111');

        await store.redoLast();
        expect(store.get('a1')?.color).toBe('#ff0000');
    });

    it('batches eraser drags into one undo entry', async () => {
        await store.create(makeStroke('a1'));
        await store.create(makeStroke('a2'));
        await store.create(makeStroke('a3'));

        store.beginBatch();
        await store.delete('a1');
        await store.delete('a2');
        store.endBatch();
        expect(store.getPage(0).size).toBe(1);

        await store.undoLast(); // one undo restores both
        expect(store.getPage(0).size).toBe(3);
    });

    it('a new op clears the redo stack', async () => {
        await store.create(makeStroke('a1'));
        await store.undoLast();
        expect(store.canRedo).toBe(true);
        await store.create(makeStroke('a2'));
        expect(store.canRedo).toBe(false);
    });

    it('pokes the dirty hook after commits', async () => {
        let pokes = 0;
        store.setDirtyHook(() => {
            pokes += 1;
        });
        await store.create(makeStroke('a1'));
        await store.delete('a1');
        expect(pokes).toBe(2);
    });
});
