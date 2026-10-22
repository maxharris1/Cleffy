import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as snapshotService from '@/features/viewer/history/snapshotService';
import { AnnotationStore, settleEdit, unsavedMarkCount, unsavedMarksFor } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import type { Annotation } from '@/types/models';

/**
 * SF-1: a mark whose Dexie write fails (the browser's storage quota, a closed
 * database) must not vanish silently. The store keeps it drawn, flags it
 * (hasPersistFailure), tells the viewer through the meta channel, and writes
 * it again on retryFailedPersist.
 */

const DOC = 'local-persist-failure';

const stroke = (id: string, page = 0): Annotation => ({
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

const quotaError = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

let db: ScribblerDb;
let store: AnnotationStore;

/** Every outbox write throws, as IndexedDB does over quota; the transaction rolls back the mirror row with it. */
const fillDisk = () => vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());

beforeEach(async () => {
    db = new ScribblerDb(`test-${crypto.randomUUID()}`);
    store = new AnnotationStore(db, DOC);
    await store.load();
});

afterEach(async () => {
    vi.restoreAllMocks();
    // Leave nothing in the module-wide registry for the next test.
    await store.retryFailedPersist();
});

describe('AnnotationStore when a write fails', () => {
    it('keeps the mark drawn, flags it, and says so through the meta channel', async () => {
        const full = fillDisk();
        const meta = vi.fn();
        store.subscribeMeta(meta);
        const repainted: number[] = [];
        store.subscribe((page) => repainted.push(page));

        await expect(store.create(stroke('a1'))).rejects.toThrow(/quota/);

        expect(full).toHaveBeenCalled();
        expect(store.getPage(0).has('a1')).toBe(true);
        expect(repainted).toContain(0);
        expect(store.hasPersistFailure('a1')).toBe(true);
        expect(store.persistFailureCount).toBe(1);
        expect(meta).toHaveBeenCalled();
        // Nothing reached the device: no mirror row, no outbox op.
        expect(await db.annotations.get('a1')).toBeUndefined();
        expect(await db.ops.count()).toBe(0);
        // Visible to sign-out and export, which read Dexie.
        expect(unsavedMarkCount()).toBe(1);
        expect(unsavedMarksFor(DOC).map((a) => a.id)).toEqual(['a1']);
        expect(unsavedMarksFor('local-other')).toEqual([]);
    });

    it('whenSaved still resolves; hasPersistFailure is what says it was not saved', async () => {
        fillDisk();
        const edit = store.create(stroke('a1'));
        const saved = store.whenSaved('a1');
        await edit.catch(() => undefined);
        await expect(saved).resolves.toBeUndefined();
        expect(store.hasUnsavedEdit('a1')).toBe(false);
        expect(store.hasPersistFailure('a1')).toBe(true);
    });

    it('queues a later edit of a failed mark behind it, unwritten, and writes other marks as usual', async () => {
        const full = fillDisk();
        await store.create(stroke('a1')).catch(() => undefined);
        full.mockRestore();

        await store.update('a1', { color: '#ff0000' });
        await store.create(stroke('b1'));

        // a1's update would otherwise reach the outbox without its create.
        const ops = await db.ops.toArray();
        expect(ops.map((op) => `${op.type}:${op.annotationId}`)).toEqual(['create:b1']);
        expect(store.get('a1')?.color).toBe('#ff0000');
        expect(store.hasPersistFailure('a1')).toBe(true);
        expect(store.hasPersistFailure('b1')).toBe(false);
    });

    it('a retry that succeeds writes the held edits in order, clears the flag and wakes the sync engine', async () => {
        const full = fillDisk();
        await store.create(stroke('a1')).catch(() => undefined);
        await store.update('a1', { color: '#ff0000' }).catch(() => undefined);
        full.mockRestore();
        const dirty = vi.fn();
        store.setDirtyHook(dirty);
        const meta = vi.fn();
        store.subscribeMeta(meta);

        await expect(store.retryFailedPersist()).resolves.toBe(true);

        expect(store.hasPersistFailure('a1')).toBe(false);
        expect(store.persistFailureCount).toBe(0);
        expect(unsavedMarkCount()).toBe(0);
        expect(meta).toHaveBeenCalled();
        expect(dirty).toHaveBeenCalledWith(['a1']);
        const ops = await db.ops.toArray();
        expect(ops.map((op) => op.type)).toEqual(['create', 'update']);
        expect((await db.annotations.get('a1'))?.color).toBe('#ff0000');
        // And it survives a reload.
        const reopened = new AnnotationStore(db, DOC);
        await reopened.load();
        expect(reopened.get('a1')?.color).toBe('#ff0000');
    });

    it('a retry that fails again keeps everything held and reports false', async () => {
        fillDisk();
        await store.create(stroke('a1')).catch(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(store.retryFailedPersist()).resolves.toBe(false);

        expect(store.hasPersistFailure('a1')).toBe(true);
        expect(await db.ops.count()).toBe(0);
    });

    it('flags a new stroke whose day snapshot could not be written either', async () => {
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockRejectedValueOnce(quotaError());

        await expect(store.create(stroke('a1'))).rejects.toThrow(/quota/);

        expect(store.getPage(0).has('a1')).toBe(true);
        expect(store.hasPersistFailure('a1')).toBe(true);
        await expect(store.retryFailedPersist()).resolves.toBe(true);
        expect((await db.ops.toArray()).map((op) => op.type)).toEqual(['create']);
    });

    it('holds a remote row back from a failed mark rather than overwrite the unsaved edit', async () => {
        await store.create(stroke('a1'));
        await db.ops.clear();
        const full = fillDisk();
        await store.update('a1', { color: '#ff0000' }).catch(() => undefined);
        full.mockRestore();

        const held = await store.applyRemoteBatch([{ ...stroke('a1'), color: '#00ff00', seq: 9 }], new Set());

        expect(held.has('a1')).toBe(true);
        expect(store.get('a1')?.color).toBe('#ff0000');
    });

    it('also holds undo/redo writes, and repaints what memory has', async () => {
        await store.create(stroke('a1'));
        const full = fillDisk();
        const repainted: number[] = [];
        store.subscribe((page) => repainted.push(page));

        await expect(store.undoLast()).rejects.toThrow(/quota/);

        expect(store.getPage(0).has('a1')).toBe(false);
        expect(repainted).toContain(0);
        expect(store.hasPersistFailure('a1')).toBe(true);
        full.mockRestore();
        await expect(store.retryFailedPersist()).resolves.toBe(true);
        expect((await db.annotations.get('a1'))?.deletedAt).not.toBeNull();
    });

    it('settleEdit swallows the rejection so a pen-up never becomes an unhandled rejection', async () => {
        fillDisk();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            settleEdit(store.create(stroke('a1')));
            await new Promise((resolve) => setTimeout(resolve, 20));
        } finally {
            process.off('unhandledRejection', unhandled);
        }
        expect(unhandled).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
            'Could not save a mark on this device',
            expect.objectContaining({ name: 'QuotaExceededError' }),
        );
        expect(store.hasPersistFailure('a1')).toBe(true);
    });
});
