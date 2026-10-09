import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnnotationStore } from '@/sync/annotationStore';
import { startBackgroundDrain, stopAllBackgroundDrains, type BackgroundDrain } from '@/sync/backgroundDrain';
import { ScribblerDb } from '@/sync/db';
import { SyncEngine, type AnnotationsApi, type ApiError } from '@/sync/syncEngine';
import type { AnnotationInsert } from '@/types/database';
import type { Annotation } from '@/types/models';

const DOC_A = 'c0ffee00-0000-4000-8000-00000000000a';
const DOC_B = 'c0ffee00-0000-4000-8000-00000000000b';
const LOCAL = 'local-feedfacecafebeef';
const USER = 'user-1';

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

/** Accepts inserts, except for documents listed in `failing` (a transient fault). */
const makeApi = () => {
    const inserted: AnnotationInsert[] = [];
    const failing = new Set<string>();
    const down: ApiError = { message: 'Service Unavailable', kind: 'retry' };
    const api: AnnotationsApi = {
        async insertIgnoreDuplicates(row) {
            if (failing.has(row.document_id)) {
                return { error: down };
            }
            inserted.push(row);
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
            return { error: null, updatedIds: null };
        },
        async updateMany() {
            return { error: null, updatedIds: null };
        },
        async fetchOne() {
            return { data: null, error: null };
        },
        async fetchMany() {
            return { data: [], error: null };
        },
        async fetchSince() {
            return { data: [], error: null };
        },
        async fetchDocumentArchived() {
            return { archived: false, error: null };
        },
    };
    return { api, inserted, failing };
};

let db: ScribblerDb;
let drain: BackgroundDrain | null;

const queue = async (docId: string, id: string) => {
    await new AnnotationStore(db, docId).create(mark(id, docId));
};

beforeEach(() => {
    db = new ScribblerDb(`test-${crypto.randomUUID()}`);
    drain = null;
});

afterEach(() => {
    drain?.stop();
    vi.restoreAllMocks();
});

describe('startBackgroundDrain', () => {
    it('uploads every cloud score’s outbox without its viewer open, and leaves local scores alone', async () => {
        const { api, inserted } = makeApi();
        await queue(DOC_A, 'a1');
        await queue(DOC_B, 'b1');
        await queue(LOCAL, 'l1');

        drain = startBackgroundDrain({ db, api, userId: USER });
        await drain.poke();

        expect(inserted.map((r) => r.id).sort()).toEqual(['a1', 'b1']);
        expect(inserted.every((r) => r.created_by === USER)).toBe(true);
        expect(await db.ops.where('docId').anyOf(DOC_A, DOC_B).count()).toBe(0);
        expect(await db.ops.where('docId').equals(LOCAL).count()).toBe(1);
    });

    it('leaves a score whose viewer is open to that viewer’s engine', async () => {
        const { api, inserted } = makeApi();
        await queue(DOC_A, 'a1');
        await queue(DOC_B, 'b1');
        // The open viewer's engine, registered by start(); its own flush is
        // not what this test is about, so the network it would use is down.
        const viewerApi = makeApi();
        viewerApi.failing.add(DOC_A);
        const viewer = new SyncEngine({
            db,
            store: new AnnotationStore(db, DOC_A),
            api: viewerApi.api,
            docId: DOC_A,
            getUserId: () => USER,
        });
        viewer.start();

        drain = startBackgroundDrain({ db, api, userId: USER });
        await drain.poke();
        viewer.stop();

        expect(inserted.map((r) => r.id)).toEqual(['b1']);
    });

    it('waits while offline and drains as soon as the browser is back online', async () => {
        const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const { api, inserted } = makeApi();
        await queue(DOC_A, 'a1');

        drain = startBackgroundDrain({ db, api, userId: USER });
        await drain.poke();
        expect(inserted).toEqual([]);

        onLine.mockReturnValue(true);
        window.dispatchEvent(new Event('online'));
        await vi.waitFor(() => expect(inserted.map((r) => r.id)).toEqual(['a1']));
    });

    it('backs a failing score off without holding up the others, then retries it', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const { api, inserted, failing } = makeApi();
        failing.add(DOC_A);
        await queue(DOC_A, 'a1');
        await queue(DOC_B, 'b1');

        drain = startBackgroundDrain({ db, api, userId: USER, concurrency: 1 });
        await drain.poke();
        // A failed and is waiting out its backoff; B still went up.
        expect(inserted.map((r) => r.id)).toEqual(['b1']);
        expect(await db.ops.where('docId').equals(DOC_A).count()).toBe(1);

        // Not retried before its backoff runs out…
        await drain.poke();
        expect(inserted.map((r) => r.id)).toEqual(['b1']);

        // …and retried once it has.
        failing.delete(DOC_A);
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 5_000);
        await drain.poke();
        expect(inserted.map((r) => r.id)).toEqual(['b1', 'a1']);
    });

    it('drains at most `concurrency` scores at once', async () => {
        const { api } = makeApi();
        let inFlight = 0;
        let peak = 0;
        const insertMany = api.insertMany.bind(api);
        api.insertMany = async (rows) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return insertMany(rows);
        };
        for (let i = 0; i < 5; i++) {
            await queue(`c0ffee00-0000-4000-8000-00000000010${i}`, `m${i}`);
        }

        drain = startBackgroundDrain({ db, api, userId: USER, concurrency: 2 });
        await drain.poke();

        expect(peak).toBe(2);
        expect(await db.ops.count()).toBe(0);
    });

    it('retries pending lesson-history snapshots, backing off while they keep failing', async () => {
        const { api } = makeApi();
        let pending = 1;
        const retrySnapshots = vi.fn(async () => undefined);
        drain = startBackgroundDrain({
            db,
            api,
            userId: USER,
            retrySnapshots,
            countPendingSnapshots: async () => pending,
        });
        await vi.waitFor(() => expect(retrySnapshots).toHaveBeenCalledTimes(1));

        // Still pending: not hammered on every look at the outbox.
        await drain.poke();
        await drain.poke();
        expect(retrySnapshots).toHaveBeenCalledTimes(1);

        // Reconnecting retries at once…
        window.dispatchEvent(new Event('online'));
        await vi.waitFor(() => expect(retrySnapshots).toHaveBeenCalledTimes(2));

        // …and with nothing left waiting, nothing is sent.
        pending = 0;
        window.dispatchEvent(new Event('online'));
        await drain.poke();
        expect(retrySnapshots).toHaveBeenCalledTimes(2);
    });

    it('is stopped by sign-out before the outbox is cleared', async () => {
        const { api, inserted } = makeApi();
        drain = startBackgroundDrain({ db, api, userId: USER });
        await drain.poke();

        stopAllBackgroundDrains();
        await queue(DOC_A, 'a1');
        await drain.poke();
        window.dispatchEvent(new Event('online'));
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(inserted).toEqual([]);
    });
});
