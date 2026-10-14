import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DbModule from '@/sync/db';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { opOwnerFor } from '@/sync/opOwnership';
import type { Annotation } from '@/types/models';

let db: ScribblerDb;
vi.mock('@/sync/db', async (importOriginal) => ({
    ...(await importOriginal<typeof DbModule>()),
    getDb: () => db,
}));

import { putCachedPdf } from '@/sync/pdfCache';

const DOC = 'c0ffee00-0000-4000-8000-0000000000c1';
const A = 'user-a';
const C = 'user-c';

const stroke = (id: string): Annotation => ({
    id,
    docId: DOC,
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

const cacheRow = (userId: string | undefined) => ({
    docId: DOC,
    bytes: new ArrayBuffer(8),
    title: 'Score',
    cachedAt: '2026-01-01T00:00:00.000Z',
    myRole: 'editor' as const,
    ...(userId ? { userId } : {}),
});

/** An op queued by a build before PendingOp.userId existed. */
const queueUnstamped = async (id: string) => {
    const store = new AnnotationStore(db, DOC);
    await store.create(stroke(id));
    expect((await db.ops.toArray()).find((op) => op.annotationId === id)?.userId).toBeUndefined();
};

const owns = async (userId: string) => {
    const ops = await db.ops.toArray();
    const owner = await opOwnerFor(db, DOC, userId, ops);
    return ops.filter(owner).map((op) => op.annotationId);
};

beforeEach(() => {
    db = new ScribblerDb(`pdfcache-${crypto.randomUUID()}`);
});

describe('putCachedPdf', () => {
    it('keeps unstamped ops with the account that cached the score when another one opens it', async () => {
        await db.pdfCache.put(cacheRow(A));
        await queueUnstamped('legacy');
        expect(await owns(A)).toEqual(['legacy']);

        // C opens the score online: fetchMyRole restamps the cache row.
        expect(await putCachedPdf(cacheRow(C))).toBe(true);

        expect((await db.pdfCache.get(DOC))?.userId).toBe(C);
        expect(await owns(C)).toEqual([]);
        expect(await owns(A)).toEqual(['legacy']);
    });

    it('leaves the ops alone while the score stays with the same account', async () => {
        await db.pdfCache.put(cacheRow(A));
        await queueUnstamped('legacy');

        expect(await putCachedPdf({ ...cacheRow(A), title: 'Renamed' })).toBe(true);

        expect((await db.ops.toArray())[0]?.userId).toBeUndefined();
        expect(await owns(A)).toEqual(['legacy']);
    });

    it('cannot say whose they are when the row never named an account', async () => {
        await db.pdfCache.put(cacheRow(undefined));
        await queueUnstamped('legacy');

        expect(await putCachedPdf(cacheRow(C))).toBe(true);

        // As before: the first account to cache the score takes them.
        expect(await owns(C)).toEqual(['legacy']);
    });
});
