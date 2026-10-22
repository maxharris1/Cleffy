import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as snapshotService from '@/features/viewer/history/snapshotService';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import {
    clearAccountInk,
    conflictCount,
    conflictMarksFor,
    HeldInkFull,
    heldMarksFor,
    holdOps,
    MAX_HELD_OPS,
    MAX_HELD_SCORES,
    overflowCount,
    PERSIST_CHUNK,
    resetInkRecoveryForTests,
    retryHeld,
    SIGNED_OUT_STORAGE_KEY,
    unsavedMarkCount,
    type AuthoredOp,
} from '@/sync/inkRecovery';
import type { Annotation } from '@/types/models';

/**
 * Launchfix P2 round 2: the cases Codex's second review listed as untested.
 * Cancellation across sign-out (a Retry spanning it, a multi-chunk write, a
 * store still mounted), latest-wins against versions newer than the held
 * one (another tab's upload, a collaborator's on the server), the memory
 * bounds without losing held ink, and sign-out reaching the other tabs.
 */

const DOC = 'local-recovery-r2';
const A = 'user-a';
const B = 'user-b';

const stroke = (id: string, docId = DOC): Annotation => ({
    id,
    docId,
    page: 0,
    kind: 'stroke',
    color: '#111111',
    payload: { pts: [0.1, 0.1, 0.5, 0.2, 0.2, 0.5], w: 0.005 },
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

const quotaError = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

let db: ScribblerDb;

beforeEach(() => {
    db = new ScribblerDb(`recovery-${crypto.randomUUID()}`);
});

afterEach(() => {
    vi.restoreAllMocks();
    resetInkRecoveryForTests();
});

const storeAs = async (author: string | null, docId = DOC, onDb = db): Promise<AnnotationStore> => {
    const store = new AnnotationStore(onDb, docId);
    store.setAuthor(author);
    await store.load();
    return store;
};

/** Run `edit` with every outbox write failing, as over quota. */
const withFullDisk = async (edit: () => Promise<unknown>, onDb = db): Promise<void> => {
    const full = vi.spyOn(onDb.ops, 'bulkAdd').mockRejectedValue(quotaError());
    try {
        await edit().catch(() => undefined);
    } finally {
        full.mockRestore();
    }
};

/** a1, stored and synced at seq 5, then recoloured red here while the disk was full: the red edit is held. */
const heldRedOverSynced = async (author: string | null = null): Promise<AnnotationStore> => {
    await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
    const store = await storeAs(author);
    await withFullDisk(() => store.update('a1', { color: '#ff0000' }));
    expect(heldMarksFor(author, DOC).map((a) => a.color)).toEqual(['#ff0000']);
    return store;
};

describe('latest wins against a newer version (MAJOR 2)', () => {
    it('newer row already uploaded by another tab: Retry does not write over it, and keeps the held edit for Export', async () => {
        const store = await heldRedOverSynced();
        // Another tab recoloured it blue later, and its upload was acked:
        // the mirror row is no longer pending, on the same server seq.
        const later = new Date(Date.now() + 60_000).toISOString();
        await db.annotations.put({ ...stroke('a1'), seq: 5, color: '#0000ff', updatedAt: later, pending: 0 });

        await expect(store.retryFailedPersist()).resolves.toBe(true);

        expect((await db.annotations.get('a1'))?.color).toBe('#0000ff');
        expect(await db.ops.count()).toBe(0);
        expect(store.get('a1')?.color).toBe('#0000ff');
        expect(store.persistFailureCount).toBe(0);
        expect(store.conflictCount).toBe(1);
        expect(conflictMarksFor(null, DOC).map((a) => a.color)).toEqual(['#ff0000']);
    });

    it('a newer server version pulled by another tab (a higher seq) overtakes the held one on the next open', async () => {
        await heldRedOverSynced();
        await db.annotations.put({ ...stroke('a1'), seq: 9, color: '#00aa00', pending: 0 });

        const reopened = await storeAs(null);

        expect(reopened.get('a1')?.color).toBe('#00aa00');
        expect(reopened.persistFailureCount).toBe(0);
        expect(conflictCount(null, DOC)).toBe(1);
    });

    it('Retry against superseded state: the mirror is checked in the write itself, not only on open', async () => {
        const store = await heldRedOverSynced();
        // The store drew red; the newer version lands only now.
        expect(store.get('a1')?.color).toBe('#ff0000');
        const later = new Date(Date.now() + 60_000).toISOString();
        await db.annotations.put({ ...stroke('a1'), seq: 5, color: '#0000ff', updatedAt: later, pending: 1 });

        await store.retryFailedPersist();

        expect((await db.annotations.get('a1'))?.color).toBe('#0000ff');
        expect(await db.ops.count()).toBe(0);
        expect(store.get('a1')?.color).toBe('#0000ff');
        expect(store.conflictCount).toBe(1);
    });

    it('a failed erase does not hide a newer version a collaborator made on the server', async () => {
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        const store = await storeAs(A);
        await withFullDisk(() => store.delete('a1'));
        const overtaken = vi.fn();
        store.setRetryHooks({
            serverRows: () => Promise.resolve([{ ...stroke('a1'), seq: 12, color: '#00aa00' }]),
            overtaken,
        });

        await expect(store.retryFailedPersist()).resolves.toBe(true);

        // No tombstone written over it; the engine is asked to draw the server's version.
        expect(await db.ops.count()).toBe(0);
        expect((await db.annotations.get('a1'))?.deletedAt).toBeNull();
        expect(overtaken).toHaveBeenCalledWith(['a1']);
        expect(store.persistFailureCount).toBe(0);
    });

    it('the server holding this device’s own earlier write is no conflict: the held edit is written', async () => {
        const store = await heldRedOverSynced(A);
        // The server numbered the version the red edit was made on past the
        // seq memory has (its echo had not come back): same content.
        store.setRetryHooks({
            serverRows: () => Promise.resolve([{ ...stroke('a1'), seq: 8 }]),
            overtaken: vi.fn(),
        });

        await expect(store.retryFailedPersist()).resolves.toBe(true);

        expect((await db.ops.toArray()).map((op) => `${op.type}:${op.annotation.color}`)).toEqual(['update:#ff0000']);
        expect(store.conflictCount).toBe(0);
    });

    it('a server still on the version this device’s unsent edit was made on is behind it, whatever its clock says', async () => {
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        const store = await storeAs(A);
        // Written here but not uploaded yet, then a later edit is held.
        await store.update('a1', { color: '#00ff00' });
        await withFullDisk(() => store.update('a1', { color: '#ff0000' }));
        // The server has seq 5 as first stored, stamped by a clock far ahead of this device's.
        const ahead = new Date(Date.now() + 3_600_000).toISOString();
        store.setRetryHooks({
            serverRows: () => Promise.resolve([{ ...stroke('a1'), seq: 5, updatedAt: ahead }]),
            overtaken: vi.fn(),
        });

        await expect(store.retryFailedPersist()).resolves.toBe(true);

        expect((await db.annotations.get('a1'))?.color).toBe('#ff0000');
        expect(store.conflictCount).toBe(0);
    });

    it('goes on from the mirror alone when the server cannot answer', async () => {
        const store = await heldRedOverSynced(A);
        store.setRetryHooks({ serverRows: () => Promise.reject(new Error('offline')), overtaken: vi.fn() });

        await expect(store.retryFailedPersist()).resolves.toBe(true);

        expect((await db.annotations.get('a1'))?.color).toBe('#ff0000');
    });

    it('a newer edit of a conflicted mark here is the user’s latest word: it is written, and the conflict goes', async () => {
        const store = await heldRedOverSynced();
        const later = new Date(Date.now() + 60_000).toISOString();
        await db.annotations.put({ ...stroke('a1'), seq: 5, color: '#0000ff', updatedAt: later, pending: 0 });
        await store.retryFailedPersist();
        expect(store.conflictCount).toBe(1);

        await withFullDisk(() => store.update('a1', { color: '#333333' }));
        expect(store.conflictCount).toBe(0);
        await store.retryFailedPersist();
        expect((await db.annotations.get('a1'))?.color).toBe('#333333');
    });

    it('Dismiss lets the conflicts go once the user has seen them', async () => {
        const store = await heldRedOverSynced();
        await db.annotations.put({ ...stroke('a1'), seq: 9, color: '#0000ff', pending: 0 });
        await store.retryFailedPersist();
        expect(store.conflictCount).toBe(1);

        store.dismissConflicts();

        expect(store.conflictCount).toBe(0);
        expect(conflictMarksFor(null, DOC)).toEqual([]);
    });
});

describe('cancelled by sign-out (MAJOR 1, new finding 1)', () => {
    it('clear during a multi-chunk write: no chunk after the sign-out writes, and nothing is held again', async () => {
        const store = await storeAs(A);
        const marks = Array.from({ length: PERSIST_CHUNK + 10 }, (_, i) => stroke(`m${i}`));
        // Failing the mirror write (not the outbox's, after it): fake-indexeddb
        // is slow to roll back thousands of puts.
        const full = vi.spyOn(db.annotations, 'bulkPut').mockRejectedValue(quotaError());
        await store.createMany(marks).catch(() => undefined);
        full.mockRestore();
        expect(heldMarksFor(A, DOC)).toHaveLength(PERSIST_CHUNK + 10);

        const write = db.ops.bulkAdd.bind(db.ops);
        let chunks = 0;
        vi.spyOn(db.ops, 'bulkAdd').mockImplementation(((...args: Parameters<typeof db.ops.bulkAdd>) => {
            chunks += 1;
            return write(...args).then((key) => {
                // Sign-out lands while the first chunk is being written.
                clearAccountInk(A);
                return key;
            });
        }) as typeof db.ops.bulkAdd);

        const result = await retryHeld(A, DOC);

        expect(result.ok).toBe(false);
        expect(chunks).toBe(1);
        expect(await db.ops.count()).toBeLessThanOrEqual(PERSIST_CHUNK);
        expect(heldMarksFor(A, DOC)).toEqual([]);
        expect(unsavedMarkCount(A)).toBe(0);
    });

    it('a Retry started before the sign-out writes nothing once it has happened', async () => {
        await heldRedOverSynced(A);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const transaction = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) =>
            gate.then(() => transaction(...args))) as typeof db.transaction);

        const retry = retryHeld(A, DOC);
        clearAccountInk(A);
        release();

        await expect(retry).resolves.toMatchObject({ ok: false, wrote: [] });
        expect(await db.ops.count()).toBe(0);
        expect((await db.annotations.get('a1'))?.color).toBe('#111111');
    });

    it('an edit queued behind held ink when the account signs out is neither written nor held again', async () => {
        const store = await heldRedOverSynced(A);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const transaction = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) =>
            gate.then(() => transaction(...args))) as typeof db.transaction);

        const edit = store.update('a1', { color: '#00ff00' });
        await vi.waitFor(() => expect(db.transaction).toHaveBeenCalled());
        clearAccountInk(A);
        release();

        await expect(edit).rejects.toThrow(/signed out/);
        expect(await db.ops.count()).toBe(0);
        expect(heldMarksFor(A, DOC)).toEqual([]);
    });

    it('a day-snapshot failure that lands after the sign-out holds nothing for the account again', async () => {
        const store = await storeAs(A);
        let fail!: () => void;
        const failing = new Promise<never>((_, reject) => (fail = () => reject(quotaError())));
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockReturnValue(failing);

        const edit = store.create(stroke('late'));
        clearAccountInk(A);
        fail();

        await expect(edit).rejects.toThrow(/signed out/);
        expect(heldMarksFor(A, DOC)).toEqual([]);
        expect(unsavedMarkCount(A)).toBe(0);
        expect(store.getPage(0).has('late')).toBe(false);
    });

    it('store mounted after cleanup: a retained store forgets the cleared account’s held marks, then draws only B’s', async () => {
        const mounted = await heldRedOverSynced(A);
        await withFullDisk(() => mounted.create(stroke('a-secret')));
        mounted.attach();
        expect(mounted.getPage(0).has('a-secret')).toBe(true);

        clearAccountInk(A);

        await vi.waitFor(() => expect(mounted.get('a1')?.color).toBe('#111111'));
        expect(mounted.getPage(0).has('a-secret')).toBe(false);
        expect(mounted.canUndo).toBe(false);

        mounted.setAuthor(B);
        await vi.waitFor(() => expect(mounted.authorId).toBe(B));
        await mounted.create(stroke('b-own'));
        expect(mounted.get('a-secret')).toBeUndefined();
        expect((await db.ops.toArray()).map((op) => [op.annotationId, op.userId])).toEqual([['b-own', B]]);
    });

    it('a store not open for export still resets when the account changes after the registry cleared', async () => {
        const mounted = await storeAs(A);
        await withFullDisk(() => mounted.create(stroke('a-secret')));
        // Cleared first (the sequence Codex described), then the author changes.
        clearAccountInk(A);
        mounted.setAuthor(B);

        await vi.waitFor(() => expect(mounted.getPage(0).has('a-secret')).toBe(false));
        // A's undo history is not B's to replay.
        await mounted.undoLast();
        expect(await db.ops.count()).toBe(0);
    });

    it('clears only the signing-out account’s held ink; another account’s, and device-only scores’, stay', async () => {
        await withFullDisk(async () => (await storeAs(A)).create(stroke('a1')));
        await withFullDisk(async () => (await storeAs(B)).create(stroke('b1')));
        await withFullDisk(async () => (await storeAs(null, 'local-other')).create(stroke('local-1', 'local-other')));

        clearAccountInk(A);

        expect(heldMarksFor(A, DOC)).toEqual([]);
        expect(heldMarksFor(B, DOC).map((a) => a.id)).toEqual(['b1']);
        expect(heldMarksFor(null, 'local-other').map((a) => a.id)).toEqual(['local-1']);

        // Not knowing whose session ended, every account's goes; device-only stays.
        clearAccountInk(undefined);
        expect(heldMarksFor(B, DOC)).toEqual([]);
        expect(heldMarksFor(null, 'local-other').map((a) => a.id)).toEqual(['local-1']);
    });
});

describe('sign-out reaches the other tabs (MAJOR 1)', () => {
    it('tells them by BroadcastChannel', async () => {
        const otherTab = new BroadcastChannel('cleffy:ink-recovery');
        const heard = new Promise<unknown>((resolve) => (otherTab.onmessage = (event) => resolve(event.data)));
        try {
            clearAccountInk(A);
            await expect(heard).resolves.toEqual({ type: 'account-ink-cleared', userId: A });
        } finally {
            otherTab.close();
        }
    });

    it('drops that account’s held ink when another tab signs it out (BroadcastChannel)', async () => {
        const mounted = await storeAs(A);
        mounted.attach();
        await withFullDisk(() => mounted.create(stroke('a1')));
        await withFullDisk(async () => (await storeAs(B)).create(stroke('b1')));
        const otherTab = new BroadcastChannel('cleffy:ink-recovery');
        try {
            otherTab.postMessage({ type: 'account-ink-cleared', userId: A });
            await vi.waitFor(() => expect(heldMarksFor(A, DOC)).toEqual([]));
        } finally {
            otherTab.close();
        }
        expect(heldMarksFor(B, DOC).map((a) => a.id)).toEqual(['b1']);
        await vi.waitFor(() => expect(mounted.getPage(0).has('a1')).toBe(false));
    });

    it('drops it too on the storage-event fallback', async () => {
        await withFullDisk(async () => (await storeAs(A)).create(stroke('a1')));

        window.dispatchEvent(
            new StorageEvent('storage', {
                key: SIGNED_OUT_STORAGE_KEY,
                newValue: JSON.stringify({ type: 'account-ink-cleared', userId: A, at: 'x' }),
            }),
        );

        expect(heldMarksFor(A, DOC)).toEqual([]);
    });
});

describe('memory bounds without losing held ink (MAJOR 2, decision c)', () => {
    const fakeOps = (count: number, docId: string): AuthoredOp[] =>
        Array.from({ length: count }, (_, i) => ({
            op: { type: 'create', annotation: stroke(`f${i}`, docId) },
            author: null,
        }));

    it('memory cap without data loss: past MAX_HELD_SCORES a new score’s failed edit is undone and said so; nothing held goes', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const open = await storeAs(null, 'local-open');
        open.attach();
        await withFullDisk(() => open.create(stroke('kept', 'local-open')));
        for (let i = 1; i < MAX_HELD_SCORES; i++) {
            const docId = `local-doc-${i}`;
            await withFullDisk(async () => (await storeAs(null, docId)).create(stroke(`m${i}`, docId)));
        }

        const late = await storeAs(null, 'local-late');
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await expect(late.create(stroke('late', 'local-late'))).rejects.toBeInstanceOf(HeldInkFull);
        full.mockRestore();

        // Not held, so not drawn either: the banner says so (overflowCount) and offers Export.
        expect(late.getPage(0).has('late')).toBe(false);
        expect(late.overflowCount).toBe(1);
        expect(heldMarksFor(null, 'local-late')).toEqual([]);
        // Nothing already held was dropped to make room, open or not.
        expect(heldMarksFor(null, 'local-open').map((a) => a.id)).toEqual(['kept']);
        for (let i = 1; i < MAX_HELD_SCORES; i++) {
            expect(heldMarksFor(null, `local-doc-${i}`)).toHaveLength(1);
        }
    });

    it('the ops bound applies to an open score too, and an undone edit of an existing mark goes back to how it was', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await db.annotations.put({ ...stroke('a1'), pending: 0 });
        const open = await storeAs(null);
        open.attach();
        expect(holdOps(db, 'local-filler', fakeOps(MAX_HELD_OPS, 'local-filler'))).toEqual([]);

        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await expect(open.update('a1', { color: '#ff0000' })).rejects.toBeInstanceOf(HeldInkFull);
        full.mockRestore();

        expect(open.get('a1')?.color).toBe('#111111');
        expect(open.persistFailureCount).toBe(0);
        expect(overflowCount(null, DOC)).toBe(1);
        expect(heldMarksFor(null, 'local-filler')).toHaveLength(MAX_HELD_OPS);
    });

    it('refused-only scores count toward the bound as well', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        for (let i = 0; i < MAX_HELD_SCORES; i++) {
            expect(holdOps(db, `local-doc-${i}`, fakeOps(1, `local-doc-${i}`))).toEqual([]);
        }
        expect(holdOps(db, 'local-one-more', fakeOps(1, 'local-one-more'))).toHaveLength(1);
        expect(overflowCount(null, 'local-one-more')).toBe(1);
    });

    it('a Retry that works clears the notice', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = await storeAs(null);
        await withFullDisk(() => store.create(stroke('a1')));
        holdOps(db, 'local-filler', fakeOps(MAX_HELD_OPS - 1, 'local-filler'));
        await withFullDisk(() => store.create(stroke('a2')));
        expect(store.overflowCount).toBe(1);

        await expect(store.retryFailedPersist()).resolves.toBe(true);

        expect(store.overflowCount).toBe(0);
        expect(store.persistFailureCount).toBe(0);
    });
});
