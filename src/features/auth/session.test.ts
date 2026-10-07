import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '@/sync/db';

const signOutAuth = vi.fn(async () => ({ error: null }));
const getSession = vi.fn(async () => ({ data: { session: null as null | { user: { id: string } } } }));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        auth: {
            signOut: () => signOutAuth(),
            getSession: () => getSession(),
        },
    }),
}));

import { signOut, syncBeforeSignOut } from '@/features/auth/session';
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
        expect(await syncBeforeSignOut(50)).toBe(0);
    });

    it('reports the unsynced cloud changes it could not upload', async () => {
        await seedAnnotationData();
        // No session to upload with (already expired): nothing can go up.
        expect(await syncBeforeSignOut(50)).toBe(1);
        // Nothing was cleared by asking.
        expect(await getDb().ops.count()).toBe(2);
    });
});
