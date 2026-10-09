import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AnnotationStore } from '@/sync/annotationStore';
import { startBackgroundDrain, stopAllBackgroundDrains, type BackgroundDrain } from '@/sync/backgroundDrain';
import { ScribblerDb } from '@/sync/db';
import { drainCloudOutboxes } from '@/sync/signOutSync';
import {
    observeRejections,
    SyncEngine,
    type AnnotationsApi,
    type ApiError,
    type SyncRejection,
} from '@/sync/syncEngine';
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

/**
 * Accepts inserts, except for documents listed in `failing` (a transient
 * fault) and marks listed in `refusing` (RLS: this account may not write).
 */
const makeApi = () => {
    const inserted: AnnotationInsert[] = [];
    const failing = new Set<string>();
    const refusing = new Set<string>();
    const attempts: string[] = [];
    const down: ApiError = { message: 'Service Unavailable', kind: 'retry' };
    const refused: ApiError = { message: 'new row violates row-level security policy', kind: 'reject' };
    const api: AnnotationsApi = {
        async insertIgnoreDuplicates(row) {
            attempts.push(row.id);
            if (failing.has(row.document_id)) {
                return { error: down };
            }
            if (refusing.has(row.id)) {
                return { error: refused };
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
    return { api, inserted, failing, refusing, attempts };
};

let db: ScribblerDb;
let drain: BackgroundDrain | null;

/** A mark drawn by `author` (the signed-in account by default) and queued. */
const queue = async (docId: string, id: string, author: string | null = USER) => {
    const store = new AnnotationStore(db, docId);
    store.setAuthor(author);
    await store.create(mark(id, docId));
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

    it('leaves a score open in another tab’s viewer to that viewer', async () => {
        const { api, inserted } = makeApi();
        await queue(DOC_A, 'a1');
        await queue(DOC_B, 'b1');
        // The other tab's started engine holds this shared Web Lock.
        Object.defineProperty(navigator, 'locks', {
            configurable: true,
            value: { query: async () => ({ held: [{ name: `cleffy-viewer:${DOC_A}`, mode: 'shared' }] }) },
        });
        try {
            drain = startBackgroundDrain({ db, api, userId: USER });
            await drain.poke();
        } finally {
            delete (navigator as { locks?: unknown }).locks;
        }

        expect(inserted.map((r) => r.id)).toEqual(['b1']);
    });

    it('holds its first look back when asked, so a score’s own viewer registers first', async () => {
        const { api, inserted } = makeApi();
        await queue(DOC_A, 'a1');
        drain = startBackgroundDrain({ db, api, userId: USER, startDelayMs: 300 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(inserted).toEqual([]);
        await vi.waitFor(() => expect(inserted.map((r) => r.id)).toEqual(['a1']));
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

    it('leaves another account’s queued changes on the device, untouched', async () => {
        const { api, inserted, attempts } = makeApi();
        // Someone else's session on this browser ended without signing out.
        await queue(DOC_A, 'a1', 'user-previous');
        // A score where both accounts have changes waiting.
        await queue(DOC_B, 'b1', 'user-previous');
        await queue(DOC_B, 'b2');
        const OWN = 'c0ffee00-0000-4000-8000-00000000000c';
        await queue(OWN, 'c1');

        drain = startBackgroundDrain({ db, api, userId: USER });
        await drain.poke();
        await drain.poke();

        // Only the score holding nothing but this account's changes went up.
        expect(attempts).toEqual(['c1']);
        expect(inserted.map((r) => r.id)).toEqual(['c1']);
        expect(await db.ops.where('docId').equals(DOC_A).count()).toBe(1);
        expect(await db.ops.where('docId').equals(DOC_B).count()).toBe(2);
        expect(await db.annotations.get('a1')).toBeDefined();
    });

    it('uploads changes queued before ops were stamped only on a score this account cached', async () => {
        const { api, inserted } = makeApi();
        const cache = (docId: string, userId: string) =>
            db.pdfCache.put({ docId, bytes: new ArrayBuffer(8), title: 'Score', cachedAt: '', userId });
        await queue(DOC_A, 'a1', null);
        await cache(DOC_A, USER);
        await queue(DOC_B, 'b1', null);
        await cache(DOC_B, 'user-previous');
        const UNCACHED = 'c0ffee00-0000-4000-8000-00000000000c';
        await queue(UNCACHED, 'c1', null);

        drain = startBackgroundDrain({ db, api, userId: USER });
        await drain.poke();

        expect(inserted.map((r) => r.id)).toEqual(['a1']);
        expect(await db.ops.where('docId').anyOf(DOC_B, UNCACHED).count()).toBe(2);
    });

    it('rolls nothing back on a refusal, and leaves it to the score’s viewer to undo and say so', async () => {
        const { api, inserted, refusing, attempts } = makeApi();
        refusing.add('a1');
        await queue(DOC_A, 'a1');
        await queue(DOC_A, 'a2');
        await queue(DOC_B, 'b1');
        const seen: SyncRejection[] = [];
        const stopObserving = observeRejections((r) => seen.push(r));

        drain = startBackgroundDrain({ db, api, userId: USER });
        await drain.poke();
        stopObserving();

        // Nothing vanished where no one could see it: the refused mark, and
        // the one queued behind it, are still on the device and queued.
        expect(inserted.map((r) => r.id)).toEqual(['b1']);
        expect(await db.annotations.get('a1')).toBeDefined();
        expect(await db.ops.where('docId').equals(DOC_A).count()).toBe(2);
        expect(seen).toEqual([]);

        // Not asked again while the refused change is still waiting.
        const asked = attempts.length;
        await drain.poke();
        window.dispatchEvent(new Event('online'));
        await drain.poke();
        expect(attempts).toHaveLength(asked);

        // The score's viewer meets the refusal, rolls it back and tells the user.
        drain.stop();
        const shown: SyncRejection[] = [];
        const viewer = new SyncEngine({
            db,
            store: new AnnotationStore(db, DOC_A),
            api,
            docId: DOC_A,
            getUserId: () => USER,
            onRejected: (r) => shown.push(r),
        });
        await viewer.flush();
        viewer.stop();
        expect(shown.map((r) => r.annotationId)).toEqual(['a1']);
        expect(await db.annotations.get('a1')).toBeUndefined();
        expect(inserted.map((r) => r.id)).toEqual(['b1', 'a2']);
    });

    it('leaves a refusal for sign-out to count when no viewer opens the score', async () => {
        const { api, refusing } = makeApi();
        refusing.add('a1');
        await queue(DOC_A, 'a1');

        drain = startBackgroundDrain({ db, api, userId: USER });
        await drain.poke();
        drain.stop();

        expect(await drainCloudOutboxes({ db, api, getUserId: () => USER, timeoutMs: 2000 })).toEqual({
            pending: 0,
            refused: 1,
        });
    });

    it('takes a refused score up again once the refused change has been dealt with', async () => {
        const { api, inserted, refusing } = makeApi();
        refusing.add('a1');
        await queue(DOC_A, 'a1');

        drain = startBackgroundDrain({ db, api, userId: USER });
        await drain.poke();
        expect(await db.ops.where('docId').equals(DOC_A).count()).toBe(1);

        // Its viewer rolled the refusal back (dropping the op); a later mark,
        // drawn offline there, is still waiting when the viewer closes.
        await db.ops.where('docId').equals(DOC_A).delete();
        await queue(DOC_A, 'a2');
        await drain.poke();

        expect(inserted.map((r) => r.id)).toEqual(['a2']);
        expect(await db.ops.count()).toBe(0);
    });

    it('backs a score off when its outbox cannot be read, instead of asking again at once', async () => {
        const { api, attempts } = makeApi();
        await queue(DOC_A, 'a1');
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const where = vi.spyOn(db.ops, 'where').mockImplementation(() => {
            throw new Error('IndexedDB went away');
        });

        drain = startBackgroundDrain({ db, api, userId: USER });
        await drain.poke();
        const reads = where.mock.calls.length;
        await drain.poke();

        expect(reads).toBeGreaterThan(0);
        expect(where.mock.calls.length).toBe(reads);
        expect(attempts).toEqual([]);
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
