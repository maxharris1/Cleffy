import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { noteRetryAfter } from '@/lib/retryAfter';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import {
    classifyFailure,
    fromServerRow,
    observeRejections,
    SyncEngine,
    type AnnotationPatchRow,
    type AnnotationsApi,
    type ApiError,
    type PatchResult,
    type SyncHold,
    type SyncRejection,
} from '@/sync/syncEngine';
import type { AnnotationInsert, AnnotationRow, AnnotationUpdate } from '@/types/database';
import type { Annotation } from '@/types/models';

const DOC = 'c0ffee00-0000-4000-8000-000000000001';
const USER = 'user-1';

const makeStroke = (id: string, page = 0): Annotation => ({
    id,
    docId: DOC,
    page,
    kind: 'stroke',
    color: '#111111',
    payload: { pts: [0.1, 0.1, 0.5, 0.2, 0.2, 0.5], w: 0.005 },
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

const serverRow = (id: string, overrides: Partial<AnnotationRow> = {}): AnnotationRow => ({
    id,
    document_id: DOC,
    page: 0,
    kind: 'stroke',
    color: '#00ff00',
    payload: { pts: [0.5, 0.5, 0.5], w: 0.005 },
    created_by: 'other',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
    seq: 7,
    ...overrides,
});

/**
 * In-memory server: assigns seq like the DB trigger; can go offline, refuse
 * writes, or (like RLS) silently match nothing on update.
 */
class FakeApi implements AnnotationsApi {
    rows = new Map<string, AnnotationRow>();
    offline = false;
    nextSeq = 1;
    inserts = 0;
    updates = 0;
    fetchOnes = 0;
    /** Ids whose UPDATE matches nothing (RLS USING false), without an error. */
    invisibleToUpdate = new Set<string>();
    /** Report updated ids (new RPC) or null (pre-migration void RPC). */
    reportsUpdatedIds = true;
    /** Next N write calls fail with this error (then behave normally). */
    failWrites: { error: ApiError; times: number } | null = null;
    refreshAuth = vi.fn(async () => true);

    private err(): ApiError {
        return { message: 'network down', kind: 'retry' };
    }

    private injected(): ApiError | null {
        if (this.offline) {
            return this.err();
        }
        if (this.failWrites && this.failWrites.times > 0) {
            this.failWrites.times -= 1;
            return this.failWrites.error;
        }
        return null;
    }

    async insertIgnoreDuplicates(row: AnnotationInsert) {
        const error = this.injected();
        if (error) {
            return { error };
        }
        this.inserts += 1;
        if (!this.rows.has(row.id)) {
            this.rows.set(row.id, {
                ...row,
                created_at: row.created_at ?? new Date().toISOString(),
                deleted_at: row.deleted_at ?? null,
                updated_at: new Date().toISOString(),
                seq: this.nextSeq++,
            } as AnnotationRow);
        }
        return { error: null };
    }

    async insertMany(rows: AnnotationInsert[]) {
        for (const row of rows) {
            const result = await this.insertIgnoreDuplicates(row);
            if (result.error) {
                return result;
            }
        }
        return { error: null };
    }

    private applyPatch(id: string, patch: AnnotationUpdate): boolean {
        const existing = this.rows.get(id);
        if (!existing || this.invisibleToUpdate.has(id)) {
            return false;
        }
        const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        this.rows.set(id, { ...existing, ...defined, updated_at: new Date().toISOString(), seq: this.nextSeq++ });
        return true;
    }

    async update(id: string, _docId: string, patch: AnnotationUpdate): Promise<PatchResult> {
        const error = this.injected();
        if (error) {
            return { error };
        }
        this.updates += 1;
        const hit = this.applyPatch(id, patch);
        return { error: null, updatedIds: this.reportsUpdatedIds ? (hit ? [id] : []) : null };
    }

    async updateMany(patches: AnnotationPatchRow[]): Promise<PatchResult> {
        // Like production: a single patch goes through the plain update.
        if (patches.length === 1) {
            const { id, document_id, ...patch } = patches[0]!;
            return this.update(id, document_id, patch);
        }
        const error = this.injected();
        if (error) {
            return { error };
        }
        const updated: string[] = [];
        for (const { id, document_id: _doc, ...patch } of patches) {
            this.updates += 1;
            if (this.applyPatch(id, patch)) {
                updated.push(id);
            }
        }
        return { error: null, updatedIds: this.reportsUpdatedIds ? updated : null };
    }

    fetchOneError: ApiError | null = null;
    /** documents.archived_at is set (plan lapsed): RLS refuses every write. */
    archived = false;
    archiveCheckError: ApiError | null = null;
    archiveChecks = 0;

    async fetchDocumentArchived(_docId: string) {
        this.archiveChecks += 1;
        if (this.offline) {
            return { archived: false, error: this.err() };
        }
        if (this.archiveCheckError) {
            return { archived: false, error: this.archiveCheckError };
        }
        return { archived: this.archived, error: null };
    }

    async fetchOne(id: string) {
        this.fetchOnes += 1;
        if (this.offline) {
            return { data: null, error: this.err() };
        }
        if (this.fetchOneError) {
            return { data: null, error: this.fetchOneError };
        }
        return { data: this.rows.get(id) ?? null, error: null };
    }

    async fetchSince(docId: string, afterSeq: number, limit: number) {
        if (this.offline) {
            return { data: null, error: this.err() };
        }
        const data = [...this.rows.values()]
            .filter((r) => r.document_id === docId && r.seq > afterSeq)
            .sort((a, b) => a.seq - b.seq)
            .slice(0, limit);
        return { data, error: null };
    }
}

let db: ScribblerDb;
let store: AnnotationStore;
let api: FakeApi;
let engine: SyncEngine;
let rejections: SyncRejection[];
let holds: SyncHold[];

beforeEach(async () => {
    db = new ScribblerDb(`test-${crypto.randomUUID()}`);
    store = new AnnotationStore(db, DOC);
    await store.load();
    api = new FakeApi();
    rejections = [];
    holds = [];
    engine = new SyncEngine({
        db,
        store,
        api,
        docId: DOC,
        getUserId: () => USER,
        onRejected: (r) => rejections.push(r),
        onHeld: (h) => holds.push(h),
    });
});

afterEach(() => {
    engine.stop();
    vi.restoreAllMocks();
});

describe('classifyFailure', () => {
    it.each([
        [undefined, 'retry'],
        [0, 'retry'],
        [401, 'auth'],
        [404, 'retry'],
        [408, 'retry'],
        [425, 'retry'],
        [429, 'retry'],
        [500, 'retry'],
        [502, 'retry'],
        [503, 'retry'],
        [504, 'retry'],
        [400, 'reject'],
        [403, 'reject'],
        [409, 'reject'],
        [413, 'reject'],
    ])('status %s → %s', (status, kind) => {
        expect(classifyFailure('x', status).kind).toBe(kind);
    });

    it('carries a fresh Retry-After from a throttled response', () => {
        noteRetryAfter({ status: 429, headers: new Headers({ 'retry-after': '7' }) });
        expect(classifyFailure('slow down', 429)).toEqual({ message: 'slow down', kind: 'retry', retryAfterMs: 7000 });
        // Consumed: the next throttle without a header has no hint.
        expect(classifyFailure('slow down', 429).retryAfterMs).toBeUndefined();
    });
});

describe('SyncEngine.flush', () => {
    it('drains creates to the server and clears pending', async () => {
        await store.create(makeStroke('a1'));
        await engine.flush();

        expect(api.inserts).toBe(1);
        expect(api.rows.get('a1')?.created_by).toBe(USER);
        expect(await db.ops.count()).toBe(0);
        expect((await db.annotations.get('a1'))?.pending).toBe(0);
        expect((await db.annotations.get('a1'))?.createdBy).toBe(USER);
        expect(store.get('a1')?.createdBy).toBe(USER);
    });

    it('keeps ops queued while offline and drains after reconnect', async () => {
        api.offline = true;
        await store.create(makeStroke('a1'));
        await store.delete('a1');
        await engine.flush();
        expect(await db.ops.count()).toBe(2);
        expect(engine.pendingRetryDelayMs).not.toBeNull();

        api.offline = false;
        await engine.flush();
        expect(await db.ops.count()).toBe(0);
        expect(api.rows.get('a1')?.deleted_at).not.toBeNull();
    });

    it('drops rejected ops, repairs from server truth, and tells the user', async () => {
        // Server already has the row (someone else's version).
        api.rows.set('a1', serverRow('a1'));
        api.update = async () => ({ error: { message: 'rls rejection', kind: 'reject' } });

        await store.create(makeStroke('a1')); // duplicate id; insert is ignoreDuplicates → fine
        await store.update('a1', { color: '#123456' }); // this update will be "rejected"
        await engine.flush();

        expect(await db.ops.count()).toBe(0);
        // Repair adopted the server row.
        expect(store.get('a1')?.color).toBe('#00ff00');
        expect(store.get('a1')?.seq).toBe(7);
        expect((await db.annotations.get('a1'))?.color).toBe('#00ff00');
        expect((await db.annotations.get('a1'))?.pending).toBe(0);
        expect(rejections).toEqual([{ annotationId: 'a1', opType: 'update', reason: 'rls rejection' }]);
    });

    it('repair adopts the server row even when its seq equals the refused local edit', async () => {
        // A synced row: local and server both at seq 7.
        api.rows.set('a1', serverRow('a1', { color: '#00ff00', seq: 7 }));
        await store.applyRemoteBatch([{ ...makeStroke('a1'), color: '#00ff00', seq: 7 }], new Set());
        await store.update('a1', { color: '#ff0000' }); // local edit keeps seq 7
        api.update = async () => ({ error: { message: 'check violation', kind: 'reject' } });

        await engine.flush();

        // Plain LWW (local.seq >= remote.seq) would have kept the refused edit.
        expect(store.get('a1')?.color).toBe('#00ff00');
        expect((await db.annotations.get('a1'))?.color).toBe('#00ff00');
    });

    it('discards local annotations the server never accepted', async () => {
        api.insertIgnoreDuplicates = async () => ({ error: { message: 'rls rejection', kind: 'reject' } });
        await store.create(makeStroke('a1'));
        await store.update('a1', { color: '#222222' });
        await engine.flush();

        expect(store.get('a1')).toBeUndefined();
        expect(await db.annotations.get('a1')).toBeUndefined();
        // The queued update for a row the server never had is dropped with it.
        expect(await db.ops.count()).toBe(0);
        expect(rejections.map((r) => r.annotationId)).toEqual(['a1']);
    });

    it('never drops a refused op before the repair fetch succeeds', async () => {
        api.rows.set('a1', serverRow('a1'));
        await store.applyRemoteBatch([fromServerRow(serverRow('a1'))], new Set());
        await store.update('a1', { color: '#123456' });
        api.update = async () => ({ error: { message: 'forbidden', kind: 'reject' } });
        api.fetchOneError = { message: 'network down', kind: 'retry' };

        await engine.flush();

        // Op kept, local edit untouched, nobody told anything was lost.
        expect(await db.ops.count()).toBe(1);
        expect(store.get('a1')?.color).toBe('#123456');
        expect(rejections).toEqual([]);
        expect(engine.pendingRetryDelayMs).not.toBeNull();

        // Once the server can be read, the rejection completes.
        api.fetchOneError = null;
        await engine.flush();
        expect(await db.ops.count()).toBe(0);
        expect(store.get('a1')?.color).toBe('#00ff00');
        expect(rejections).toHaveLength(1);
    });

    it('on batch reject, peels one-by-one so an innocent head is not discarded', async () => {
        const goodInsertMany = api.insertMany.bind(api);
        api.insertMany = async (rows) => {
            if (rows.length > 1) {
                return { error: { message: 'batch rejected', kind: 'reject' } };
            }
            if (rows[0]?.id === 'a2') {
                return { error: { message: 'rls rejection', kind: 'reject' } };
            }
            return goodInsertMany(rows);
        };

        await store.create(makeStroke('a1'));
        await store.create(makeStroke('a2'));
        await store.create(makeStroke('a3'));
        await engine.flush();

        expect(await db.ops.count()).toBe(0);
        expect(store.get('a1')).toBeDefined();
        expect(store.get('a2')).toBeUndefined();
        expect(store.get('a3')).toBeDefined();
        expect(rejections.map((r) => r.annotationId)).toEqual(['a2']);
    });
});

describe('SyncEngine expired session (401)', () => {
    it('refreshes the session and retries the same op', async () => {
        api.failWrites = { error: { message: 'JWT expired', kind: 'auth' }, times: 1 };
        await store.create(makeStroke('a1'));
        await engine.flush();

        expect(api.refreshAuth).toHaveBeenCalledTimes(1);
        expect(api.rows.has('a1')).toBe(true);
        expect(await db.ops.count()).toBe(0);
        expect(store.get('a1')).toBeDefined();
        expect(rejections).toEqual([]);
    });

    it('keeps the op (no repair, no discard) when the refresh fails', async () => {
        api.refreshAuth.mockResolvedValue(false);
        api.failWrites = { error: { message: 'JWT expired', kind: 'auth' }, times: 5 };
        await store.create(makeStroke('a1'));
        await engine.flush();

        expect(await db.ops.count()).toBe(1);
        expect(store.get('a1')).toBeDefined();
        expect(api.fetchOnes).toBe(0);
        expect(rejections).toEqual([]);
        expect(engine.pendingRetryDelayMs).not.toBeNull();
    });

    it('treats a 401 that survives a refresh as retryable, not a rejection', async () => {
        api.failWrites = { error: { message: 'JWT expired', kind: 'auth' }, times: 2 };
        await store.create(makeStroke('a1'));
        await engine.flush();

        expect(api.refreshAuth).toHaveBeenCalledTimes(1);
        expect(await db.ops.count()).toBe(1);
        expect(store.get('a1')).toBeDefined();

        await engine.flush();
        expect(await db.ops.count()).toBe(0);
    });
});

describe('SyncEngine throttling and backoff', () => {
    it('429 keeps the op and waits at least the server Retry-After', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        api.failWrites = { error: { message: 'too many', kind: 'retry', retryAfterMs: 9000 }, times: 1 };
        await store.create(makeStroke('a1'));
        await engine.flush();

        expect(await db.ops.count()).toBe(1);
        expect(store.get('a1')).toBeDefined();
        expect(api.fetchOnes).toBe(0);
        expect(engine.pendingRetryDelayMs).toBe(9000);
        expect(rejections).toEqual([]);
    });

    it.each([408, 425, 500, 503])('%s keeps the op for a later retry', async (status) => {
        api.failWrites = { error: classifyFailure('flaky', status), times: 1 };
        await store.create(makeStroke('a1'));
        await engine.flush();
        expect(await db.ops.count()).toBe(1);
        expect(rejections).toEqual([]);

        await engine.flush();
        expect(await db.ops.count()).toBe(0);
    });

    it('backs off exponentially with jitter, capped at a minute', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        // Capture the engine's retry timers (long delays) instead of waiting
        // them out; short ones (IndexedDB internals) run for real.
        const realSetTimeout = globalThis.setTimeout;
        const retries: Array<{ fire: () => void; delay: number }> = [];
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number) => {
            if ((delay ?? 0) >= 100) {
                retries.push({ fire: fn, delay: delay! });
                return 1 as unknown as ReturnType<typeof setTimeout>;
            }
            return realSetTimeout(fn, delay);
        }) as typeof setTimeout);

        api.offline = true;
        await store.create(makeStroke('a1'));
        await engine.flush();
        for (let i = 1; i < 9; i++) {
            retries[i - 1]!.fire(); // the timer runs sync(), which fails again
            await vi.waitFor(() => expect(retries).toHaveLength(i + 1));
        }

        // Jitter floor (random 0) is half the base: 1s, 2s, 4s … capped at 60s.
        expect(retries.map((r) => r.delay)).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
        expect(await db.ops.count()).toBe(1);
    });

    it('a new edit does not jump a scheduled retry', async () => {
        api.failWrites = { error: { message: 'too many', kind: 'retry', retryAfterMs: 30_000 }, times: 1 };
        await store.create(makeStroke('a1'));
        await engine.flush();
        expect(engine.pendingRetryDelayMs).toBe(30_000);

        const flush = vi.spyOn(engine, 'flush');
        engine.requestFlush();
        await Promise.resolve();
        expect(flush).not.toHaveBeenCalled();
    });
});

describe('SyncEngine zero-row updates', () => {
    it('treats an update RLS filtered out as a rejection and repairs from the server', async () => {
        api.rows.set('a1', serverRow('a1', { color: '#00ff00', seq: 3 }));
        await store.applyRemoteBatch([fromServerRow(serverRow('a1', { color: '#00ff00', seq: 3 }))], new Set());
        await store.update('a1', { color: '#ff0000' });
        api.invisibleToUpdate.add('a1'); // e.g. our role dropped to viewer

        await engine.flush();

        expect(await db.ops.count()).toBe(0);
        expect(api.rows.get('a1')?.color).toBe('#00ff00');
        expect(store.get('a1')?.color).toBe('#00ff00');
        expect(rejections).toHaveLength(1);
        expect(rejections[0]?.opType).toBe('update');
    });

    it('acks the rows a batch did update and repairs only the one it missed', async () => {
        for (const id of ['a1', 'a2', 'a3']) {
            api.rows.set(id, serverRow(id, { color: '#00ff00', seq: 3 }));
            await store.applyRemoteBatch([fromServerRow(serverRow(id, { color: '#00ff00', seq: 3 }))], new Set());
            await store.update(id, { color: '#ff0000' });
        }
        api.invisibleToUpdate.add('a2');

        await engine.flush();

        expect(await db.ops.count()).toBe(0);
        expect(api.rows.get('a1')?.color).toBe('#ff0000');
        expect(api.rows.get('a3')?.color).toBe('#ff0000');
        expect(store.get('a2')?.color).toBe('#00ff00');
        expect(rejections.map((r) => r.annotationId)).toEqual(['a2']);
    });

    it('acks applied rows even when the repair of an earlier missed one cannot be fetched', async () => {
        for (const id of ['a1', 'a2', 'a3']) {
            api.rows.set(id, serverRow(id, { color: '#00ff00', seq: 3 }));
            await store.applyRemoteBatch([fromServerRow(serverRow(id, { color: '#00ff00', seq: 3 }))], new Set());
            await store.update(id, { color: '#ff0000' });
        }
        // The FIRST op is the one the server missed, and its repair fetch fails.
        api.invisibleToUpdate.add('a1');
        api.fetchOneError = { message: 'network down', kind: 'retry' };

        await engine.flush();

        // a2 and a3 were applied by the RPC: acked, not left to be re-pushed
        // over a collaborator's later edit on retry.
        const queued = await db.ops.toArray();
        expect(queued.map((o) => o.annotationId)).toEqual(['a1']);
        expect((await db.annotations.get('a2'))?.pending).toBe(0);
        expect((await db.annotations.get('a3'))?.pending).toBe(0);
        // a1 is untouched until the server can be read.
        expect(store.get('a1')?.color).toBe('#ff0000');
        expect(rejections).toEqual([]);

        // A collaborator now edits a2; the retry must not overwrite it.
        api.rows.set('a2', serverRow('a2', { color: '#abcdef', seq: 50 }));
        api.fetchOneError = null;
        await engine.flush();

        expect(api.rows.get('a2')?.color).toBe('#abcdef');
        expect(await db.ops.count()).toBe(0);
        expect(rejections.map((r) => r.annotationId)).toEqual(['a1']);
    });

    it('discards a mark whose row the server no longer has', async () => {
        await store.applyRemoteBatch([fromServerRow(serverRow('gone', { seq: 3 }))], new Set());
        await store.update('gone', { color: '#ff0000' });
        await store.update('gone', { color: '#0000ff' });

        await engine.flush();

        expect(store.get('gone')).toBeUndefined();
        expect(await db.annotations.get('gone')).toBeUndefined();
        expect(await db.ops.count()).toBe(0);
    });

    it('acks as before against the pre-migration RPC that cannot report rows', async () => {
        api.reportsUpdatedIds = false;
        api.rows.set('a1', serverRow('a1', { seq: 3 }));
        await store.applyRemoteBatch([fromServerRow(serverRow('a1', { seq: 3 }))], new Set());
        api.invisibleToUpdate.add('a1');
        await store.update('a1', { color: '#ff0000' });

        await engine.flush();

        expect(await db.ops.count()).toBe(0);
        expect(rejections).toEqual([]);
    });

    it('an edit queued offline does not undelete a mark a collaborator erased', async () => {
        api.rows.set('a1', serverRow('a1', { seq: 3 }));
        await store.applyRemoteBatch([fromServerRow(serverRow('a1', { seq: 3 }))], new Set());
        api.offline = true;
        await store.update('a1', { color: '#ff0000' });
        await engine.flush();

        // Meanwhile a collaborator erases it.
        api.rows.set('a1', serverRow('a1', { seq: 4, deleted_at: '2026-01-02T00:00:00Z' }));
        api.offline = false;
        await engine.sync();

        expect(api.rows.get('a1')?.deleted_at).toBe('2026-01-02T00:00:00Z');
    });
});

describe('SyncEngine archived score', () => {
    const refuseWrites = () => {
        const forbidden: ApiError = { message: 'new row violates row-level security policy', kind: 'reject' };
        api.insertIgnoreDuplicates = async () => ({ error: forbidden });
        api.insertMany = async () => ({ error: forbidden });
        api.update = async () => ({ error: forbidden });
        api.updateMany = async () => ({ error: forbidden });
    };

    it('keeps marks drawn offline on a score archived meanwhile, and says so', async () => {
        await store.create(makeStroke('a1'));
        await store.create(makeStroke('a2'));
        await store.update('a2', { color: '#222222' });
        api.archived = true;
        const realInsertMany = api.insertMany.bind(api);
        refuseWrites();

        await engine.flush();

        // Nothing discarded, nobody told their work was undone.
        expect(await db.ops.count()).toBe(3);
        expect(store.get('a1')).toBeDefined();
        expect(store.get('a2')?.color).toBe('#222222');
        expect(await db.annotations.get('a1')).toBeDefined();
        expect(rejections).toEqual([]);
        expect(holds).toEqual([{ reason: 'archived', pendingMarks: 2 }]);
        // Retried slowly: nothing changes until the plan does.
        expect(engine.pendingRetryDelayMs).toBeGreaterThanOrEqual(60_000);

        // The owner resubscribes and the score is unarchived: the marks upload.
        api.archived = false;
        api.insertMany = realInsertMany;
        api.insertIgnoreDuplicates = FakeApi.prototype.insertIgnoreDuplicates.bind(api);
        api.update = FakeApi.prototype.update.bind(api);
        api.updateMany = FakeApi.prototype.updateMany.bind(api);
        await engine.flush();

        expect(await db.ops.count()).toBe(0);
        expect(api.rows.get('a1')).toBeDefined();
        expect(api.rows.get('a2')?.color).toBe('#222222');
    });

    it('keeps an edit to an existing mark instead of reverting it', async () => {
        api.rows.set('a1', serverRow('a1', { seq: 3 }));
        await store.applyRemoteBatch([fromServerRow(serverRow('a1', { seq: 3 }))], new Set());
        await store.update('a1', { color: '#ff0000' });
        api.archived = true;
        refuseWrites();

        await engine.flush();

        expect(await db.ops.count()).toBe(1);
        expect(store.get('a1')?.color).toBe('#ff0000');
        expect(rejections).toEqual([]);
        expect(holds).toHaveLength(1);
    });

    it('keeps the op when whether the score is archived cannot be read', async () => {
        await store.create(makeStroke('a1'));
        refuseWrites();
        api.archiveCheckError = { message: 'network down', kind: 'retry' };

        await engine.flush();

        expect(await db.ops.count()).toBe(1);
        expect(store.get('a1')).toBeDefined();
        expect(rejections).toEqual([]);
        expect(api.fetchOnes).toBe(0);
    });

    it('still rejects (and reports) when the score is not archived', async () => {
        await store.create(makeStroke('a1'));
        refuseWrites();

        await engine.flush();

        expect(api.archiveChecks).toBeGreaterThan(0);
        expect(await db.ops.count()).toBe(0);
        expect(store.get('a1')).toBeUndefined();
        expect(rejections.map((r) => r.annotationId)).toEqual(['a1']);
        expect(holds).toEqual([]);
    });
});

describe('observeRejections', () => {
    it('reports every engine’s refusals, with the document, until unsubscribed', async () => {
        const seen: { docId: string; annotationId: string }[] = [];
        const stop = observeRejections(({ docId, annotationId }) => seen.push({ docId, annotationId }));
        api.insertIgnoreDuplicates = async () => ({ error: { message: 'rls rejection', kind: 'reject' } });
        await store.create(makeStroke('a1'));
        await engine.flush();
        stop();
        await store.create(makeStroke('a2'));
        await engine.flush();

        expect(seen).toEqual([{ docId: DOC, annotationId: 'a1' }]);
    });
});

describe('SyncEngine load ordering', () => {
    it('sync waits for hydration so an overlap row cannot overwrite a newer mirror row', async () => {
        // The mirror (from an earlier session) has a1 at seq 10.
        await db.annotations.put({ ...makeStroke('a1'), color: '#aaaaaa', seq: 10, pending: 0 });
        await db.syncState.put({ docId: DOC, watermarkSeq: 10 });
        // The server still returns an older version inside the pull overlap.
        api.rows.set('a1', serverRow('a1', { color: '#bbbbbb', seq: 5 }));

        const fresh = new AnnotationStore(db, DOC);
        const e = new SyncEngine({ db, store: fresh, api, docId: DOC, getUserId: () => USER });
        // Engine first, as PdfViewport effects may order it — no explicit load().
        await e.sync();
        e.stop();

        expect(fresh.get('a1')?.color).toBe('#aaaaaa');
        expect((await db.annotations.get('a1'))?.color).toBe('#aaaaaa');
        expect(fresh.getPage(0).has('a1')).toBe(true);
    });
});

describe('SyncEngine.pullSince', () => {
    it('applies remote rows and advances the watermark', async () => {
        await api.insertIgnoreDuplicates({
            id: 'r1',
            document_id: DOC,
            page: 2,
            kind: 'stroke',
            color: '#ff0000',
            payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
            created_by: 'other',
        });
        await engine.pullSince();

        expect(store.getPage(2).has('r1')).toBe(true);
        expect((await db.syncState.get(DOC))?.watermarkSeq).toBe(1);
    });

    it('refreshes an expired session for the pull too', async () => {
        const real = api.fetchSince.bind(api);
        let calls = 0;
        api.fetchSince = async (...args) => {
            calls += 1;
            return calls === 1 ? { data: null, error: { message: 'JWT expired', kind: 'auth' } } : real(...args);
        };
        api.rows.set('r1', serverRow('r1', { seq: 1 }));
        await engine.pullSince();
        expect(api.refreshAuth).toHaveBeenCalledTimes(1);
        expect(store.get('r1')).toBeDefined();
    });

    it('skips rows with pending local ops (local intent wins until acked)', async () => {
        api.offline = true;
        await store.create(makeStroke('a1'));
        await store.update('a1', { color: '#ffffff' });
        api.offline = false;

        // Server has a conflicting version of a1.
        api.rows.set('a1', serverRow('a1', { color: '#000000', seq: 3 }));
        await engine.pullSince();
        expect(store.get('a1')?.color).toBe('#ffffff'); // local intent preserved
    });

    it('ignores remote rows older than the local seq (LWW)', async () => {
        await store.applyRemoteBatch([{ ...makeStroke('a1'), seq: 10, color: '#aaaaaa' }], new Set());
        await store.applyRemoteBatch([{ ...makeStroke('a1'), seq: 5, color: '#bbbbbb' }], new Set());
        expect(store.get('a1')?.color).toBe('#aaaaaa');
    });

    it('applies remote tombstones by removing from the page map', async () => {
        await store.applyRemoteBatch([{ ...makeStroke('a1'), seq: 1 }], new Set());
        expect(store.getPage(0).has('a1')).toBe(true);
        await store.applyRemoteBatch([{ ...makeStroke('a1'), seq: 2, deletedAt: '2026-01-02T00:00:00Z' }], new Set());
        expect(store.getPage(0).has('a1')).toBe(false);
    });
});

describe('SyncEngine.applyServerRow (broadcast path)', () => {
    it('applies rows and advances the watermark monotonically', async () => {
        await engine.applyServerRow(serverRow('b1', { page: 4, color: '#123', seq: 9 }));
        expect(store.getPage(4).has('b1')).toBe(true);
        expect((await db.syncState.get(DOC))?.watermarkSeq).toBe(9);

        // Lower-seq stragglers never move the watermark backwards.
        await engine.applyServerRow(serverRow('b2', { page: 4, color: '#123', seq: 5 }));
        expect((await db.syncState.get(DOC))?.watermarkSeq).toBe(9);
    });

    it('ignores rows for other documents', async () => {
        await engine.applyServerRow(serverRow('x1', { document_id: 'someone-elses-doc', seq: 99 }));
        expect(store.get('x1')).toBeUndefined();
    });
});

describe('offline → queue → flush → converge (integration)', () => {
    it('converges both directions after reconnect', async () => {
        // Local draws while offline.
        api.offline = true;
        await store.create(makeStroke('local1', 1));
        // Remote (the other collaborator) drew meanwhile.
        api.rows.set(
            'remote1',
            serverRow('remote1', {
                page: 1,
                kind: 'highlight',
                color: '#eab308',
                payload: { pts: [0.3, 0.3, 0.5, 0.4, 0.3, 0.5], w: 0.0175 },
                seq: 41,
            }),
        );
        api.nextSeq = 42;

        await engine.sync(); // offline: nothing happens, op stays
        expect(await db.ops.count()).toBe(1);

        api.offline = false;
        await engine.sync();

        // Local reached the server…
        expect(api.rows.get('local1')?.created_by).toBe(USER);
        // …and the remote stroke reached us.
        expect(store.getPage(1).has('remote1')).toBe(true);
        expect(await db.ops.count()).toBe(0);
    });
});
