import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SignOutSyncModule from '@/sync/signOutSync';
import { getDb } from '@/sync/db';

const signOutAuth = vi.fn(async (_options?: { scope?: string }) => ({ error: null }));
const getSession = vi.fn(async () => ({ data: { session: null as null | { user: { id: string } } } }));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        auth: {
            signOut: (options?: { scope?: string }) => signOutAuth(options),
            getSession: () => getSession(),
        },
    }),
}));

// Flipped on to make the pre-sign-out upload itself fail.
const drainFailure = vi.hoisted(() => ({ error: null as Error | null }));
// Flipped on to make stamping the outbox wait on a database that never answers.
const stampStall = vi.hoisted(() => ({ on: false }));
vi.mock('@/sync/signOutSync', async (importOriginal) => {
    const actual = await importOriginal<typeof SignOutSyncModule>();
    return {
        ...actual,
        drainCloudOutboxes: (...args: Parameters<typeof actual.drainCloudOutboxes>) =>
            drainFailure.error ? Promise.reject(drainFailure.error) : actual.drainCloudOutboxes(...args),
        stampOwnCloudOps: (...args: Parameters<typeof actual.stampOwnCloudOps>) =>
            stampStall.on ? new Promise<number>(() => undefined) : actual.stampOwnCloudOps(...args),
    };
});

import {
    SIGN_OUT_STORAGE_TIMEOUT_MS,
    signOut,
    signOutKeepingChanges,
    syncBeforeSignOut,
} from '@/features/auth/session';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import Dexie from 'dexie';

import {
    accountSignedIn,
    heldInkForExport,
    heldMarksFor,
    resetInkRecoveryForTests,
    signedOutInk,
} from '@/sync/inkRecovery';
import type { Annotation } from '@/types/models';

const CLOUD_DOC = 'c0ffee00-0000-4000-8000-0000000000bb';
const LOCAL_DOC = 'local-0123456789abcdef';

const mark = (id: string, docId: string): Annotation => ({
    id,
    docId,
    page: 0,
    kind: 'stroke',
    color: '#111111',
    payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

const seedAnnotationData = async () => {
    const db = getDb();
    await db.annotations.bulkPut([
        { ...mark('cloud-1', CLOUD_DOC), pending: 1 },
        { ...mark('local-1', LOCAL_DOC), pending: 1 },
    ]);
    await db.ops.bulkAdd([
        {
            docId: CLOUD_DOC,
            type: 'create',
            annotationId: 'cloud-1',
            annotation: mark('cloud-1', CLOUD_DOC),
            queuedAt: 'x',
        },
        {
            docId: LOCAL_DOC,
            type: 'create',
            annotationId: 'local-1',
            annotation: mark('local-1', LOCAL_DOC),
            queuedAt: 'x',
        },
    ]);
    await db.syncState.put({ docId: CLOUD_DOC, watermarkSeq: 40 });
    await db.annotationSnapshots.bulkPut([
        {
            id: 's-cloud',
            docId: CLOUD_DOC,
            capturedOn: '2026-10-01',
            label: null,
            payload: [],
            createdAt: 'x',
            createdBy: null,
            pending: 1,
        },
        {
            id: 's-local',
            docId: LOCAL_DOC,
            capturedOn: '2026-10-01',
            label: null,
            payload: [],
            createdAt: 'x',
            createdBy: null,
            pending: 0,
        },
    ]);
    await db.entitlements.put({ userId: 'user-1', entitlements: {} as never, cachedAt: 'x' });
};

describe('signOut', () => {
    beforeEach(async () => {
        signOutAuth.mockClear();
        const db = getDb();
        await Promise.all([
            db.pdfCache.clear(),
            db.thumbnails.clear(),
            db.scoreCache.clear(),
            db.libraryList.clear(),
            db.rosterCache.clear(),
            db.assignmentsCache.clear(),
            db.annotations.clear(),
            db.ops.clear(),
            db.syncState.clear(),
            db.annotationSnapshots.clear(),
            db.entitlements.clear(),
        ]);
    });

    it('signs out THIS device only, leaving the account signed in elsewhere', async () => {
        await signOut();

        // supabase-js defaults to `scope: 'global'`, which revokes every
        // refresh token the account has — so without this argument, signing
        // out of the studio iPad also signed out the teacher's laptop and
        // phone, with nothing in the UI that asked for it or said it had
        // happened. There is no "sign out everywhere" control in the app, so
        // the global behaviour was only ever reachable by accident.
        expect(signOutAuth).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('empties pdfCache and thumbnails', async () => {
        const db = getDb();
        await db.pdfCache.put({
            docId: 'doc-1',
            bytes: new ArrayBuffer(4),
            title: 'Score',
            cachedAt: '2026-08-01T00:00:00Z',
            userId: 'user-1',
        });
        await db.thumbnails.put({
            docId: 'doc-1',
            contentRev: 0,
            maxSide: 512,
            blob: new Blob(['x']),
            width: 1,
            height: 1,
            createdAt: '2026-08-01T00:00:00Z',
        });

        await signOut();

        expect(signOutAuth).toHaveBeenCalled();
        expect(await db.pdfCache.count()).toBe(0);
        expect(await db.thumbnails.count()).toBe(0);
    });

    it("clears the account's cloud-score marks, outbox, watermarks and snapshots", async () => {
        await seedAnnotationData();
        const db = getDb();

        await signOut();

        expect((await db.annotations.toArray()).map((r) => r.id)).toEqual(['local-1']);
        expect((await db.ops.toArray()).map((r) => r.annotationId)).toEqual(['local-1']);
        expect(await db.syncState.count()).toBe(0);
        expect((await db.annotationSnapshots.toArray()).map((r) => r.id)).toEqual(['s-local']);
        expect(await db.entitlements.count()).toBe(0);
    });

    it('cuts off the account’s marks this device could not store (SF-1), keeping them in this tab for Export or Discard (round 3), and no other account’s', async () => {
        getSession.mockResolvedValueOnce({ data: { session: { user: { id: 'user-1' } } } });
        const db = getDb();
        const store = new AnnotationStore(db, CLOUD_DOC);
        store.setAuthor('user-1');
        await store.load();
        const full = vi
            .spyOn(db.ops, 'bulkAdd')
            .mockRejectedValue(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
        const earlier = new AnnotationStore(db, CLOUD_DOC);
        earlier.setAuthor('user-0');
        await earlier.load();
        try {
            await store.create(mark('cloud-unsaved', CLOUD_DOC)).catch(() => undefined);
            await earlier.create(mark('cloud-earlier', CLOUD_DOC)).catch(() => undefined);
        } finally {
            full.mockRestore();
        }
        expect(heldMarksFor('user-1', CLOUD_DOC)).toHaveLength(1);

        await signOut();

        // No viewer draws it and nothing retries it…
        expect(heldMarksFor('user-1', CLOUD_DOC)).toEqual([]);
        expect(store.persistFailureCount).toBe(0);
        // …but it is not destroyed: kept, signed out, for Export or Discard.
        expect(heldInkForExport('user-1', CLOUD_DOC).held.map((a) => a.id)).toEqual(['cloud-unsaved']);
        expect(signedOutInk().map((account) => [account.userId, account.reason])).toEqual([['user-1', 'here']]);
        // An account whose session ended here earlier without signing out keeps its own.
        expect(heldMarksFor('user-0', CLOUD_DOC).map((a) => a.id)).toEqual(['cloud-earlier']);
        // The next account to sign in here: the signed-out ink goes.
        accountSignedIn('user-2');
        expect(heldInkForExport('user-1', CLOUD_DOC).held).toEqual([]);
        resetInkRecoveryForTests();
    });
});

describe('syncBeforeSignOut', () => {
    beforeEach(async () => {
        const db = getDb();
        await Promise.all([db.annotations.clear(), db.ops.clear(), db.annotationSnapshots.clear()]);
        getSession.mockClear();
    });

    it('reports nothing to lose when the outbox is empty (local scores do not count)', async () => {
        const db = getDb();
        await db.ops.add({
            docId: LOCAL_DOC,
            type: 'create',
            annotationId: 'local-1',
            annotation: mark('local-1', LOCAL_DOC),
            queuedAt: 'x',
        });
        expect(await syncBeforeSignOut(50)).toEqual({ pending: 0, refused: 0 });
    });

    it('reports the unsynced cloud changes it could not upload', async () => {
        await seedAnnotationData();
        // No session to upload with (already expired): nothing can go up.
        expect(await syncBeforeSignOut(50)).toEqual({ pending: 1, refused: 0 });
        // Nothing was cleared by asking.
        expect(await getDb().ops.count()).toBe(2);
    });

    it('counts marks an open viewer could not even write to this device (SF-1)', async () => {
        const db = getDb();
        const store = new AnnotationStore(db, CLOUD_DOC);
        store.setAuthor('user-1');
        await store.load();
        const full = vi
            .spyOn(db.ops, 'bulkAdd')
            .mockRejectedValue(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
        try {
            await store.create(mark('cloud-unsaved', CLOUD_DOC)).catch(() => undefined);
            // The outbox is empty, so the upload alone would say nothing is at stake.
            expect(await db.ops.count()).toBe(0);
            expect(await syncBeforeSignOut(50)).toEqual({ pending: 1, refused: 0 });
        } finally {
            full.mockRestore();
            await store.retryFailedPersist();
        }
        expect(await syncBeforeSignOut(50)).toEqual({ pending: 1, refused: 0 });
    });

    it('still says which changes are another account’s when the upload fails', async () => {
        await seedAnnotationData();
        await getDb().ops.add({
            docId: CLOUD_DOC,
            type: 'create',
            annotationId: 'cloud-2',
            annotation: mark('cloud-2', CLOUD_DOC),
            queuedAt: 'x',
            userId: 'user-1',
        });
        getSession.mockResolvedValueOnce({ data: { session: { user: { id: 'user-1' } } } });
        drainFailure.error = new Error('boom');
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            // cloud-1 predates PendingOp.userId on a score user-1 never cached.
            expect(await syncBeforeSignOut(50)).toEqual({ pending: 2, refused: 0, foreign: 1 });
        } finally {
            drainFailure.error = null;
            vi.restoreAllMocks();
        }
    });
});

describe('signOutKeepingChanges', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        stampStall.on = false;
        resetInkRecoveryForTests();
    });

    it('stalled keep-changes sign-out: a never-settling IndexedDB cannot hold it, and nothing is written after', async () => {
        getSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } });
        signOutAuth.mockClear();
        // The ink's own database: it took the failed write, and now never answers.
        const stalled = new ScribblerDb(`stalled-${crypto.randomUUID()}`);
        const store = new AnnotationStore(stalled, CLOUD_DOC);
        store.setAuthor('user-1');
        await store.load();
        const full = vi
            .spyOn(stalled.ops, 'bulkAdd')
            .mockRejectedValue(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
        await store.create(mark('cloud-unsaved', CLOUD_DOC)).catch(() => undefined);
        full.mockRestore();
        expect(heldMarksFor('user-1', CLOUD_DOC)).toHaveLength(1);

        let unstall!: () => void;
        const stall = new Promise<void>((resolve) => (unstall = resolve));
        const transaction = stalled.transaction.bind(stalled) as (...args: unknown[]) => Promise<unknown>;
        const stalledWrite = vi
            .spyOn(stalled, 'transaction')
            .mockImplementation(((...args: unknown[]) =>
                stall.then(() => transaction(...args))) as typeof stalled.transaction);
        // Stamping the outbox stalls too.
        stampStall.on = true;
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        let settled = false;
        const signedOut = signOutKeepingChanges().finally(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(SIGN_OUT_STORAGE_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        expect(stalledWrite).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(SIGN_OUT_STORAGE_TIMEOUT_MS * 3);

        // Signed out regardless: the ended session is gone. Its held ink is
        // out of every viewer, and kept in this tab for Export or Discard.
        await expect(signedOut).resolves.toBe(0);
        expect(signOutAuth).toHaveBeenCalledWith({ scope: 'local' });
        expect(heldMarksFor('user-1', CLOUD_DOC)).toEqual([]);
        expect(heldInkForExport('user-1', CLOUD_DOC).held.map((a) => a.id)).toEqual(['cloud-unsaved']);

        // The stalled database answers at last: the Retry still waiting on it writes nothing.
        vi.useRealTimers();
        unstall();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await stalled.ops.count()).toBe(0);
        expect(await stalled.annotations.get('cloud-unsaved')).toBeUndefined();
        expect(heldInkForExport('user-1', CLOUD_DOC).held.map((a) => a.id)).toEqual(['cloud-unsaved']);
    });

    it('stalled inside the transaction, with every later step stalled too: signed out within one 5 s deadline, and the write rolls back when storage answers', async () => {
        getSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } });
        signOutAuth.mockClear();
        const stalled = new ScribblerDb(`stalled-${crypto.randomUUID()}`);
        await stalled.annotations.put({ ...mark('cloud-held', CLOUD_DOC), seq: 3, pending: 0 });
        const store = new AnnotationStore(stalled, CLOUD_DOC);
        store.setAuthor('user-1');
        await store.load();
        const full = vi
            .spyOn(stalled.ops, 'bulkAdd')
            .mockRejectedValue(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
        await store.update('cloud-held', { color: '#ff0000' }).catch(() => undefined);
        full.mockRestore();
        expect(heldMarksFor('user-1', CLOUD_DOC)).toHaveLength(1);

        // The Retry gets inside its transaction — the mirror row put — and
        // then the outbox write hangs, the transaction held open.
        let unstall!: () => void;
        const stall = new Promise<void>((resolve) => (unstall = resolve));
        let inside = false;
        const write = stalled.ops.bulkAdd.bind(stalled.ops);
        vi.spyOn(stalled.ops, 'bulkAdd').mockImplementation(((...args: Parameters<typeof stalled.ops.bulkAdd>) => {
            inside = true;
            return Dexie.waitFor(stall, 120_000).then(() => write(...args));
        }) as typeof stalled.ops.bulkAdd);
        // Stamping the outbox, and the cache clear after it, stall as well.
        stampStall.on = true;
        const db = getDb();
        vi.spyOn(db.scoreCache, 'clear').mockReturnValue(new Promise(() => undefined) as never);
        // Real time: fake-indexeddb runs its transactions on timers, so they
        // cannot be faked while one is under way.
        const started = Date.now();
        await expect(signOutKeepingChanges()).resolves.toBe(0);
        const took = Date.now() - started;
        expect(inside).toBe(true);
        // One deadline for every step, not one per step: 5 s, not 10 or 15.
        expect(took).toBeGreaterThanOrEqual(SIGN_OUT_STORAGE_TIMEOUT_MS - 50);
        expect(took).toBeLessThan(SIGN_OUT_STORAGE_TIMEOUT_MS + 2000);
        expect(signOutAuth).toHaveBeenCalledWith({ scope: 'local' });
        expect(heldInkForExport('user-1', CLOUD_DOC).held.map((a) => a.color)).toEqual(['#ff0000']);

        // Storage answers: the transaction's last check finds the account
        // signed out, and it rolls back whole — the mirror row too.
        unstall();
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(await stalled.ops.count()).toBe(0);
        expect((await stalled.annotations.get('cloud-held'))?.color).toBe('#111111');
        expect(heldInkForExport('user-1', CLOUD_DOC).held.map((a) => a.color)).toEqual(['#ff0000']);
    }, 20_000);

    it('writes the held ink first when storage answers, so it is kept with the account’s queued changes', async () => {
        getSession.mockResolvedValue({ data: { session: { user: { id: 'user-1' } } } });
        const db = getDb();
        await Promise.all([db.annotations.clear(), db.ops.clear()]);
        const store = new AnnotationStore(db, CLOUD_DOC);
        store.setAuthor('user-1');
        await store.load();
        const full = vi
            .spyOn(db.ops, 'bulkAdd')
            .mockRejectedValue(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
        await store.create(mark('cloud-unsaved', CLOUD_DOC)).catch(() => undefined);
        full.mockRestore();

        await expect(signOutKeepingChanges()).resolves.toBe(1);

        expect((await db.ops.toArray()).map((op) => [op.annotationId, op.userId])).toEqual([
            ['cloud-unsaved', 'user-1'],
        ]);
        expect(heldMarksFor('user-1', CLOUD_DOC)).toEqual([]);
    });
});
