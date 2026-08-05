import { afterEach, describe, expect, it } from 'vitest';

import { readCachedRegion, regionCacheKey, writeCachedRegion } from '@/features/fingering/cache';
import { emptyRegion } from '@/features/fingering/model';
import { ScribblerDb } from '@/sync/db';
import type { Annotation } from '@/types/models';

const RECT = { x: 0.1, y: 0.3, w: 0.4, h: 0.15 };
const ASPECT = 0.75;

const textAt = (id: string, x: number, y: number, updatedAt = '2026-08-05T00:00:00.000Z'): Annotation => ({
    id,
    docId: 'doc',
    page: 0,
    kind: 'text',
    color: '#dc2626',
    payload: { x, y, text: '3', size: 0.018 },
    createdBy: null,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt,
    deletedAt: null,
    seq: 0,
});

const keyFor = (overrides?: Partial<Parameters<typeof regionCacheKey>[0]>) =>
    regionCacheKey({
        docId: 'doc',
        page: 0,
        rect: RECT,
        contentRev: 1,
        annotations: [],
        aspect: ASPECT,
        ...overrides,
    });

describe('regionCacheKey', () => {
    it('is stable for identical inputs and quantizes marquee jitter away', async () => {
        expect(await keyFor()).toBe(await keyFor());
        expect(await keyFor({ rect: { ...RECT, x: RECT.x + 0.0001 } })).toBe(await keyFor());
        expect(await keyFor({ rect: { ...RECT, x: RECT.x + 0.01 } })).not.toBe(await keyFor());
    });

    it('invalidates on edits to annotations inside the region, ignores outside ones', async () => {
        const inside = textAt('in', 0.2, 0.35);
        const outside = textAt('out', 0.9, 0.9);
        const base = await keyFor({ annotations: [inside, outside] });
        expect(await keyFor({ annotations: [outside] })).not.toBe(base);
        const edited = { ...inside, updatedAt: '2026-08-05T01:00:00.000Z' };
        expect(await keyFor({ annotations: [edited, outside] })).not.toBe(base);
        // Outside-the-region churn doesn't matter — the crop never saw it.
        expect(await keyFor({ annotations: [inside] })).toBe(base);
    });

    it('invalidates when the PDF bytes are replaced (contentRev bump)', async () => {
        expect(await keyFor({ contentRev: 2 })).not.toBe(await keyFor({ contentRev: 1 }));
    });
});

describe('read/write cached regions', () => {
    let db: ScribblerDb | null = null;

    afterEach(async () => {
        await db?.delete();
        db = null;
    });

    it('round-trips the post-review region', async () => {
        db = new ScribblerDb(`test-fingering-cache-${crypto.randomUUID()}`);
        const key = await keyFor();
        expect(await readCachedRegion(db, key)).toBeNull();
        const region = { ...emptyRegion('doc', 0, RECT), keySignature: 2, source: 'vision' as const };
        await writeCachedRegion(db, key, region);
        const cached = await readCachedRegion(db, key);
        expect(cached?.keySignature).toBe(2);
        expect(cached?.source).toBe('vision');
    });

    it('prunes the oldest rows past the cap', async () => {
        db = new ScribblerDb(`test-fingering-cache-${crypto.randomUUID()}`);
        for (let i = 0; i < 305; i++) {
            await db.fingeringRegions.put({
                id: `row-${i}`,
                docId: 'doc',
                page: 0,
                region: emptyRegion('doc', 0, RECT),
                createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
            });
        }
        await writeCachedRegion(db, 'newest', emptyRegion('doc', 0, RECT));
        expect(await db.fingeringRegions.count()).toBeLessThanOrEqual(300);
        expect(await db.fingeringRegions.get('newest')).toBeDefined();
        expect(await db.fingeringRegions.get('row-0')).toBeUndefined();
    });
});
