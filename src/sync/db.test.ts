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
