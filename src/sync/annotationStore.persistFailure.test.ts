import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as snapshotService from '@/features/viewer/history/snapshotService';
import { AnnotationStore, settleEdit } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import {
    clearAccountInk,
    forgetDocInk,
    hasUnsavedInk,
    heldMarksFor,
    MAX_HELD_SCORES,
    resetInkRecoveryForTests,
    unsavedMarkCount,
} from '@/sync/inkRecovery';
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

afterEach(() => {
    vi.restoreAllMocks();
    // Leave nothing in the module-wide registry for the next test.
    resetInkRecoveryForTests();
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
        // Visible to export, which reads Dexie, without the store.
        expect(heldMarksFor(null, DOC).map((a) => a.id)).toEqual(['a1']);
        expect(heldMarksFor(null, 'local-other')).toEqual([]);
    });

    it('whenSaved reports the failure, and the mark still counts as unsaved (C1)', async () => {
        const full = fillDisk();
        const edit = store.create(stroke('a1'));
        const saved = store.whenSaved('a1');
        await edit.catch(() => undefined);
        await expect(saved).resolves.toBe(false);
        expect(store.hasUnsavedEdit('a1')).toBe(true);
        expect(store.hasPersistFailure('a1')).toBe(true);
        await expect(store.whenSaved('a1')).resolves.toBe(false);

        full.mockRestore();
        await store.retryFailedPersist();
        expect(store.hasUnsavedEdit('a1')).toBe(false);
        await expect(store.whenSaved('a1')).resolves.toBe(true);
    });

    it('writes a later edit of a failed mark behind its held ops, never without them', async () => {
        const full = fillDisk();
        await store.create(stroke('a1')).catch(() => undefined);
        await store.update('a1', { color: '#00ff00' }).catch(() => undefined);
        // Still full: the edit joins the held ones, unwritten.
        expect(await db.ops.count()).toBe(0);
        full.mockRestore();

        await store.update('a1', { color: '#ff0000' });
        await store.create(stroke('b1'));

        // a1's update never reaches the outbox without its create.
        const ops = await db.ops.toArray();
        expect(ops.map((op) => `${op.type}:${op.annotationId}`)).toEqual([
            'create:a1',
            'update:a1',
            'update:a1',
            'create:b1',
        ]);
        expect((await db.annotations.get('a1'))?.color).toBe('#ff0000');
        expect(store.hasPersistFailure('a1')).toBe(false);
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
        expect(heldMarksFor(null, DOC)).toEqual([]);
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

    it('flags a new stroke whose day snapshot could not be written either, and Retry writes that snapshot first', async () => {
        await db.annotationSnapshots.clear();
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockRejectedValueOnce(quotaError());

        await expect(store.create(stroke('a1'))).rejects.toThrow(/quota/);

        expect(store.getPage(0).has('a1')).toBe(true);
        expect(store.hasPersistFailure('a1')).toBe(true);
        expect(await db.annotationSnapshots.count()).toBe(0);
        await expect(store.retryFailedPersist()).resolves.toBe(true);
        expect((await db.ops.toArray()).map((op) => op.type)).toEqual(['create']);
        // The day's starting point is the score before a1, not after it.
        const snapshots = await db.annotationSnapshots.toArray();
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]?.payload).toEqual([]);
    });

    it('a later edit, while that snapshot is still owed, takes the starting point from before the held stroke', async () => {
        await store.create(stroke('old'));
        await db.annotationSnapshots.clear();
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockRejectedValueOnce(quotaError());
        await store.create(stroke('a1')).catch(() => undefined);

        await store.create(stroke('b1'));

        const snapshots = await db.annotationSnapshots.toArray();
        expect(snapshots.map((snap) => snap.payload.map((a) => a.id))).toEqual([['old']]);
    });

    it('refuses an update whose day snapshot fails, as before, but says so until a retry writes the snapshot', async () => {
        await store.create(stroke('a1'));
        await db.annotationSnapshots.clear();
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockRejectedValueOnce(quotaError());
        const meta = vi.fn();
        store.subscribeMeta(meta);

        await expect(store.update('a1', { color: '#ff0000' })).rejects.toThrow(/quota/);

        expect(store.get('a1')?.color).toBe('#111111');
        expect(store.hasPersistFailure('a1')).toBe(false);
        expect(store.refusedEditCount).toBe(1);
        expect(meta).toHaveBeenCalled();
        // Nothing of it to lose on reload.
        expect(hasUnsavedInk()).toBe(false);

        await expect(store.retryFailedPersist()).resolves.toBe(true);
        expect(store.refusedEditCount).toBe(0);
        expect(await db.annotationSnapshots.count()).toBe(1);
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

/** A mark `author` drew whose write failed, on a store mounted for `author`. */
const failedStrokeAs = async (author: string | null, id: string, onDb = db): Promise<AnnotationStore> => {
    const mounted = new AnnotationStore(onDb, DOC);
    mounted.setAuthor(author);
    await mounted.load();
    const full = vi.spyOn(onDb.ops, 'bulkAdd').mockRejectedValue(quotaError());
    await mounted.create(stroke(id)).catch(() => undefined);
    full.mockRestore();
    return mounted;
};

describe('held ink and accounts (finding 1)', () => {
    const A = 'user-a';
    const B = 'user-b';

    it('A’s failed mark on a shared score is not B’s: B neither draws, counts nor retries it', async () => {
        await failedStrokeAs(A, 'a-secret');

        const asB = new AnnotationStore(db, DOC);
        asB.setAuthor(B);
        await asB.load();

        expect(asB.get('a-secret')).toBeUndefined();
        expect(asB.persistFailureCount).toBe(0);
        expect(asB.hasPersistFailure('a-secret')).toBe(false);
        expect(heldMarksFor(B, DOC)).toEqual([]);
        expect(unsavedMarkCount(B)).toBe(0);
        // B's Retry writes nothing of A's.
        await expect(asB.retryFailedPersist()).resolves.toBe(true);
        expect(await db.ops.count()).toBe(0);
        expect(heldMarksFor(A, DOC).map((a) => a.id)).toEqual(['a-secret']);
    });

    it('a store still mounted when the account changes hides A’s held mark and never stamps it as B’s', async () => {
        const mounted = await failedStrokeAs(A, 'a-secret');
        expect(mounted.getPage(0).has('a-secret')).toBe(true);

        mounted.setAuthor(B);
        await vi.waitFor(() => expect(mounted.getPage(0).has('a-secret')).toBe(false));
        expect(mounted.persistFailureCount).toBe(0);
        await expect(mounted.retryFailedPersist()).resolves.toBe(true);
        await mounted.create(stroke('b-own'));

        const ops = await db.ops.toArray();
        expect(ops.map((op) => [op.annotationId, op.userId])).toEqual([['b-own', B]]);

        // A, back in this tab before any sign-out cleared it: written as A's.
        mounted.setAuthor(A);
        await vi.waitFor(() => expect(mounted.getPage(0).has('a-secret')).toBe(true));
        await expect(mounted.retryFailedPersist()).resolves.toBe(true);
        expect((await db.ops.toArray()).map((op) => [op.annotationId, op.userId])).toEqual([
            ['b-own', B],
            ['a-secret', A],
        ]);
    });

    it('Retry writes each op under the account that made it, whoever retries', async () => {
        const mounted = await failedStrokeAs(A, 'a1');
        // The author changes between the failure and the retry.
        mounted.setAuthor(B);
        const reopened = new AnnotationStore(db, DOC);
        reopened.setAuthor(A);
        await reopened.load();

        await expect(reopened.retryFailedPersist()).resolves.toBe(true);

        expect((await db.ops.toArray()).map((op) => op.userId)).toEqual([A]);
    });

    it('a sign-out that cannot tell whose session it ended (clearAccountInk()) forgets every account’s held ink, and keeps device-only scores’', async () => {
        await failedStrokeAs(A, 'a1');
        await failedStrokeAs(null, 'local-1');
        expect(unsavedMarkCount(A)).toBe(1);
        expect(hasUnsavedInk()).toBe(true);

        clearAccountInk();

        expect(unsavedMarkCount()).toBe(0);
        expect(heldMarksFor(A, DOC)).toEqual([]);
        const asB = new AnnotationStore(db, DOC);
        asB.setAuthor(B);
        await asB.load();
        expect(asB.get('a1')).toBeUndefined();
        expect(heldMarksFor(null, DOC).map((a) => a.id)).toEqual(['local-1']);
    });
});

describe('held ink across viewer mounts, and latest wins (finding 2)', () => {
    it('a reopened score’s new store draws the held mark and retries it', async () => {
        await failedStrokeAs(null, 'a1');

        // The viewer is left and the score opened again: a new store.
        const reopened = new AnnotationStore(db, DOC);
        await reopened.load();

        expect(reopened.getPage(0).has('a1')).toBe(true);
        expect(reopened.hasPersistFailure('a1')).toBe(true);
        expect(reopened.persistFailureCount).toBe(1);
        await expect(reopened.retryFailedPersist()).resolves.toBe(true);
        expect((await db.ops.toArray()).map((op) => `${op.type}:${op.annotationId}`)).toEqual(['create:a1']);
        expect(reopened.persistFailureCount).toBe(0);
    });

    it('red fails, then blue succeeds in a new mount: blue is what is stored and exported, and nothing stays held', async () => {
        await store.create(stroke('a1'));
        const full = fillDisk();
        await store.update('a1', { color: '#ff0000' }).catch(() => undefined);
        full.mockRestore();

        const reopened = new AnnotationStore(db, DOC);
        await reopened.load();
        expect(reopened.get('a1')?.color).toBe('#ff0000');
        await reopened.update('a1', { color: '#0000ff' });

        expect(reopened.hasPersistFailure('a1')).toBe(false);
        expect(heldMarksFor(null, DOC)).toEqual([]);
        expect((await db.annotations.get('a1'))?.color).toBe('#0000ff');
        // The red update goes out behind the create, before the blue one.
        expect((await db.ops.toArray()).map((op) => `${op.type}:${op.annotation.color}`)).toEqual([
            'create:#111111',
            'update:#ff0000',
            'update:#0000ff',
        ]);
    });

    it('a failed erase never hides the mark once a newer edit of it is stored', async () => {
        await store.create(stroke('a1'));
        const full = fillDisk();
        await store.delete('a1').catch(() => undefined);
        full.mockRestore();
        expect(heldMarksFor(null, DOC)[0]?.deletedAt).not.toBeNull();

        // Undo brings it back, and that write succeeds.
        await store.undoLast();

        expect(store.getPage(0).has('a1')).toBe(true);
        expect(heldMarksFor(null, DOC)).toEqual([]);
        expect((await db.annotations.get('a1'))?.deletedAt).toBeNull();
    });

    it('a failed erase gives way to a newer mark another tab of this device stored', async () => {
        await store.create(stroke('a1'));
        const full = fillDisk();
        await store.delete('a1').catch(() => undefined);
        full.mockRestore();
        // Another tab (its own registry) restored and recoloured it later.
        const later = new Date(Date.now() + 60_000).toISOString();
        await db.annotations.put({ ...stroke('a1'), color: '#00aa00', updatedAt: later, pending: 1 });

        const reopened = new AnnotationStore(db, DOC);
        await reopened.load();

        expect(reopened.get('a1')?.color).toBe('#00aa00');
        expect(reopened.getPage(0).has('a1')).toBe(true);
        expect(heldMarksFor(null, DOC)).toEqual([]);
    });

    it('closing a score for good (purge) forgets its held ink', async () => {
        await failedStrokeAs(null, 'a1');
        forgetDocInk(DOC);
        expect(heldMarksFor(null, DOC)).toEqual([]);
        expect(hasUnsavedInk()).toBe(false);
    });

    it('keeps one held update per run of updates to a mark', async () => {
        await store.create(stroke('a1'));
        await db.ops.clear();
        const full = fillDisk();
        for (const color of ['#100000', '#200000', '#300000']) {
            await store.update('a1', { color }).catch(() => undefined);
        }
        full.mockRestore();

        await store.retryFailedPersist();

        const ops = await db.ops.toArray();
        expect(ops.map((op) => `${op.type}:${op.annotation.color}`)).toEqual(['update:#300000']);
    });

    it('is bounded without losing anything: past MAX_HELD_SCORES no held score goes, the new edit is undone and said so', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const open = new AnnotationStore(db, 'local-open');
        await open.load();
        const detach = open.attach();
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await open.create({ ...stroke('kept'), docId: 'local-open' }).catch(() => undefined);
        const others: AnnotationStore[] = [];
        for (let i = 0; i < MAX_HELD_SCORES + 2; i++) {
            const docId = `local-doc-${i}`;
            const other = new AnnotationStore(db, docId);
            others.push(other);
            await other.create({ ...stroke(`m${i}`), docId }).catch(() => undefined);
        }
        full.mockRestore();
        detach();

        // Before (round 1) the oldest unopened score's only copy went with a
        // console warning. Now every held score stays...
        expect(heldMarksFor(null, 'local-open').map((a) => a.id)).toEqual(['kept']);
        for (let i = 0; i < MAX_HELD_SCORES - 1; i++) {
            expect(heldMarksFor(null, `local-doc-${i}`)).toHaveLength(1);
        }
        // ...and the scores past the bound never held theirs: undone on
        // screen, with the banner's overflow state, not kept and then dropped.
        for (let i = MAX_HELD_SCORES - 1; i < MAX_HELD_SCORES + 2; i++) {
            expect(heldMarksFor(null, `local-doc-${i}`)).toEqual([]);
            expect(others[i]?.getPage(0).has(`m${i}`)).toBe(false);
            expect(others[i]?.overflowCount).toBe(1);
        }
    });
});

describe('the unload guard (C1)', () => {
    const unload = () => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
    };

    it('asks before the tab unloads while a mark is held, and stops once it is written', async () => {
        expect(unload()).toBe(false);
        const full = fillDisk();
        await store.create(stroke('a1')).catch(() => undefined);
        full.mockRestore();

        expect(unload()).toBe(true);

        await store.retryFailedPersist();
        expect(unload()).toBe(false);
    });

    it('asks while an edit is still on its way', async () => {
        await store.create(stroke('a1'));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const orig = snapshotService.ensureDayStartingSnapshot;
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockImplementation(async (...args) => {
            await gate;
            return orig(...args);
        });
        const edit = store.update('a1', { color: '#ff0000' });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(unload()).toBe(true);

        release();
        await edit;
        expect(unload()).toBe(false);
    });
});
