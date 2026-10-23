import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as snapshotService from '@/features/viewer/history/snapshotService';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { isCutOffWrite } from '@/sync/cutOffWrites';
import {
    accountSignedIn,
    boundTo,
    closeDocInk,
    conflictCount,
    conflictMarksFor,
    discardSignedOutInk,
    forgetDocInk,
    HeldInkFull,
    heldInkForExport,
    heldMarksFor,
    holdOps,
    lostAccessInk,
    MAX_HELD_OPS,
    MAX_HELD_SCORES,
    noteRefusedEdit,
    overflowCount,
    PERSIST_CHUNK,
    persistOps,
    refusedEditCount,
    rememberScoreSource,
    resetInkRecoveryForTests,
    retireAccountInk,
    retryHeld,
    signedOutInk,
    SIGNED_OUT_STORAGE_KEY,
    unsavedMarkCount,
    type AuthoredOp,
} from '@/sync/inkRecovery';
import { hasSignedOutInk } from '@/sync/inkRecoverySignal';
import { opOwnerFor } from '@/sync/opOwnership';
import type { Annotation } from '@/types/models';

/**
 * Launchfix P2 round 2: the cases Codex's second review listed as untested.
 * Cancellation across sign-out (a Retry spanning it, a multi-chunk write, a
 * store still mounted), latest-wins against versions newer than the held
 * one (another tab's upload, a collaborator's on the server), the memory
 * bounds without losing held ink, and sign-out reaching the other tabs.
 *
 * Round 3 (decision 63): held ink is never destroyed without an explicit
 * choice that offers Export first. Sign-out — here or in another tab — cuts
 * off writes but keeps the ink (retireAccountInk); a write cut off while its
 * transaction runs never lands, and one that commits all the same is swept.
 */

/** The signed-out account's ink this tab still holds, for Export (marks ids). */
const keptForExport = (userId: string, docId = DOC): string[] =>
    heldInkForExport(userId, docId)
        .held.map((a) => a.id)
        .sort();

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

/** Hold every mirror + outbox write (a transaction over the outbox) until `release`. */
const gateWrites = (): { release: () => void; spy: ReturnType<typeof vi.spyOn> } => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const transaction = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
    const spy = vi
        .spyOn(db, 'transaction')
        .mockImplementation(((...args: unknown[]) =>
            args.includes(db.ops)
                ? gate.then(() => transaction(...args))
                : transaction(...args)) as typeof db.transaction);
    return { release, spy };
};

/** Run `then` once the next mirror + outbox write has committed, before its writer sees it done. */
const afterNextWrite = (then: () => void): void => {
    const transaction = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
    let done = false;
    vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
        if (done || !args.includes(db.ops)) {
            return transaction(...args);
        }
        done = true;
        return transaction(...args).then((result) => {
            then();
            return result;
        });
    }) as typeof db.transaction);
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

    it('Dismiss only hides the notice: the conflict stays for Export; Discard lets it go (round 3, item 1)', async () => {
        const store = await heldRedOverSynced();
        await db.annotations.put({ ...stroke('a1'), seq: 9, color: '#0000ff', pending: 0 });
        await store.retryFailedPersist();
        expect(store.conflictCount).toBe(1);

        store.hideConflictNotice();

        expect(store.conflictNoticeHidden).toBe(true);
        expect(store.conflictCount).toBe(1);
        expect(conflictMarksFor(null, DOC).map((a) => a.color)).toEqual(['#ff0000']);
        expect(heldInkForExport(null, DOC).conflicts.map((a) => a.color)).toEqual(['#ff0000']);

        store.discardConflicts();

        expect(store.conflictCount).toBe(0);
        expect(conflictMarksFor(null, DOC)).toEqual([]);
    });

    it('a newly overtaken mark shows the hidden conflict notice again', async () => {
        await db.annotations.bulkPut([
            { ...stroke('a1'), seq: 5, pending: 0 },
            { ...stroke('a2'), seq: 5, pending: 0 },
        ]);
        const store = await storeAs(null);
        await withFullDisk(() => store.update('a1', { color: '#ff0000' }));
        await db.annotations.put({ ...stroke('a1'), seq: 9, color: '#0000ff', pending: 0 });
        await store.retryFailedPersist();
        store.hideConflictNotice();

        await withFullDisk(() => store.update('a2', { color: '#ff0000' }));
        await db.annotations.put({ ...stroke('a2'), seq: 9, color: '#00ff00', pending: 0 });
        await store.retryFailedPersist();

        expect(store.conflictCount).toBe(2);
        expect(store.conflictNoticeHidden).toBe(false);
    });
});

describe('cut off by sign-out, never dropped (MAJOR 1; round 3 items 2–4)', () => {
    it('sign-out between the chunks of a long write: no later chunk writes, and what was not written is kept', async () => {
        const store = await storeAs(A);
        const marks = Array.from({ length: PERSIST_CHUNK + 10 }, (_, i) => stroke(`m${i}`));
        // Failing the mirror write (not the outbox's, after it): fake-indexeddb
        // is slow to roll back thousands of puts.
        const full = vi.spyOn(db.annotations, 'bulkPut').mockRejectedValue(quotaError());
        await store.createMany(marks).catch(() => undefined);
        full.mockRestore();
        expect(heldMarksFor(A, DOC)).toHaveLength(PERSIST_CHUNK + 10);

        const transaction = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
        let chunks = 0;
        vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) => {
            chunks += 1;
            if (chunks === 2) {
                // Sign-out lands once the first chunk is written.
                retireAccountInk(A);
            }
            return transaction(...args);
        }) as typeof db.transaction);

        const result = await retryHeld(A, DOC);

        expect(result.ok).toBe(false);
        expect(await db.ops.count()).toBe(PERSIST_CHUNK);
        // Out of every viewer, count and Retry, but not lost: kept for Export.
        expect(heldMarksFor(A, DOC)).toEqual([]);
        expect(unsavedMarkCount(A)).toBe(0);
        expect(heldInkForExport(A, DOC).held).toHaveLength(10);
    });

    it('a stall inside the transaction: the sign-out cuts the write off, which then rolls back whole when storage answers', async () => {
        await heldRedOverSynced(A);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const write = db.ops.bulkAdd.bind(db.ops);
        let stalled!: () => void;
        const inside = new Promise<void>((resolve) => (stalled = resolve));
        vi.spyOn(db.ops, 'bulkAdd').mockImplementation(((...args: Parameters<typeof db.ops.bulkAdd>) => {
            // The mirror row is already put in this transaction; the outbox
            // write hangs, the transaction kept open (Dexie.waitFor).
            stalled();
            return Dexie.waitFor(gate).then(() => write(...args));
        }) as typeof db.ops.bulkAdd);

        const retry = retryHeld(A, DOC);
        await inside;
        retireAccountInk(A);
        release();

        await expect(retry).resolves.toMatchObject({ ok: false, wrote: [] });
        // Rolled back whole: neither the outbox op nor the mirror row it put.
        expect(await db.ops.count()).toBe(0);
        expect((await db.annotations.get('a1'))?.color).toBe('#111111');
        expect(keptForExport(A)).toEqual(['a1']);
        expect(heldInkForExport(A, DOC).held[0]?.color).toBe('#ff0000');
    });

    it('a write whose transaction commits after the sign-out cut it off: kept in memory, and its rows swept as stale on the next load', async () => {
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        await db.syncState.put({ docId: DOC, watermarkSeq: 5 });
        const store = await storeAs(A);
        // Committed; the sign-out lands before this tab sees it done.
        afterNextWrite(() => retireAccountInk(A));

        await expect(store.update('a1', { color: '#ff0000' })).rejects.toThrow(/signed out/);
        vi.restoreAllMocks();

        // The late commit is in storage, but nobody's (opOwnerFor)…
        const [late] = await db.ops.toArray();
        expect(late && isCutOffWrite(late)).toBe(true);
        const owns = await opOwnerFor(db, DOC, A, late ? [late] : []);
        expect(late && owns(late)).toBe(false);
        // …the edit is kept for Export, not drawn…
        expect(keptForExport(A)).toEqual(['a1']);
        expect(store.get('a1')?.color).not.toBe('#ff0000');

        // …and the next load sweeps it: op, the mirror row it wrote, and the
        // watermark, so the next pull brings back the server's version.
        accountSignedIn(B);
        const reopened = await storeAs(B);
        expect(await db.ops.count()).toBe(0);
        expect(await db.annotations.get('a1')).toBeUndefined();
        expect(await db.syncState.get(DOC)).toBeUndefined();
        expect(reopened.get('a1')).toBeUndefined();
        // The pull that follows draws the server's version again.
        await expect(reopened.applyRemoteBatch([{ ...stroke('a1'), seq: 5 }], new Set())).resolves.toEqual(new Set());
        expect(reopened.get('a1')?.color).toBe('#111111');
    });

    it('a store attached after a late commit sweeps it too', async () => {
        const store = await storeAs(A);
        afterNextWrite(() => retireAccountInk(A));
        await expect(store.create(stroke('late'))).rejects.toThrow(/signed out/);
        vi.restoreAllMocks();
        expect(await db.ops.count()).toBe(1);

        store.attach();

        await vi.waitFor(async () => expect(await db.ops.count()).toBe(0));
        expect(await db.annotations.get('late')).toBeUndefined();
        expect(keptForExport(A)).toEqual(['late']);
    });

    it('a Retry started before the sign-out writes nothing once it has happened, and the ink stays', async () => {
        await heldRedOverSynced(A);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const transaction = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(db, 'transaction').mockImplementation(((...args: unknown[]) =>
            gate.then(() => transaction(...args))) as typeof db.transaction);

        const retry = retryHeld(A, DOC);
        retireAccountInk(A);
        release();

        await expect(retry).resolves.toMatchObject({ ok: false, wrote: [] });
        expect(await db.ops.count()).toBe(0);
        expect((await db.annotations.get('a1'))?.color).toBe('#111111');
        expect(keptForExport(A)).toEqual(['a1']);
    });

    it('an edit queued behind held ink when the account signs out is not written, and is kept with it (persistMany rolls it back)', async () => {
        const store = await heldRedOverSynced(A);
        const { release, spy } = gateWrites();

        const edit = store.update('a1', { color: '#00ff00' });
        await vi.waitFor(() => expect(spy.mock.calls.some((args: unknown[]) => args.includes(db.ops))).toBe(true));
        expect(store.get('a1')?.color).toBe('#00ff00');
        retireAccountInk(A);
        release();

        await expect(edit).rejects.toThrow(/signed out/);
        expect(await db.ops.count()).toBe(0);
        // Not drawn here any more…
        expect(store.get('a1')?.color).not.toBe('#00ff00');
        // …but the user's latest word on it is kept for Export.
        expect(heldInkForExport(A, DOC).held.map((a) => a.color)).toEqual(['#00ff00']);
    });

    it('persistMany rolls back on RecoveryCancelled: a cancelled create is not left drawn', async () => {
        const store = await storeAs(A);
        const { release, spy } = gateWrites();
        const noReset = vi.spyOn(store, 'accountSignedOut').mockImplementation(() => undefined);

        const edit = store.create(stroke('x'));
        expect(store.getPage(0).has('x')).toBe(true);
        await vi.waitFor(() => expect(spy.mock.calls.some((args: unknown[]) => args.includes(db.ops))).toBe(true));
        retireAccountInk(A);
        release();

        await expect(edit).rejects.toThrow(/signed out/);
        expect(noReset).not.toHaveBeenCalled(); // not attached: only the rollback hides it
        expect(store.getPage(0).has('x')).toBe(false);
        expect(store.get('x')).toBeUndefined();
        expect(keptForExport(A)).toEqual(['x']);
    });

    it('a day-snapshot failure that lands after the sign-out keeps the drawn mark for Export, not on screen', async () => {
        const store = await storeAs(A);
        let fail!: () => void;
        const failing = new Promise<never>((_, reject) => (fail = () => reject(quotaError())));
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockReturnValue(failing);

        const edit = store.create(stroke('late'));
        retireAccountInk(A);
        fail();

        await expect(edit).rejects.toThrow(/signed out/);
        expect(heldMarksFor(A, DOC)).toEqual([]);
        expect(unsavedMarkCount(A)).toBe(0);
        expect(store.getPage(0).has('late')).toBe(false);
        expect(keptForExport(A)).toEqual(['late']);
    });

    it('createMany applies nothing after a cancelled await (sign-out during its day-snapshot check)', async () => {
        const store = await storeAs(A);
        let release!: () => void;
        const gate = new Promise<null>((resolve) => (release = () => resolve(null)));
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockReturnValue(gate);

        const imported = store.createMany([stroke('i1'), stroke('i2')]);
        retireAccountInk(A);
        release();

        await expect(imported).rejects.toThrow(/signed out/);
        expect(store.get('i1')).toBeUndefined();
        expect(store.getPage(0).size).toBe(0);
        expect(store.canUndo).toBe(false);
        expect(await db.ops.count()).toBe(0);
    });

    it('createMany applies nothing once memory was reset for another account while it waited', async () => {
        const store = await storeAs(A);
        let release!: () => void;
        const gate = new Promise<null>((resolve) => (release = () => resolve(null)));
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockReturnValueOnce(gate);

        const imported = store.createMany([stroke('i1')]);
        store.setAuthor(B);
        release();

        await expect(imported).rejects.toThrow(/signed out/);
        await vi.waitFor(() => expect(store.authorId).toBe(B));
        expect(store.get('i1')).toBeUndefined();
        expect(await db.ops.count()).toBe(0);
    });

    it('an edit of an existing mark resuming after the reset is not applied to the next account’s memory', async () => {
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        const store = await storeAs(A);
        let release!: () => void;
        const gate = new Promise<null>((resolve) => (release = () => resolve(null)));
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockReturnValueOnce(gate);

        const edit = store.update('a1', { color: '#ff0000' });
        store.setAuthor(B);
        await vi.waitFor(() => expect(store.get('a1')?.color).toBe('#111111'));
        release();

        await edit;
        expect(store.get('a1')?.color).toBe('#111111');
        expect(await db.ops.count()).toBe(0);
    });

    it('store mounted at sign-out: it forgets what it drew for the account, then draws only B’s; the ink is kept for Export', async () => {
        const mounted = await heldRedOverSynced(A);
        await withFullDisk(() => mounted.create(stroke('a-secret')));
        mounted.attach();
        expect(mounted.getPage(0).has('a-secret')).toBe(true);

        retireAccountInk(A);

        await vi.waitFor(() => expect(mounted.get('a1')?.color).toBe('#111111'));
        expect(mounted.getPage(0).has('a-secret')).toBe(false);
        expect(mounted.canUndo).toBe(false);
        expect(mounted.persistFailureCount).toBe(0);
        expect(keptForExport(A)).toEqual(['a-secret', 'a1']);

        mounted.setAuthor(B);
        await vi.waitFor(() => expect(mounted.authorId).toBe(B));
        await mounted.create(stroke('b-own'));
        expect(mounted.get('a-secret')).toBeUndefined();
        expect((await db.ops.toArray()).map((op) => [op.annotationId, op.userId])).toEqual([['b-own', B]]);
    });

    it('a store not open for export still resets when the account changes after the sign-out', async () => {
        const mounted = await storeAs(A);
        await withFullDisk(() => mounted.create(stroke('a-secret')));
        retireAccountInk(A);
        mounted.setAuthor(B);

        await vi.waitFor(() => expect(mounted.getPage(0).has('a-secret')).toBe(false));
        // A's undo history is not B's to replay.
        await mounted.undoLast();
        expect(await db.ops.count()).toBe(0);
    });

    it('cuts off only the signing-out account; another account’s held ink, and device-only scores’, stay as they were', async () => {
        await withFullDisk(async () => (await storeAs(A)).create(stroke('a1')));
        await withFullDisk(async () => (await storeAs(B)).create(stroke('b1')));
        await withFullDisk(async () => (await storeAs(null, 'local-other')).create(stroke('local-1', 'local-other')));

        retireAccountInk(A);

        expect(heldMarksFor(A, DOC)).toEqual([]);
        expect(keptForExport(A)).toEqual(['a1']);
        expect(heldMarksFor(B, DOC).map((a) => a.id)).toEqual(['b1']);
        expect(heldMarksFor(null, 'local-other').map((a) => a.id)).toEqual(['local-1']);

        // Not knowing whose session ended, every account's is cut off; device-only is untouched.
        retireAccountInk(undefined);
        expect(heldMarksFor(B, DOC)).toEqual([]);
        expect(keptForExport(B)).toEqual(['b1']);
        expect(heldMarksFor(null, 'local-other').map((a) => a.id)).toEqual(['local-1']);
    });
});

describe('signed-out ink: Export or Discard, until the tab closes or another account signs in (round 3, items 2–3)', () => {
    it('is out of Retry and of every write: the account’s writes are cut off at once', async () => {
        await withFullDisk(async () => (await storeAs(A)).create(stroke('a1')));
        retireAccountInk(A);

        expect(boundTo(A)()).toBe(false);
        await expect(persistOps(db, A, DOC, [{ type: 'create', annotation: stroke('a2') }])).rejects.toThrow(
            /signed out/,
        );
        await expect(retryHeld(A, DOC)).resolves.toMatchObject({ wrote: [] });
        expect(await db.ops.count()).toBe(0);
        expect(keptForExport(A)).toEqual(['a1', 'a2']);
    });

    it('is listed for the notice, and goes only on Discard', async () => {
        await withFullDisk(async () => (await storeAs(A)).create(stroke('a1')));
        retireAccountInk(A);

        expect(hasSignedOutInk()).toBe(true);
        expect(signedOutInk()).toEqual([{ userId: A, reason: 'here', scores: [{ docId: DOC, marks: 1 }] }]);

        discardSignedOutInk();

        expect(signedOutInk()).toEqual([]);
        expect(hasSignedOutInk()).toBe(false);
        expect(keptForExport(A)).toEqual([]);
    });

    it('comes back to the same account signing in again: drawn and retried as before', async () => {
        await withFullDisk(async () => (await storeAs(A)).create(stroke('a1')));
        retireAccountInk(A);

        accountSignedIn(A);

        expect(signedOutInk()).toEqual([]);
        const reopened = await storeAs(A);
        expect(reopened.getPage(0).has('a1')).toBe(true);
        await expect(reopened.retryFailedPersist()).resolves.toBe(true);
        expect((await db.ops.toArray()).map((op) => op.annotationId)).toEqual(['a1']);
    });

    it('goes when another account signs in here', async () => {
        await withFullDisk(async () => (await storeAs(A)).create(stroke('a1')));
        await withFullDisk(async () => (await storeAs(null, 'local-other')).create(stroke('local-1', 'local-other')));
        retireAccountInk(A);

        accountSignedIn(B);

        expect(keptForExport(A)).toEqual([]);
        expect(hasSignedOutInk()).toBe(false);
        expect(heldMarksFor(null, 'local-other').map((a) => a.id)).toEqual(['local-1']);
    });

    it('keeps the score’s PDF and title from its viewer for Export, after the viewer has closed', async () => {
        const { rememberScoreSource } = await import('@/sync/inkRecovery');
        const bytes = new ArrayBuffer(8);
        const close = rememberScoreSource(DOC, 'Sonata', bytes);
        await withFullDisk(async () => (await storeAs(A)).create(stroke('a1')));
        close();
        retireAccountInk(A);

        expect(signedOutInk()[0]?.scores).toEqual([{ docId: DOC, marks: 1, title: 'Sonata', bytes }]);

        discardSignedOutInk(A);
        // Let go with the ink.
        rememberScoreSource(DOC, 'Sonata')();
        expect(signedOutInk()).toEqual([]);
    });
});

describe('sign-out reaches the other tabs (MAJOR 1; round 3 item 2)', () => {
    it('tells them by BroadcastChannel', async () => {
        const otherTab = new BroadcastChannel('cleffy:ink-recovery');
        const heard = new Promise<unknown>((resolve) => (otherTab.onmessage = (event) => resolve(event.data)));
        try {
            retireAccountInk(A);
            await expect(heard).resolves.toEqual({ type: 'account-signed-out', userId: A });
        } finally {
            otherTab.close();
        }
    });

    it('cross-tab sign-out while this tab holds ink: writes stop at once, the ink stays for Export or Discard, and the notice says so', async () => {
        const mounted = await storeAs(A);
        mounted.attach();
        await withFullDisk(() => mounted.create(stroke('a1')));
        await withFullDisk(async () => (await storeAs(B)).create(stroke('b1')));
        const otherTab = new BroadcastChannel('cleffy:ink-recovery');
        try {
            otherTab.postMessage({ type: 'account-signed-out', userId: A });
            await vi.waitFor(() => expect(hasSignedOutInk()).toBe(true));
        } finally {
            otherTab.close();
        }
        expect(signedOutInk()).toEqual([{ userId: A, reason: 'other-tab', scores: [{ docId: DOC, marks: 1 }] }]);
        // Kept, not drawn, not retried, not written.
        expect(keptForExport(A)).toEqual(['a1']);
        await vi.waitFor(() => expect(mounted.getPage(0).has('a1')).toBe(false));
        expect(mounted.persistFailureCount).toBe(0);
        expect(boundTo(A)()).toBe(false);
        // Another account's held ink in this tab is untouched.
        expect(heldMarksFor(B, DOC).map((a) => a.id)).toEqual(['b1']);
    });

    it('keeps it too on the storage-event fallback', async () => {
        await withFullDisk(async () => (await storeAs(A)).create(stroke('a1')));

        window.dispatchEvent(
            new StorageEvent('storage', {
                key: SIGNED_OUT_STORAGE_KEY,
                newValue: JSON.stringify({ type: 'account-signed-out', userId: A, at: 'x' }),
            }),
        );

        expect(heldMarksFor(A, DOC)).toEqual([]);
        expect(keptForExport(A)).toEqual(['a1']);
        expect(signedOutInk()[0]?.reason).toBe('other-tab');
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

    it('noteRefusedEdit past the bounds makes no entry and counts no refusal: said as overflow instead', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        for (let i = 0; i < MAX_HELD_SCORES; i++) {
            expect(holdOps(db, `local-doc-${i}`, fakeOps(1, `local-doc-${i}`))).toEqual([]);
        }

        noteRefusedEdit(db, null, 'local-refused', [stroke('s1', 'local-refused')]);
        noteRefusedEdit(db, null, 'local-refused', [stroke('s1', 'local-refused')]);

        expect(refusedEditCount(null, 'local-refused')).toBe(0);
        expect(overflowCount(null, 'local-refused')).toBe(2);
        // No entry: the bound on scores still holds exactly.
        expect(holdOps(db, 'local-another', fakeOps(1, 'local-another'))).toHaveLength(1);
        // Within the bounds it is counted, with its starting point.
        noteRefusedEdit(db, null, 'local-doc-0', [stroke('s2', 'local-doc-0')]);
        expect(refusedEditCount(null, 'local-doc-0')).toBe(1);
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

describe('a Retry under way when the score is lost to this device (PR #72 fix 1)', () => {
    /** The lost score's closed ink, for Export (mark ids and colours). */
    const closedInk = (userId: string): string[] =>
        heldInkForExport(userId, DOC, true).held.map((a) => `${a.id}:${a.color}`);

    it('closed while its server check is out: the Retry writes nothing, and the closed ink stays for Export', async () => {
        await heldRedOverSynced(A);
        let answer!: (rows: Annotation[]) => void;
        const serverRows = vi.fn(() => new Promise<Annotation[]>((resolve) => (answer = resolve)));

        const retry = retryHeld(A, DOC, { serverRows });
        await vi.waitFor(() => expect(serverRows).toHaveBeenCalled());
        // Access lost (purgeLocalDocument) while the server is still answering.
        closeDocInk(DOC);
        answer([{ ...stroke('a1'), seq: 5 }]);

        await expect(retry).resolves.toMatchObject({ ok: false, wrote: [] });
        expect(await db.ops.count()).toBe(0);
        expect((await db.annotations.get('a1'))?.color).toBe('#111111');
        expect(closedInk(A)).toEqual(['a1:#ff0000']);
        expect(lostAccessInk().map((score) => [score.userId, score.docId, score.marks])).toEqual([[A, DOC, 1]]);
        expect(heldMarksFor(A, DOC)).toEqual([]);
    });

    it('closed while its write waits on storage: the write rolls back, and the closed ink stays for Export', async () => {
        await heldRedOverSynced(A);
        const { release } = gateWrites();

        const retry = retryHeld(A, DOC);
        await Promise.resolve();
        closeDocInk(DOC);
        release();

        await expect(retry).resolves.toMatchObject({ ok: false, wrote: [] });
        expect(await db.ops.count()).toBe(0);
        expect((await db.annotations.get('a1'))?.color).toBe('#111111');
        expect(closedInk(A)).toEqual(['a1:#ff0000']);
    });
});

describe('an ordinary edit under way when the score is lost to this device (PR #72 fix round 2)', () => {
    const closedInk = (userId: string): string[] =>
        heldInkForExport(userId, DOC, true)
            .held.map((a) => `${a.id}:${a.color}`)
            .sort();

    /** purgeLocalDocument's local half, on this test's database: close the ink, then delete the score's rows. */
    const purge = async (): Promise<void> => {
        closeDocInk(DOC);
        await Promise.all([
            db.syncState.delete(DOC),
            db.annotations.where('docId').equals(DOC).delete(),
            db.ops.where('docId').equals(DOC).delete(),
            db.annotationSnapshots.where('docId').equals(DOC).delete(),
        ]);
    };

    /** Resolves once the store hands its next write to inkRecovery.persistOps. */
    const nextWrite = (store: AnnotationStore): Promise<void> => {
        const writes = store as unknown as { writeMany(...args: unknown[]): Promise<void> };
        const write = writes.writeMany.bind(store);
        return new Promise((resolve) => {
            vi.spyOn(writes, 'writeMany').mockImplementationOnce((...args: unknown[]) => {
                const run = write(...args);
                resolve();
                return run;
            });
        });
    };

    it('queued behind a Retry awaiting the server, then the score closed and purged: neither recreates the mark or its outbox row, and both are kept as closed ink', async () => {
        accountSignedIn(A);
        const store = await heldRedOverSynced(A);
        let answer!: (rows: Annotation[]) => void;
        const serverRows = vi.fn(() => new Promise<Annotation[]>((resolve) => (answer = resolve)));

        // 1. Retry awaits the server.
        const retry = retryHeld(A, DOC, { serverRows });
        await vi.waitFor(() => expect(serverRows).toHaveBeenCalled());
        // 2. An ordinary write queues behind it.
        const queued = nextWrite(store);
        const edit = store.create(stroke('a2'));
        await queued;
        // 3. The score is lost: closed and purged, all of it done.
        await purge();
        // 4. The server answers, and the Retry is cut off.
        answer([{ ...stroke('a1'), seq: 5 }]);
        await expect(retry).resolves.toMatchObject({ ok: false, wrote: [] });

        // 5. The queued write is cut off too: nothing recreated in the purged score.
        await expect(edit).rejects.toThrow(/closed/);
        expect(await db.annotations.count()).toBe(0);
        expect(await db.ops.count()).toBe(0);
        // The user's marks are kept for Export (both), not drawn, not retried.
        expect(closedInk(A)).toEqual(['a1:#ff0000', 'a2:#111111']);
        expect(lostAccessInk().map((score) => [score.userId, score.docId, score.marks])).toEqual([[A, DOC, 2]]);
        expect(heldMarksFor(A, DOC)).toEqual([]);
        expect(store.getPage(0).has('a2')).toBe(false);
    });

    it('closed while it waits on its day snapshot: no snapshot, mark or outbox row is written, and the edit is kept as closed ink', async () => {
        accountSignedIn(A);
        const store = await storeAs(A);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        const ensure = snapshotService.ensureDayStartingSnapshot;
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockImplementation(async (...args) => {
            await gate;
            return ensure(...args);
        });

        const edit = store.create(stroke('a1'));
        await purge();
        release();

        await expect(edit).rejects.toThrow(/closed/);
        expect(await db.annotationSnapshots.count()).toBe(0);
        expect(await db.annotations.count()).toBe(0);
        expect(await db.ops.count()).toBe(0);
        expect(closedInk(A)).toEqual(['a1:#111111']);
        expect(store.getPage(0).has('a1')).toBe(false);
    });

    it('the user deleting the score themselves lets a queued edit go with it: nothing written, nothing kept', async () => {
        accountSignedIn(A);
        const store = await storeAs(A);
        const { release, spy } = gateWrites();

        const edit = store.create(stroke('a1'));
        await vi.waitFor(() => expect(spy.mock.calls.some((args: unknown[]) => args.includes(db.ops))).toBe(true));
        forgetDocInk(DOC);
        release();

        await expect(edit).rejects.toThrow(/closed/);
        expect(await db.ops.count()).toBe(0);
        expect(await db.annotations.count()).toBe(0);
        expect(closedInk(A)).toEqual([]);
        expect(lostAccessInk()).toEqual([]);
    });

    describe('fix round 3', () => {
        it('an older edit cut off after the score closed, reopened and closed again never replaces the newer version of its mark in the closed ink', async () => {
            accountSignedIn(A);
            const synced = [
                { ...stroke('a1'), seq: 5, pending: 0 as const },
                { ...stroke('a2'), seq: 6, pending: 0 as const },
            ];
            await db.annotations.bulkPut(synced);
            const store = await storeAs(A);
            // Held ink, so a Retry has something to write: a2 recoloured blue on a full disk.
            await withFullDisk(() => store.update('a2', { color: '#0000ff' }));
            let answer!: (rows: Annotation[]) => void;
            const serverRows = vi.fn(() => new Promise<Annotation[]>((resolve) => (answer = resolve)));
            const retry = retryHeld(A, DOC, { serverRows });
            await vi.waitFor(() => expect(serverRows).toHaveBeenCalled());

            // 1. An ordinary red edit of a1 queues behind the Retry.
            const queued = nextWrite(store);
            const red = store.update('a1', { color: '#ff0000' });
            await queued;
            // 2. The score closes, 3. reopens, and a newer green edit of a1 fails storage...
            await purge();
            await db.annotations.bulkPut(synced);
            const reopened = await storeAs(A);
            await withFullDisk(() => reopened.update('a1', { color: '#00ff00' }));
            expect(heldMarksFor(A, DOC).map((a) => `${a.id}:${a.color}`)).toEqual(['a1:#00ff00']);
            // 4. ...and it closes again.
            await purge();
            expect(closedInk(A)).toEqual(['a1:#00ff00', 'a2:#0000ff']);

            // 5. The old Retry releases, and the red edit queued behind it is cut off.
            answer([]);
            await expect(retry).resolves.toMatchObject({ ok: false, wrote: [] });
            await expect(red).rejects.toThrow(/closed/);

            // Kept, but behind the newer green: Export has green.
            expect(closedInk(A)).toEqual(['a1:#00ff00', 'a2:#0000ff']);
            expect(lostAccessInk().map((score) => [score.userId, score.docId, score.marks])).toEqual([[A, DOC, 2]]);
            expect(await db.ops.count()).toBe(0);
        });

        it('fix round 4: the newer edit compacted over an older held update of its mark is not then replaced by an older edit kept late', async () => {
            accountSignedIn(A);
            const synced = [
                { ...stroke('a1'), seq: 5, pending: 0 as const },
                { ...stroke('a2'), seq: 6, pending: 0 as const },
            ];
            await db.annotations.bulkPut(synced);
            const store = await storeAs(A);
            // Held ink: a1 recoloured yellow, then a2 blue, both on a full disk.
            await withFullDisk(() => store.update('a1', { color: '#ffff00' }));
            await withFullDisk(() => store.update('a2', { color: '#0000ff' }));
            let answer!: (rows: Annotation[]) => void;
            const serverRows = vi.fn(() => new Promise<Annotation[]>((resolve) => (answer = resolve)));
            const retry = retryHeld(A, DOC, { serverRows });
            await vi.waitFor(() => expect(serverRows).toHaveBeenCalled());

            // 1. An ordinary red edit of a1 queues behind the Retry.
            const queued = nextWrite(store);
            const red = store.update('a1', { color: '#ff0000' });
            await queued;
            // 2. The score closes, 3. reopens, and a newer green edit of a1 fails storage...
            await purge();
            expect(closedInk(A)).toEqual(['a1:#ffff00', 'a2:#0000ff']);
            await db.annotations.bulkPut(synced);
            const reopened = await storeAs(A);
            await withFullDisk(() => reopened.update('a1', { color: '#00ff00' }));
            // 4. ...and it closes again: green takes yellow's place as a1's held update.
            await purge();
            expect(closedInk(A)).toEqual(['a1:#00ff00', 'a2:#0000ff']);

            // 5. The old Retry releases, and the red edit queued behind it is cut off.
            answer([]);
            await expect(retry).resolves.toMatchObject({ ok: false, wrote: [] });
            await expect(red).rejects.toThrow(/closed/);

            // Kept, but behind the newer green: Export has green.
            expect(closedInk(A)).toEqual(['a1:#00ff00', 'a2:#0000ff']);
            expect(lostAccessInk().map((score) => [score.userId, score.docId, score.marks])).toEqual([[A, DOC, 2]]);
            expect(await db.ops.count()).toBe(0);
        });

        it('a first create waiting on its day snapshot when access is lost keeps the PDF for its closed ink, so Export needs no server', async () => {
            accountSignedIn(A);
            const store = await storeAs(A);
            const bytes = new ArrayBuffer(8);
            const closeViewer = rememberScoreSource(DOC, 'Sonata', bytes);
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            const ensure = snapshotService.ensureDayStartingSnapshot;
            vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockImplementation(async (...args) => {
                await gate;
                return ensure(...args);
            });

            const edit = store.create(stroke('a1'));
            // Access lost: the viewer's state clears (its PDF let go), and the score is purged.
            closeViewer();
            await purge();
            release();

            await expect(edit).rejects.toThrow(/closed/);
            expect(lostAccessInk()).toEqual([{ docId: DOC, userId: A, marks: 1, title: 'Sonata', bytes }]);
            expect(closedInk(A)).toEqual(['a1:#111111']);
        });

        it('a first create waiting on storage when access is lost keeps the PDF for its closed ink, so Export needs no server', async () => {
            accountSignedIn(A);
            const store = await storeAs(A);
            const bytes = new ArrayBuffer(8);
            const closeViewer = rememberScoreSource(DOC, 'Sonata', bytes);
            const queued = nextWrite(store);
            const { release } = gateWrites();

            const edit = store.create(stroke('a1'));
            await queued;
            closeViewer();
            await purge();
            release();

            await expect(edit).rejects.toThrow(/closed/);
            expect(await db.ops.count()).toBe(0);
            expect(lostAccessInk()).toEqual([{ docId: DOC, userId: A, marks: 1, title: 'Sonata', bytes }]);
            expect(closedInk(A)).toEqual(['a1:#111111']);
        });

        it('once the edit under way is saved, the PDF goes with its viewer', async () => {
            accountSignedIn(A);
            const store = await storeAs(A);
            const closeViewer = rememberScoreSource(DOC, 'Sonata', new ArrayBuffer(8));
            const queued = nextWrite(store);
            const { release } = gateWrites();

            const edit = store.create(stroke('a1'));
            await queued;
            closeViewer();
            release();
            await edit;

            // Ink held for the score later, with no viewer open, has no PDF of it kept.
            await withFullDisk(() => store.create(stroke('a2')));
            closeDocInk(DOC);
            expect(lostAccessInk()).toEqual([{ docId: DOC, userId: A, marks: 1 }]);
        });
    });
});
