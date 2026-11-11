import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';

import type { LocalAnnotationSnapshot } from '@/features/viewer/history/snapshotTypes';
import { pickDuplicateSnapshots, ScribblerDb } from '@/sync/db';

describe('ScribblerDb v3 (scoreCache)', () => {
    it('upgrades v2 data and round-trips a cached analysis', async () => {
        const name = `test-db-${crypto.randomUUID()}`;

        // Seed a v2-era database (no scoreCache table)…
        const v2 = new ScribblerDb(name);
        await v2.open();
        await v2.pdfCache.put({ docId: 'doc-1', bytes: new Blob(['x']), title: 'Sonata', cachedAt: '2026-01-01' });
        v2.close();

        // …then reopen: v3 adds scoreCache without disturbing existing rows.
        const db = new ScribblerDb(name);
        await db.open();
        expect((await db.pdfCache.get('doc-1'))?.title).toBe('Sonata');

        await db.scoreCache.put({
            docId: 'doc-1',
            status: 'ready',
            error: null,
            score: null,
            engineVersion: 'audiveris-test',
            bpmDefault: 90,
            bpmOverride: 72,
            fetchedAt: '2026-01-02',
        });
        const cached = await db.scoreCache.get('doc-1');
        expect(cached?.status).toBe('ready');
        expect(cached?.bpmOverride).toBe(72);

        await db.delete();
    });
});

describe('ScribblerDb v6 (thumbnails)', () => {
    it('adds the thumbnails store without disturbing the cached PDFs', async () => {
        const name = `test-db-${crypto.randomUUID()}`;

        const seed = new ScribblerDb(name);
        await seed.open();
        await seed.pdfCache.put({ docId: 'doc-1', bytes: new Blob(['x']), title: 'Sonata', cachedAt: '2026-01-01' });
        seed.close();

        const db = new ScribblerDb(name);
        await db.open();
        // v6 restates every store, so nothing that already existed is dropped.
        expect((await db.pdfCache.get('doc-1'))?.title).toBe('Sonata');

        await db.thumbnails.put({
            docId: 'doc-1',
            contentRev: 2,
            maxSide: 512,
            blob: new Blob(['png'], { type: 'image/png' }),
            width: 181,
            height: 256,
            createdAt: '2026-01-02',
        });
        // Metadata only: fake-indexeddb's structured clone hands back a Blob
        // stripped of jsdom's read methods, so the bytes are not asserted here.
        const thumb = await db.thumbnails.get('doc-1');
        expect(thumb?.contentRev).toBe(2);
        expect(thumb?.width).toBe(181);
        expect(thumb?.height).toBe(256);

        await db.delete();
    });
});

describe('ScribblerDb v8/v9 (one day snapshot per score and day)', () => {
    const snap = (id: string, overrides: Partial<LocalAnnotationSnapshot> = {}): LocalAnnotationSnapshot => ({
        id,
        docId: 'doc-1',
        capturedOn: '2026-10-01',
        label: null,
        payload: [],
        createdAt: '2026-10-01T09:00:00Z',
        createdBy: null,
        pending: 0,
        ...overrides,
    });

    it('dedupes existing day snapshots before building the unique index', async () => {
        const name = `test-db-${crypto.randomUUID()}`;

        // A v7 database as shipped, holding the duplicates the old non-unique
        // index allowed: two devices' rows for the same day.
        const v7 = new Dexie(name);
        v7.version(7).stores({
            annotations: 'id, docId, [docId+page], [docId+seq]',
            ops: '++opId, docId',
            syncState: 'docId',
            pdfCache: 'docId',
            annotationSnapshots: 'id, docId, [docId+capturedOn], capturedOn',
            scoreCache: 'docId',
            fingeringRegions: 'id, docId, createdAt',
            entitlements: 'userId',
            thumbnails: 'docId',
            libraryList: 'userId',
            rosterCache: 'userId',
            assignmentsCache: 'userId',
        });
        await v7.open();
        await v7
            .table('annotationSnapshots')
            .bulkPut([
                snap('local-pending', { pending: 1, createdAt: '2026-10-01T08:00:00Z' }),
                snap('server-later', { createdAt: '2026-10-01T09:30:00Z' }),
                snap('server-first', { createdAt: '2026-10-01T09:00:00Z' }),
                snap('other-day', { capturedOn: '2026-10-02', pending: 1 }),
            ]);
        await v7.table('pdfCache').put({ docId: 'doc-1', bytes: new ArrayBuffer(1), title: 'Sonata', cachedAt: 'x' });
        v7.close();

        const db = new ScribblerDb(name);
        await db.open();

        const rows = await db.annotationSnapshots.orderBy('id').toArray();
        // Server-acked beats pending; then the earliest capture.
        expect(rows.map((r) => r.id)).toEqual(['other-day', 'server-first']);
        expect((await db.pdfCache.get('doc-1'))?.title).toBe('Sonata');

        // The index is unique now: a second row for a day is refused.
        await expect(db.annotationSnapshots.add(snap('dupe'))).rejects.toMatchObject({ name: 'ConstraintError' });

        await db.delete();
    });

    it('pickDuplicateSnapshots keeps one row per score-day', () => {
        const losers = pickDuplicateSnapshots([snap('a', { pending: 1 }), snap('b'), snap('c', { docId: 'doc-2' })]);
        expect(losers.map((r) => r.id)).toEqual(['a']);
    });
});
