import { beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('@/sync/signOutSync', async (importOriginal) => {
    const actual = await importOriginal<typeof SignOutSyncModule>();
    return {
        ...actual,
        drainCloudOutboxes: (...args: Parameters<typeof actual.drainCloudOutboxes>) =>
            drainFailure.error ? Promise.reject(drainFailure.error) : actual.drainCloudOutboxes(...args),
    };
});

import { signOut, syncBeforeSignOut } from '@/features/auth/session';
import { AnnotationStore } from '@/sync/annotationStore';
import { heldMarksFor, resetInkRecoveryForTests } from '@/sync/inkRecovery';
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

    it('forgets the account’s marks this device could not store, after the warning (SF-1)', async () => {
        const db = getDb();
        const store = new AnnotationStore(db, CLOUD_DOC);
        store.setAuthor('user-1');
        await store.load();
        const full = vi
            .spyOn(db.ops, 'bulkAdd')
            .mockRejectedValue(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
        try {
            await store.create(mark('cloud-unsaved', CLOUD_DOC)).catch(() => undefined);
        } finally {
            full.mockRestore();
        }
        expect(heldMarksFor('user-1', CLOUD_DOC)).toHaveLength(1);

        await signOut();

        // The next account in this tab finds nothing of it to draw, export or retry.
        expect(heldMarksFor('user-1', CLOUD_DOC)).toEqual([]);
        expect(store.persistFailureCount).toBe(0);
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
