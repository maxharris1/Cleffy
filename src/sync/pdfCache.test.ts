import Dexie from 'dexie';
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

import { readOfflineStorage } from '@/features/account/offlineStorage';
import { getCachedPdf, getCachedPdfMeta, putCachedPdf, updateCachedPdfMeta } from '@/sync/pdfCache';

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

/** The v9 schema, as a build from before pdfMeta existed opened the database. */
const V9_STORES = {
    annotations: 'id, docId, [docId+page], [docId+seq]',
    ops: '++opId, docId',
    syncState: 'docId',
    pdfCache: 'docId',
    annotationSnapshots: 'id, docId, &[docId+capturedOn], capturedOn',
    scoreCache: 'docId',
    fingeringRegions: 'id, docId, createdAt',
    entitlements: 'userId',
    thumbnails: 'docId',
    libraryList: 'userId',
    rosterCache: 'userId',
    assignmentsCache: 'userId',
};

describe('cached PDF metadata (pdfMeta)', () => {
    it('backfills the metadata of a copy cached before v10, then reads it without the bytes', async () => {
        const name = `pdfcache-v9-${crypto.randomUUID()}`;
        const old = new Dexie(name);
        old.version(9).stores(V9_STORES);
        await old.table('pdfCache').put({ ...cacheRow(A), bytes: new ArrayBuffer(1234) });
        old.close();
        db = new ScribblerDb(name);

        expect(await db.pdfMeta.count()).toBe(0);
        const meta = await getCachedPdfMeta(DOC);
        expect(meta).toMatchObject({ docId: DOC, title: 'Score', myRole: 'editor', userId: A, size: 1234 });
        expect(meta).not.toHaveProperty('bytes');
        expect(await db.pdfMeta.get(DOC)).toEqual(meta);

        const get = vi.spyOn(db.pdfCache, 'get');
        expect(await getCachedPdfMeta(DOC)).toEqual(meta);
        expect(get).not.toHaveBeenCalled();
    });

    it('returns the role written to the metadata alone, with the bytes unchanged', async () => {
        const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;
        expect(await putCachedPdf({ ...cacheRow(A), bytes })).toBe(true);

        expect(await updateCachedPdfMeta(DOC, { myRole: 'viewer', archivedAt: '2026-02-01T00:00:00.000Z' })).toBe(true);

        // The file row is never rewritten; the metadata wins on read.
        expect((await db.pdfCache.get(DOC))?.myRole).toBe('editor');
        const row = await getCachedPdf(DOC);
        expect(row).toMatchObject({ myRole: 'viewer', archivedAt: '2026-02-01T00:00:00.000Z', userId: A });
        expect(row).not.toHaveProperty('size');
        expect(new Uint8Array(row!.bytes as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
        expect((await getCachedPdfMeta(DOC))?.myRole).toBe('viewer');
    });

    it('does not update metadata when there is no cached copy', async () => {
        expect(await updateCachedPdfMeta(DOC, { myRole: 'viewer' })).toBe(false);
        expect(await db.pdfMeta.count()).toBe(0);
    });

    it('treats metadata whose file is gone as no copy, and removes it', async () => {
        expect(await putCachedPdf(cacheRow(A))).toBe(true);
        // A delete that removed the file and not its metadata.
        await db.pdfCache.delete(DOC);

        expect(await getCachedPdf(DOC)).toBeNull();
        expect(await getCachedPdfMeta(DOC)).toBeNull();
        expect(await db.pdfMeta.get(DOC)).toBeUndefined();
        expect(await updateCachedPdfMeta(DOC, { myRole: 'owner' })).toBe(false);
        expect(await db.pdfMeta.get(DOC)).toBeUndefined();
    });

    it('hands unstamped ops to the old account when the metadata changes hands', async () => {
        expect(await putCachedPdf(cacheRow(A))).toBe(true);
        await queueUnstamped('legacy');
        expect(await owns(A)).toEqual(['legacy']);

        expect(await updateCachedPdfMeta(DOC, { userId: C })).toBe(true);

        expect((await db.ops.toArray())[0]?.userId).toBe(A);
        expect((await getCachedPdfMeta(DOC))?.userId).toBe(C);
        expect(await owns(C)).toEqual([]);
        expect(await owns(A)).toEqual(['legacy']);
    });

    it('leaves unstamped ops alone on a metadata change that keeps the account', async () => {
        expect(await putCachedPdf(cacheRow(A))).toBe(true);
        await queueUnstamped('legacy');

        expect(await updateCachedPdfMeta(DOC, { userId: A, title: 'Renamed' })).toBe(true);

        expect((await db.ops.toArray())[0]?.userId).toBeUndefined();
        expect(await owns(A)).toEqual(['legacy']);
    });

    it('totals offline storage from the metadata without reading the files', async () => {
        const OTHER = 'c0ffee00-0000-4000-8000-0000000000c2';
        expect(await putCachedPdf({ ...cacheRow(A), bytes: new ArrayBuffer(1000) })).toBe(true);
        expect(await putCachedPdf({ ...cacheRow(A), docId: OTHER, bytes: new ArrayBuffer(500) })).toBe(true);

        const get = vi.spyOn(db.pdfCache, 'get');
        const toArray = vi.spyOn(db.pdfCache, 'toArray');
        const each = vi.spyOn(db.pdfCache, 'each');

        expect(await readOfflineStorage()).toEqual({ scoreCount: 2, bytes: 1500 });
        expect(get).not.toHaveBeenCalled();
        expect(toArray).not.toHaveBeenCalled();
        expect(each).not.toHaveBeenCalled();
    });
});
