import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as snapshotService from '@/features/viewer/history/snapshotService';
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

    it('nested batches are independent: inner endBatch does not close the outer', async () => {
        await store.create(makeStroke('a1'));
        await store.create(makeStroke('a2'));
        await store.create(makeStroke('a3'));

        store.beginBatch();
        await store.delete('a1');
        store.beginBatch();
        await store.delete('a2');
        await store.create(makeStroke('print'));
        store.endBatch();
        await store.delete('a3');
        store.endBatch();

        await store.undoLast();
        expect(store.getPage(0).has('a1')).toBe(true);
        expect(store.getPage(0).has('a3')).toBe(true);
        expect(store.getPage(0).has('a2')).toBe(false);
        expect(store.getPage(0).has('print')).toBe(true);

        await store.undoLast();
        expect(store.getPage(0).has('a2')).toBe(true);
        expect(store.getPage(0).has('print')).toBe(false);
    });

    it('endBatch(handle) closes only that frame while an inner batch is still open', async () => {
        await store.create(makeStroke('a1'));
        await store.create(makeStroke('a2'));
        await store.create(makeStroke('a3'));

        const outer = store.beginBatch();
        await store.delete('a1');
        const inner = store.beginBatch();
        await store.delete('a2');
        store.endBatch(outer);
        await store.create(makeStroke('print'));
        store.endBatch(inner);

        await store.undoLast();
        expect(store.getPage(0).has('a2')).toBe(true);
        expect(store.getPage(0).has('print')).toBe(false);
        expect(store.getPage(0).has('a1')).toBe(false);

        await store.undoLast();
        expect(store.getPage(0).has('a1')).toBe(true);
    });

    it('a new op clears the redo stack', async () => {
        await store.create(makeStroke('a1'));
        await store.undoLast();
        expect(store.canRedo).toBe(true);
        await store.create(makeStroke('a2'));
        expect(store.canRedo).toBe(false);
    });

    it('stamps every queued op with the account set as author', async () => {
        await store.create(makeStroke('u0'));
        store.setAuthor('user-1');
        await store.create(makeStroke('u1'));
        await store.update('u1', { color: '#ff0000' });
        await store.delete('u1');
        await store.undoLast();
        store.setAuthor(null);
        await store.create(makeStroke('u2'));

        const ops = await db.ops.orderBy('opId').toArray();
        expect(ops.map((op) => [op.annotationId, op.type, op.userId])).toEqual([
            ['u0', 'create', undefined],
            ['u1', 'create', 'user-1'],
            ['u1', 'update', 'user-1'],
            ['u1', 'delete', 'user-1'],
            ['u1', 'restore', 'user-1'],
            ['u2', 'create', undefined],
        ]);
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

    it('captures a day starting-point snapshot before the first edit', async () => {
        await store.create(makeStroke('a1'));
        await store.create(makeStroke('a2'));

        const snaps = await db.annotationSnapshots.where('docId').equals(DOC).toArray();
        expect(snaps).toHaveLength(1);
        // Pre-first-edit set was empty.
        expect(snaps[0]?.payload).toEqual([]);
    });

    it('does not overwrite the day snapshot on later edits', async () => {
        await store.create(makeStroke('a1'));
        await store.create(makeStroke('a2'));
        const first = await db.annotationSnapshots.where('docId').equals(DOC).first();
        expect(first?.payload).toEqual([]);

        await store.create(makeStroke('a3'));
        const snaps = await db.annotationSnapshots.where('docId').equals(DOC).toArray();
        expect(snaps).toHaveLength(1);
        expect(snaps[0]?.id).toBe(first?.id);
    });

    it('history overlay shows snapshot marks read-only without mutating live state', async () => {
        await store.create(makeStroke('a1'));
        const snapMarks = [makeStroke('old')];
        store.setHistoryOverlay(snapMarks);
        expect(store.isHistoryMode).toBe(true);
        expect(store.getPage(0).has('old')).toBe(true);
        expect(store.getPage(0).has('a1')).toBe(false);
        expect(store.liveAnnotations().map((a) => a.id)).toEqual(['a1']);

        store.setHistoryOverlay(null);
        expect(store.isHistoryMode).toBe(false);
        expect(store.getPage(0).has('a1')).toBe(true);
    });

    it('createMany bulk-writes mirror + outbox and undoes as recorded', async () => {
        const many = Array.from({ length: 25 }, (_, i) => makeStroke(`m${i}`, i % 3));
        store.beginBatch();
        await store.createMany(many);
        store.endBatch();

        expect(store.getPage(0).size + store.getPage(1).size + store.getPage(2).size).toBe(25);
        expect(await db.annotations.count()).toBe(25);
        const ops = await db.ops.toArray();
        expect(ops).toHaveLength(25);
        expect(ops.every((op) => op.type === 'create')).toBe(true);

        // The whole bulk create is ONE undo step → 25 tombstones.
        await store.undoLast();
        expect(store.liveAnnotations()).toHaveLength(0);
        expect((await db.annotations.toArray()).every((row) => row.deletedAt !== null)).toBe(true);
        expect(await db.ops.count()).toBe(50);

        // Redo restores every mark.
        await store.redoLast();
        expect(store.liveAnnotations()).toHaveLength(25);
        expect(store.canUndo).toBe(true);
    });

    it('createMany is a no-op while an overlay is shown', async () => {
        store.setHistoryOverlay([makeStroke('ov')], 'preview');
        await store.createMany([makeStroke('m1')]);
        store.setHistoryOverlay(null);
        expect(store.liveAnnotations()).toHaveLength(0);
        expect(await db.annotations.count()).toBe(0);
    });

    it('undo/redo do not consume entries while an overlay is shown', async () => {
        await store.create(makeStroke('a1'));
        store.setHistoryOverlay([makeStroke('ov')]);
        await store.undoLast();
        store.setHistoryOverlay(null);
        expect(store.canUndo).toBe(true);
        expect(store.liveAnnotations()).toHaveLength(1);
        await store.undoLast();
        expect(store.liveAnnotations()).toHaveLength(0);
    });

    it('tracks which UI owns the overlay (history pill vs import preview)', () => {
        expect(store.overlayMode).toBe(null);
        store.setHistoryOverlay([makeStroke('p1')], 'preview');
        expect(store.overlayMode).toBe('preview');
        expect(store.isHistoryMode).toBe(true);
        store.setHistoryOverlay([makeStroke('h1')]);
        expect(store.overlayMode).toBe('history');
        store.setHistoryOverlay(null);
        expect(store.overlayMode).toBe(null);
    });

    it('delete is a no-op if a peer tombstones the row during the snapshot yield', async () => {
        await store.create(makeStroke('a1'));
        const orig = snapshotService.ensureDayStartingSnapshot;
        const spy = vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockImplementation(async (...args) => {
            const live = store.get('a1');
            if (live && !live.deletedAt) {
                await store.applyRemoteBatch(
                    [
                        {
                            ...live,
                            deletedAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                            seq: live.seq + 1,
                        },
                    ],
                    new Set(),
                );
            }
            return orig(...args);
        });
        expect(await store.delete('a1')).toBe(false);
        expect(store.get('a1')?.deletedAt).not.toBeNull();
        await store.undoLast();
        expect(store.get('a1')?.deletedAt).not.toBeNull();
        spy.mockRestore();
    });

    it('create is visible in memory before the snapshot yield so grouping can start at pointer-up', async () => {
        const orig = snapshotService.ensureDayStartingSnapshot;
        const spy = vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockImplementation(async (...args) => {
            expect(store.get('new')?.id).toBe('new');
            expect(args[2]?.some((a) => a.id === 'new')).toBe(false);
            return orig(...args);
        });
        await store.create(makeStroke('new'));
        expect(store.get('new')?.id).toBe('new');
        spy.mockRestore();
    });

    describe('undo/redo after a collaborator deleted the mark', () => {
        /** The broadcast of a peer's erase: same row, tombstoned, newer seq. */
        const remoteDelete = async (id: string) => {
            const live = store.get(id)!;
            await store.applyRemoteBatch(
                [{ ...live, deletedAt: '2026-02-01T00:00:00.000Z', seq: live.seq + 10 }],
                new Set(),
            );
        };

        it('undo of an edit does not resurrect a mark a collaborator deleted', async () => {
            await store.create(makeStroke('a1'));
            await store.update('a1', { color: '#ff0000' });
            await remoteDelete('a1');
            const opsBefore = await db.ops.count();

            await store.undoLast(); // the color change — target is gone

            expect(store.get('a1')?.deletedAt).not.toBeNull();
            expect(store.getPage(0).has('a1')).toBe(false);
            // Nothing queued that could undelete it on the server.
            expect(await db.ops.count()).toBe(opsBefore);
        });

        it('drops the dead entry and undoes the next one in the same press', async () => {
            await store.create(makeStroke('keep'));
            await store.create(makeStroke('a1'));
            await store.update('a1', { color: '#ff0000' });
            await remoteDelete('a1');

            // Entries, newest first: update a1 (dead), create a1 (dead), create keep.
            await store.undoLast();

            expect(store.get('a1')?.deletedAt).not.toBeNull();
            expect(store.getPage(0).has('keep')).toBe(false); // the press reached a live entry
            expect(store.canUndo).toBe(false);

            // Redo brings back only what undo actually did.
            await store.redoLast();
            expect(store.getPage(0).has('keep')).toBe(true);
            expect(store.get('a1')?.deletedAt).not.toBeNull();
        });

        it('redo of an edit is skipped when the mark was deleted after the undo', async () => {
            await store.create(makeStroke('a1'));
            await store.update('a1', { color: '#ff0000' });
            await store.undoLast(); // back to #111111; redo = set #ff0000
            await remoteDelete('a1');

            await store.redoLast();

            expect(store.get('a1')?.deletedAt).not.toBeNull();
            expect(store.canRedo).toBe(false);
        });
    });

    describe('load ordering', () => {
        it('load is shared: concurrent callers get one hydration', async () => {
            await store.create(makeStroke('a1'));
            const fresh = new AnnotationStore(db, DOC);
            const spy = vi.spyOn(db.annotations, 'where');
            await Promise.all([fresh.load(), fresh.load(), fresh.load()]);
            expect(spy).toHaveBeenCalledTimes(1);
            expect(fresh.get('a1')).toBeDefined();
        });

        it('hydration merges with marks drawn while it was reading', async () => {
            await store.create(makeStroke('old'));
            const fresh = new AnnotationStore(db, DOC);
            const loading = fresh.load();
            await fresh.create(makeStroke('drawn-during-load'));
            await loading;

            expect(fresh.getPage(0).has('old')).toBe(true);
            expect(fresh.getPage(0).has('drawn-during-load')).toBe(true);
        });

        it('a remote row arriving before hydration is merged against the mirror, not an empty map', async () => {
            await db.annotations.put({ ...makeStroke('a1'), color: '#aaaaaa', seq: 10, pending: 0 });
            const fresh = new AnnotationStore(db, DOC);
            // No load() yet — the broadcast path can land first.
            await fresh.applyRemoteBatch([{ ...makeStroke('a1'), color: '#bbbbbb', seq: 5 }], new Set());

            expect(fresh.get('a1')?.color).toBe('#aaaaaa');
            expect((await db.annotations.get('a1'))?.color).toBe('#aaaaaa');
        });
    });

    it('adoptServerRow overwrites a local edit regardless of seq', async () => {
        await store.applyRemoteBatch([{ ...makeStroke('a1'), seq: 4 }], new Set());
        await store.update('a1', { color: '#ff0000' });
        await store.adoptServerRow({ ...makeStroke('a1'), seq: 4 });

        expect(store.get('a1')?.color).toBe('#111111');
        expect((await db.annotations.get('a1'))?.pending).toBe(0);
    });

    it('discardLocal removes the mirror row even before hydration', async () => {
        await db.annotations.put({ ...makeStroke('a1'), pending: 1 });
        const fresh = new AnnotationStore(db, DOC);
        await fresh.discardLocal('a1');
        expect(await db.annotations.get('a1')).toBeUndefined();
        expect(fresh.get('a1')).toBeUndefined();
    });
});
