import { describe, expect, it } from 'vitest';

import { ScribblerDb } from '@/sync/db';

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
