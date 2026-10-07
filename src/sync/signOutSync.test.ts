import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { clearCloudAnnotationData, drainCloudOutboxes, pendingCloudOpCount } from '@/sync/signOutSync';
import { SyncEngine, type AnnotationsApi } from '@/sync/syncEngine';
import type { Annotation } from '@/types/models';

const DOC_A = 'c0ffee00-0000-4000-8000-00000000000a';
const DOC_B = 'c0ffee00-0000-4000-8000-00000000000b';
const LOCAL = 'local-feedfacecafebeef';

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

const makeApi = (online: { value: boolean }): AnnotationsApi & { inserted: string[] } => {
    const inserted: string[] = [];
    const down = { message: 'Failed to fetch', kind: 'retry' as const };
    return {
        inserted,
        async insertIgnoreDuplicates(row) {
            if (!online.value) {
                return { error: down };
            }
            inserted.push(row.id);
            return { error: null };
        },
        async insertMany(rows) {
            for (const row of rows) {
                const { error } = await this.insertIgnoreDuplicates(row);
                if (error) {
                    return { error };
                }
            }
            return { error: null };
        },
        async update() {
            return { error: online.value ? null : down, updatedIds: null };
        },
        async updateMany() {
            return { error: online.value ? null : down, updatedIds: null };
        },
        async fetchOne() {
            return { data: null, error: online.value ? null : down };
        },
        async fetchSince() {
            return { data: [], error: online.value ? null : down };
        },
    };
};

let db: ScribblerDb;

const queue = async (docId: string, id: string) => {
    await new AnnotationStore(db, docId).create(mark(id, docId));
};

beforeEach(() => {
    db = new ScribblerDb(`test-${crypto.randomUUID()}`);
});

describe('drainCloudOutboxes', () => {
    it("uploads every cloud score's outbox and reports nothing left", async () => {
        await queue(DOC_A, 'a1');
        await queue(DOC_B, 'b1');
        await queue(LOCAL, 'l1');
        const api = makeApi({ value: true });

        const remaining = await drainCloudOutboxes({ db, api, getUserId: () => 'user-1', timeoutMs: 2000 });

        expect(remaining).toBe(0);
        expect(api.inserted.sort()).toEqual(['a1', 'b1']);
        // Local scores are never uploaded and never counted.
        expect(await db.ops.where('docId').equals(LOCAL).count()).toBe(1);
    });

    it('reports what is still pending when the server cannot be reached', async () => {
        await queue(DOC_A, 'a1');
        await queue(DOC_A, 'a2');

        const remaining = await drainCloudOutboxes({
            db,
            api: makeApi({ value: false }),
            getUserId: () => 'user-1',
            timeoutMs: 2000,
        });

        expect(remaining).toBe(2);
        expect(await pendingCloudOpCount(db)).toBe(2);
    });

    it('drains through the open viewer engine for its document instead of a second one', async () => {
        await queue(DOC_A, 'a1');
        const api = makeApi({ value: true });
        const store = new AnnotationStore(db, DOC_A);
        const engine = new SyncEngine({ db, store, api, docId: DOC_A, getUserId: () => 'user-1' });
        engine.start();
        const flush = vi.spyOn(engine, 'flush');

        await drainCloudOutboxes({ db, api, getUserId: () => 'user-1', timeoutMs: 2000 });

        expect(flush).toHaveBeenCalled();
        engine.stop();
    });

    it('gives up at the timeout instead of holding sign-out hostage', async () => {
        await queue(DOC_A, 'a1');
        const hanging: AnnotationsApi = {
            ...makeApi({ value: true }),
            insertMany: () => new Promise(() => undefined),
            insertIgnoreDuplicates: () => new Promise(() => undefined),
        };
        const started = Date.now();
        const remaining = await drainCloudOutboxes({ db, api: hanging, getUserId: () => 'user-1', timeoutMs: 50 });
        expect(remaining).toBe(1);
        expect(Date.now() - started).toBeLessThan(1500);
    });
});

describe('clearCloudAnnotationData', () => {
    it('removes cloud-score data and keeps device-only scores', async () => {
        await queue(DOC_A, 'a1');
        await queue(LOCAL, 'l1');
        await db.syncState.put({ docId: DOC_A, watermarkSeq: 12 });

        await clearCloudAnnotationData(db);

        expect((await db.annotations.toArray()).map((r) => r.id)).toEqual(['l1']);
        expect((await db.ops.toArray()).map((r) => r.annotationId)).toEqual(['l1']);
        expect(await db.syncState.count()).toBe(0);
        expect((await db.annotationSnapshots.toArray()).every((r) => r.docId === LOCAL)).toBe(true);
    });
});
