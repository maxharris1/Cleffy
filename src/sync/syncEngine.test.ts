import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as snapshotService from '@/features/viewer/history/snapshotService';
import { noteRetryAfter } from '@/lib/retryAfter';
import type { TypedSupabaseClient } from '@/lib/supabase';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb, type PendingOp, type PendingOpType } from '@/sync/db';
import {
    classifyFailure,
    createSupabaseAnnotationsApi,
    fromServerRow,
    isEchoOf,
    observeRejections,
    PERSISTENT_FAILURE_MS,
    reconcileWithServer,
    SyncEngine,
    type AnnotationPatchRow,
    type AnnotationsApi,
    type ApiError,
    type HeldRefusal,
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

    /** student_access_revoked(): the teacher archived or reset this student. */
    signInEnded = false;
    signInCheckError: ApiError | null = null;
    signInChecks = 0;

    async fetchSignInEnded() {
        this.signInChecks += 1;
        if (this.offline) {
            return { ended: false, error: this.err() };
        }
        if (this.signInCheckError) {
            return { ended: false, error: this.signInCheckError };
        }
        return { ended: this.signInEnded, error: null };
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

    fetchManys = 0;
    fetchManyError: ApiError | null = null;

    async fetchMany(docId: string, ids: string[]) {
        this.fetchManys += 1;
        if (this.offline) {
            return { data: null, error: this.err() };
        }
        if (this.fetchManyError) {
            return { data: null, error: this.fetchManyError };
        }
        const data = ids
            .map((id) => this.rows.get(id))
            .filter((r): r is AnnotationRow => !!r && r.document_id === docId);
        return { data, error: null };
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
    store.setAuthor(USER);
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

describe('SyncEngine sign-in ended by the server', () => {
    // A roster student's teacher reset their access (or archived them) while
    // this device still holds an unexpired token: RLS refuses every request,
    // the score included, so nothing is visible and the refusal reads exactly
    // like one of the change. The student is still a member, and signs in
    // again as the same account.
    const refuseEverything = () => {
        const forbidden: ApiError = { message: 'new row violates row-level security policy', kind: 'reject' };
        api.insertIgnoreDuplicates = async () => ({ error: forbidden });
        api.insertMany = async () => ({ error: forbidden });
        api.update = async () => ({ error: forbidden });
        api.updateMany = async () => ({ error: forbidden, updatedIds: [] });
        api.fetchOne = async () => ({ data: null, error: null });
    };

    it('keeps queued and new marks for the next sign-in instead of rolling them back', async () => {
        api.rows.set('m1', serverRow('m1', { created_by: USER, seq: 3 }));
        await store.applyRemoteBatch([fromServerRow(serverRow('m1', { created_by: USER, seq: 3 }))], new Set());
        await store.update('m1', { color: '#ff0000' });
        await store.create(makeStroke('a1'));
        const saved = new Map(api.rows);
        api.signInEnded = true;
        refuseEverything();

        await engine.flush();

        expect(await db.ops.count()).toBe(2);
        expect(store.get('a1')).toBeDefined();
        expect(await db.annotations.get('a1')).toBeDefined();
        expect(store.get('m1')?.color).toBe('#ff0000');
        expect(rejections).toEqual([]);
        expect(holds).toEqual([{ reason: 'signed-out', pendingMarks: 2 }]);
        expect(api.signInChecks).toBeGreaterThan(0);

        // The same student signs in again: the same ops upload, unchanged.
        engine.stop();
        const fresh = new FakeApi();
        fresh.rows = saved;
        fresh.nextSeq = 10;
        const again = new SyncEngine({ db, store, api: fresh, docId: DOC, getUserId: () => USER });
        await again.flush();
        again.stop();

        expect(await db.ops.count()).toBe(0);
        expect(fresh.rows.get('a1')?.created_by).toBe(USER);
        expect(fresh.rows.get('m1')?.color).toBe('#ff0000');
    });

    it('keeps the op when whether the sign-in still stands cannot be read', async () => {
        await store.create(makeStroke('a1'));
        refuseEverything();
        api.signInCheckError = { message: 'network down', kind: 'retry' };

        await engine.flush();

        expect(await db.ops.count()).toBe(1);
        expect(store.get('a1')).toBeDefined();
        expect(rejections).toEqual([]);
        expect(holds).toEqual([]);
        expect(engine.pendingRetryDelayMs).not.toBeNull();
    });

    it('still rolls back a refusal under a sign-in that stands', async () => {
        await store.create(makeStroke('a1'));
        refuseEverything();

        await engine.flush();

        expect(api.signInChecks).toBeGreaterThan(0);
        expect(await db.ops.count()).toBe(0);
        expect(store.get('a1')).toBeUndefined();
        expect(rejections.map((r) => r.annotationId)).toEqual(['a1']);
        expect(holds).toEqual([]);
    });
});

describe('createSupabaseAnnotationsApi.fetchSignInEnded', () => {
    const client = (userType: string | null, answer: { data: unknown; error: unknown; status: number }) => {
        const rpc = vi.fn(async () => answer);
        const supabase = {
            auth: {
                getSession: async () => ({
                    data: { session: { user: { app_metadata: userType ? { user_type: userType } : {} } } },
                }),
            },
            rpc,
        };
        return { api: createSupabaseAnnotationsApi(supabase as unknown as TypedSupabaseClient), rpc };
    };

    it('asks the server for a roster student', async () => {
        const { api, rpc } = client('student', { data: true, error: null, status: 200 });
        expect(await api.fetchSignInEnded?.()).toEqual({ ended: true, error: null });
        expect(rpc).toHaveBeenCalledWith('student_access_revoked');
    });

    it('answers no for anyone else without a round trip', async () => {
        const { api, rpc } = client(null, { data: true, error: null, status: 200 });
        expect(await api.fetchSignInEnded?.()).toEqual({ ended: false, error: null });
        expect(rpc).not.toHaveBeenCalled();
    });

    it('reports a failed question as one to ask again', async () => {
        const { api } = client('student', { data: null, error: { message: 'upstream' }, status: 503 });
        expect(await api.fetchSignInEnded?.()).toEqual({ ended: false, error: { message: 'upstream', kind: 'retry' } });
    });
});

describe('SyncEngine holding refusals (headless)', () => {
    it('leaves a refused change queued and the mark as drawn, and reports the op', async () => {
        await store.create(makeStroke('h1'));
        await engine.flush();
        await store.update('h1', { color: '#ff0000' });
        api.invisibleToUpdate.add('h1'); // edit access lost meanwhile
        const queued = await db.ops.toArray();
        const held: HeldRefusal[] = [];
        const seen: SyncRejection[] = [];
        const stopObserving = observeRejections((r) => seen.push(r));
        const headless = new SyncEngine({
            db,
            store: new AnnotationStore(db, DOC),
            api,
            docId: DOC,
            getUserId: () => USER,
            onRejected: (r) => rejections.push(r),
            onRefusalHeld: (refusal) => held.push(refusal),
        });

        await headless.flush();
        headless.stop();
        stopObserving();

        expect(held).toEqual([
            { opId: queued[0]!.opId, annotationId: 'h1', reason: 'the change matched no row this account may edit' },
        ]);
        expect(await db.ops.toArray()).toEqual(queued);
        expect((await db.annotations.get('h1'))?.color).toBe('#ff0000');
        expect(api.fetchOnes).toBe(0);
        expect(rejections).toEqual([]);
        expect(seen).toEqual([]);
        expect(headless.pendingRetryDelayMs).toBeNull();
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

describe('SyncEngine.pullSince while a pull is in flight', () => {
    it('pulls again for a caller that arrives mid-pull, so a row committed meanwhile is not skipped', async () => {
        for (let seq = 1; seq <= 10; seq += 1) {
            api.rows.set(`r${seq}`, serverRow(`r${seq}`, { seq }));
        }
        await engine.sync();
        expect((await db.syncState.get(DOC))?.watermarkSeq).toBe(10);

        // Pull A reads the server before seq 11 commits, then stalls.
        const realFetch = api.fetchSince.bind(api);
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let calls = 0;
        api.fetchSince = async (...args: Parameters<FakeApi['fetchSince']>) => {
            calls += 1;
            const result = await realFetch(...args);
            if (calls === 1) {
                await gate;
            }
            return result;
        };
        const pullA = engine.pullSince();
        await vi.waitFor(() => expect(calls).toBe(1));

        // seq 11 commits but its broadcast is lost (doc-db was down); the
        // rejoin's gap fill asks for a pull while A is still in flight.
        api.rows.set('r11', serverRow('r11', { seq: 11 }));
        const pullB = engine.pullSince();
        release();
        await Promise.all([pullA, pullB]);
        expect(store.get('r11')).toBeDefined();

        // Live rows then carry the watermark far past seq 11.
        api.fetchSince = realFetch;
        for (let seq = 12; seq <= 80; seq += 1) {
            await engine.applyServerRow(serverRow(`r${seq}`, { seq }));
        }
        await engine.sync();
        expect(store.get('r11')).toBeDefined();
        expect((await db.syncState.get(DOC))?.watermarkSeq).toBe(80);
    });

    it('does not pull again straight away after a failed pass', async () => {
        let calls = 0;
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        api.fetchSince = async () => {
            calls += 1;
            await gate;
            return { data: null, error: { message: 'too many requests', kind: 'retry' as const } };
        };
        const pullA = engine.pullSince();
        const pullB = engine.pullSince();
        release();
        await Promise.all([pullA, pullB]);
        expect(calls).toBe(1);
        engine.stop();
    });
});

describe('SyncEngine.stop during an in-flight pull', () => {
    it('writes neither rows nor a watermark once stopped', async () => {
        await api.insertIgnoreDuplicates({
            id: 'r1',
            document_id: DOC,
            page: 0,
            kind: 'stroke',
            color: '#ff0000',
            payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
            created_by: 'other',
        });
        // Hold the fetch open, the way a slow network would, and stop the
        // engine while it is pending — what the viewer does when the account
        // loses the score and its local copy is about to be purged.
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const realFetch = api.fetchSince.bind(api);
        api.fetchSince = async (...args: Parameters<FakeApi['fetchSince']>) => {
            await gate;
            return realFetch(...args);
        };

        const pull = engine.pullSince();
        engine.stop();
        release();
        await pull;

        expect(store.get('r1')).toBeUndefined();
        expect(await db.annotations.where('docId').equals(DOC).count()).toBe(0);
        expect(await db.syncState.get(DOC)).toBeUndefined();
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

describe('SyncEngine offline undo/redo against a collaborator (reconcile)', () => {
    /** M5 and M6 drawn by this device and synced, so the server holds both. */
    const drawAndSync = async () => {
        await store.create(makeStroke('m5'));
        await store.create(makeStroke('m6'));
        await engine.flush();
        expect(await db.ops.count()).toBe(0);
    };

    it('does not resurrect a mark a collaborator erased while undo/redo sat in the outbox', async () => {
        await drawAndSync();
        api.offline = true;
        await store.undoLast(); // delete m6
        await store.undoLast(); // delete m5
        await store.redoLast(); // restore m5
        await store.redoLast(); // restore m6
        expect(await db.ops.count()).toBe(4);

        // Meanwhile a collaborator erases m6.
        const erasedAt = '2026-03-03T03:03:03.000Z';
        api.rows.set('m6', { ...api.rows.get('m6')!, deleted_at: erasedAt, seq: api.nextSeq++ });
        const updatesBefore = api.updates;

        api.offline = false;
        await engine.sync();

        // The collaborator's newer delete stands, here and on the server…
        expect(api.rows.get('m6')?.deleted_at).toBe(erasedAt);
        expect(store.get('m6')?.deletedAt).toBe(erasedAt);
        expect(store.getPage(0).has('m6')).toBe(false);
        // …and the undo/redo pairs cancelled out: nothing was sent at all.
        expect(api.updates).toBe(updatesBefore);
        expect(api.rows.get('m5')?.deleted_at).toBeNull();
        expect(store.getPage(0).has('m5')).toBe(true);
        expect(await db.ops.count()).toBe(0);
        expect((await db.annotations.get('m6'))?.pending).toBe(0);
        expect(rejections).toEqual([]);
    });

    it('sends only the net change for a mark edited several times offline', async () => {
        await drawAndSync();
        api.offline = true;
        await store.update('m5', { color: '#aa0000' });
        await store.update('m5', { color: '#bb0000' });
        await store.delete('m6');
        await store.undoLast(); // restore m6
        await store.delete('m6');
        const updatesBefore = api.updates;

        api.offline = false;
        await engine.flush();

        expect(api.updates - updatesBefore).toBe(2); // one patch per mark
        expect(api.rows.get('m5')?.color).toBe('#bb0000');
        expect(api.rows.get('m6')?.deleted_at).not.toBeNull();
        expect(await db.ops.count()).toBe(0);
    });

    it('restores its own delete even when that delete landed but its answer was lost', async () => {
        await drawAndSync();
        api.offline = true;
        await store.undoLast(); // delete m6, queued
        // The delete reaches the server, but the response never comes back.
        const tombstone = store.get('m6')!.deletedAt!;
        api.rows.set('m6', { ...api.rows.get('m6')!, deleted_at: tombstone, seq: api.nextSeq++ });
        await store.redoLast(); // restore m6, queued behind it

        api.offline = false;
        await engine.flush();

        expect(api.rows.get('m6')?.deleted_at).toBeNull();
        expect(store.getPage(0).has('m6')).toBe(true);
        expect(await db.ops.count()).toBe(0);
    });

    it('a lone restore does not undo a collaborator’s newer delete', async () => {
        await drawAndSync();
        await store.undoLast(); // delete m6 …
        await engine.flush(); // … acked
        api.offline = true;
        await store.redoLast(); // restore m6, queued

        // A collaborator brings m6 back and erases it again (a new tombstone).
        const theirs = '2026-04-04T04:04:04.000Z';
        api.rows.set('m6', { ...api.rows.get('m6')!, deleted_at: theirs, seq: api.nextSeq++ });

        api.offline = false;
        await engine.flush();

        expect(api.rows.get('m6')?.deleted_at).toBe(theirs);
        expect(store.getPage(0).has('m6')).toBe(false);
        expect(await db.ops.count()).toBe(0);
    });

    it('a lone restore of this device’s own acked delete still goes through', async () => {
        await drawAndSync();
        await store.undoLast(); // delete m6 …
        await engine.flush(); // … acked; local seq still predates it
        api.offline = true;
        await store.redoLast();

        api.offline = false;
        await engine.flush();

        expect(api.rows.get('m6')?.deleted_at).toBeNull();
        expect(store.getPage(0).has('m6')).toBe(true);
    });

    it('keeps an edit made after undoing an erase, even against a collaborator’s later delete', async () => {
        await drawAndSync();
        await store.delete('m6'); // erased here …
        await engine.flush(); // … and that synced
        api.offline = true;
        await store.undoLast(); // brought back, offline …
        await store.update('m6', { color: '#ff0000' }); // … and recoloured
        // Meanwhile a collaborator restored m6 and erased it again.
        const theirs = '2026-05-05T05:05:05.000Z';
        api.rows.set('m6', { ...api.rows.get('m6')!, deleted_at: theirs, seq: api.nextSeq++ });

        api.offline = false;
        await engine.flush();

        // Which came last cannot be told, so the user's work is not thrown
        // away: the mark stands, as they left it, here and on the server.
        expect(api.rows.get('m6')?.deleted_at).toBeNull();
        expect(api.rows.get('m6')?.color).toBe('#ff0000');
        expect(store.getPage(0).get('m6')?.color).toBe('#ff0000');
        expect(await db.ops.count()).toBe(0);
        expect(rejections).toEqual([]);
    });

    /** Offline: erase m6, undo, recolour — the QA "undo erase, then edit" case. */
    const eraseUndoEdit = async () => {
        await drawAndSync();
        api.offline = true;
        await store.delete('m6');
        await store.undoLast(); // brought back …
        await store.update('m6', { color: '#ff0000' }); // … and recoloured
        expect((await db.ops.toArray()).map((op) => op.type)).toEqual(['delete', 'restore', 'update']);
    };

    /** A collaborator erases m6 on the server (their tombstone, a new seq). */
    const collaboratorErases = (at = '2026-06-06T06:06:06.000Z') => {
        api.rows.set('m6', { ...api.rows.get('m6')!, deleted_at: at, seq: api.nextSeq++ });
    };

    it('keeps an edit made after undoing an erase when the collaborator’s delete lands after the check', async () => {
        await eraseUndoEdit();
        // The reconnect race: reconcile reads m6 while it is still live, and
        // the collaborator's delete reaches the row before this device's write.
        const read = api.fetchMany.bind(api);
        vi.spyOn(api, 'fetchMany').mockImplementation(async (docId, ids) => {
            const result = await read(docId, ids);
            collaboratorErases();
            return result;
        });

        api.offline = false;
        await engine.flush();

        // Not an edit written onto their tombstone: the mark stands, as the
        // user left it, on the server and here.
        expect(api.rows.get('m6')?.deleted_at).toBeNull();
        expect(api.rows.get('m6')?.color).toBe('#ff0000');
        expect(store.getPage(0).get('m6')?.color).toBe('#ff0000');
        expect(await db.ops.count()).toBe(0);
        expect(rejections).toEqual([]);
    });

    it('keeps that edit when its send fails and the mark is erased again before the retry', async () => {
        await eraseUndoEdit();
        collaboratorErases('2026-06-06T06:06:06.000Z');
        api.offline = false;
        api.failWrites = { error: { message: 'bad gateway', kind: 'retry' }, times: 1 };

        await engine.flush(); // reconciled, then the write fails
        expect(api.rows.get('m6')?.deleted_at).not.toBeNull();
        expect(await db.ops.count()).toBeGreaterThan(0);

        collaboratorErases('2026-07-07T07:07:07.000Z'); // and again, meanwhile
        engine.resetBackoff();
        await engine.flush();

        expect(api.rows.get('m6')?.deleted_at).toBeNull();
        expect(api.rows.get('m6')?.color).toBe('#ff0000');
        expect(await db.ops.count()).toBe(0);
    });

    it('carries the author stamp onto the net change', () => {
        const queued = (opId: number, type: PendingOpType, color: string): PendingOp => ({
            opId,
            docId: DOC,
            type,
            annotationId: 'm1',
            annotation: { ...makeStroke('m1'), color },
            queuedAt: '2026-01-01T00:00:00.000Z',
            userId: USER,
        });
        const outcome = reconcileWithServer(
            [queued(1, 'update', '#aa0000'), queued(2, 'update', '#bb0000')],
            serverRow('m1'),
        );
        expect(outcome).toMatchObject({ kind: 'send', ops: [{ type: 'update', userId: USER }] });
    });

    it('keeps an edit made before an erase when Undo of that erase is queued before the erase is sent', () => {
        // Integration review (reconcileInterleaving.test.ts): edit, erase,
        // reconnect — reconcile settles the pair — and Undo lands before
        // the push. The next verdict must still see the edit.
        const queued = (opId: number, type: PendingOpType, color: string, deletedAt: string | null): PendingOp => ({
            opId,
            docId: DOC,
            type,
            annotationId: 'm1',
            annotation: { ...makeStroke('m1'), color, deletedAt },
            queuedAt: '2026-01-01T00:00:00.000Z',
            userId: USER,
        });
        const erasedAt = '2026-02-02T02:02:02.000Z';
        const live = serverRow('m1', { color: '#111111' });

        const first = reconcileWithServer(
            [queued(1, 'update', '#ff0000', null), queued(2, 'delete', '#ff0000', erasedAt)],
            live,
        );
        expect(first).toMatchObject({ kind: 'send', ops: [{ type: 'update' }, { type: 'delete' }] });

        const sent = first.kind === 'send' ? first.ops : [];
        const second = reconcileWithServer(
            [...sent, { ...queued(3, 'restore', '#ff0000', null), baseDeletedAt: erasedAt }],
            live,
        );
        expect(second).toMatchObject({
            kind: 'send',
            ops: [{ type: 'update', annotation: { color: '#ff0000', deletedAt: null } }],
        });
    });

    it('keeps the ops untouched when the server rows cannot be read', async () => {
        await drawAndSync();
        api.offline = true;
        await store.undoLast();
        await store.redoLast();
        api.offline = false;
        api.fetchManyError = { message: 'bad gateway', kind: 'retry' };

        await engine.flush();

        expect(await db.ops.count()).toBe(2);
        expect(engine.pendingRetryDelayMs).not.toBeNull();
        expect(rejections).toEqual([]);
    });

    it('never folds later changes into an unsent create', async () => {
        api.offline = true;
        await store.create(makeStroke('n1'));
        await store.update('n1', { color: '#cc0000' });
        await store.delete('n1');
        api.offline = false;
        // The create's insert lands, but its answer is lost: had the delete
        // been folded into it, the retried insert would be ignored as a
        // duplicate and the mark would stay on the server.
        api.failWrites = null;
        const insert = api.insertIgnoreDuplicates.bind(api);
        let lost = false;
        api.insertIgnoreDuplicates = async (row) => {
            await insert(row);
            if (!lost) {
                lost = true;
                return { error: { message: 'timeout', kind: 'retry' } };
            }
            return { error: null };
        };
        await engine.flush();
        await engine.flush();

        expect(api.rows.get('n1')?.deleted_at).not.toBeNull();
        expect(await db.ops.count()).toBe(0);
    });
});

/**
 * QA C1: a text note erased offline, brought back with Undo and edited, while
 * a collaborator's erase reaches the server. The edit must stand even when it
 * is queued while reconcile is still reading the server — postgrest-js retries
 * a failed GET inside the one call (1 s, 2 s, 4 s), so a read that starts
 * offline is out for seconds, and the user goes on working meanwhile.
 */
describe('SyncEngine: changes queued while reconcile reads the server (QA C1)', () => {
    const NOTE = 'note-m';
    const THEIRS = '2026-08-08T08:08:08.000Z';
    const ORIGINAL = { x: 0.2, y: 0.3, text: 'cresc.', size: 0.02 };
    const EDITED = { x: 0.2, y: 0.3, text: 'cresc. poco a poco', size: 0.02 };

    const makeNote = (id: string): Annotation => ({ ...makeStroke(id), kind: 'text', payload: ORIGINAL });

    const queuedTypes = async (on = db) => (await on.ops.toArray()).map((op) => op.type);

    /** A's synced note, then — offline, nothing sent — erased and brought back with Undo. */
    const eraseAndUndo = async (on = { db, store, engine }) => {
        await on.store.create(makeNote(NOTE));
        await on.engine.flush();
        expect(await on.db.ops.count()).toBe(0);
        await on.store.delete(NOTE);
        await on.store.undoLast();
    };

    /** B's erase reaches the server: their tombstone, a new seq. */
    const collaboratorErases = (server = api) => {
        server.rows.set(NOTE, { ...server.rows.get(NOTE)!, deleted_at: THEIRS, seq: server.nextSeq++ });
    };

    /** Hold every fetchMany until released; `started` resolves once one is out. */
    const holdReads = (server = api) => {
        const read = server.fetchMany.bind(server);
        let started!: () => void;
        let release!: () => void;
        const out = {
            reads: 0,
            started: new Promise<void>((resolve) => (started = resolve)),
            released: new Promise<void>((resolve) => (release = resolve)),
            release: () => release(),
        };
        server.fetchMany = async (docId, ids) => {
            out.reads += 1;
            started();
            await out.released;
            return read(docId, ids);
        };
        return out;
    };

    const expectEditStands = async (on = { db, store, server: api }) => {
        const row = on.server.rows.get(NOTE);
        expect(row?.deleted_at).toBeNull();
        expect(row?.payload).toEqual(EDITED);
        expect(on.store.getPage(0).get(NOTE)?.payload).toEqual(EDITED);
        expect(await on.db.ops.count()).toBe(0);
    };

    it('records erase, Undo and the edit as delete, restore, update', async () => {
        await eraseAndUndo();
        await store.update(NOTE, { payload: EDITED });
        expect(await queuedTypes()).toEqual(['delete', 'restore', 'update']);
    });

    it('keeps an edit queued while the read was out, over the collaborator’s erase', async () => {
        await eraseAndUndo();
        collaboratorErases();
        const reads = holdReads();
        const flushing = engine.flush();
        await reads.started; // reconcile took [delete, restore] to the server …
        await store.update(NOTE, { payload: EDITED }); // … and the user edited the note meanwhile
        expect(await queuedTypes()).toEqual(['delete', 'restore', 'update']);

        reads.release();
        await flushing;

        // Not an edit written onto their tombstone: the note stands, as the
        // user left it, on the server and here.
        await expectEditStands();
        expect(rejections).toEqual([]);
    });

    it('waits for an edit that is drawn but not yet in the outbox when the read comes back', async () => {
        await eraseAndUndo();
        collaboratorErases();
        const reads = holdReads();
        // The edit's outbox write is held back until reconcile has looked at the queue.
        const writes = store as unknown as { writeMany(ops: unknown[]): Promise<void> };
        const write = writes.writeMany.bind(store);
        let writeOut!: () => void;
        const writeHeld = new Promise<void>((resolve) => (writeOut = resolve));
        let releaseWrite!: () => void;
        const writeReleased = new Promise<void>((resolve) => (releaseWrite = resolve));
        vi.spyOn(writes, 'writeMany').mockImplementation(async (ops) => {
            writeOut();
            await writeReleased;
            return write(ops);
        });

        let flushed = false;
        const flushing = engine.flush().then(() => {
            flushed = true;
        });
        await reads.started;
        const editing = store.update(NOTE, { payload: EDITED });
        await writeHeld;
        expect(store.getPage(0).get(NOTE)?.payload).toEqual(EDITED); // drawn …
        expect(await queuedTypes()).toEqual(['delete', 'restore']); // … not queued yet

        reads.release();
        // Every chance to decide without the edit: on its own, the flush is
        // over long before this.
        await vi.waitFor(() => expect(flushed).toBe(true), { timeout: 250, interval: 5 }).catch(() => undefined);
        releaseWrite();
        await editing;
        await flushing;
        await engine.flush(); // what the edit's dirty hook would run

        await expectEditStands();
        expect(rejections).toEqual([]);
    });

    it('waits for an edit still on its day-snapshot check when the read comes back', async () => {
        await eraseAndUndo();
        collaboratorErases();
        const reads = holdReads();
        // An edit of an existing mark checks the day's snapshot before it is
        // drawn; hold that check until reconcile has had every chance to
        // decide without the edit.
        const snapshot = snapshotService.ensureDayStartingSnapshot;
        let checking!: () => void;
        const checkOut = new Promise<void>((resolve) => (checking = resolve));
        let releaseCheck!: () => void;
        const checkReleased = new Promise<void>((resolve) => (releaseCheck = resolve));
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockImplementation(async (...args) => {
            checking();
            await checkReleased;
            return snapshot(...args);
        });

        let flushed = false;
        const flushing = engine.flush().then(() => {
            flushed = true;
        });
        await reads.started;
        const editing = store.update(NOTE, { payload: EDITED }); // Done pressed while the read is out …
        await checkOut;
        expect(store.getPage(0).get(NOTE)?.payload).toEqual(ORIGINAL); // … not drawn yet
        expect(await queuedTypes()).toEqual(['delete', 'restore']);

        reads.release(); // … and the read is back before it is
        await vi.waitFor(() => expect(flushed).toBe(true), { timeout: 250, interval: 5 }).catch(() => undefined);
        releaseCheck();
        await editing;
        await flushing;
        await engine.flush(); // what the edit's dirty hook would run

        // Not refused as an edit of a note that had meanwhile gone: it stands.
        await expectEditStands();
        expect(rejections).toEqual([]);
    });

    it('still lets a plain Undo yield to the erase, and the note is gone before it can be edited', async () => {
        await eraseAndUndo();
        collaboratorErases();
        const reads = holdReads();
        const flushing = engine.flush();
        await reads.started;
        reads.release();
        await flushing;

        expect(api.rows.get(NOTE)?.deleted_at).toBe(THEIRS);
        expect(store.getPage(0).has(NOTE)).toBe(false);
        expect(store.get(NOTE)?.deletedAt).toBe(THEIRS);

        // An edit now has nothing to edit: nothing is queued, nothing sent.
        const updates = api.updates;
        await store.update(NOTE, { payload: EDITED });
        await engine.flush();
        expect(await db.ops.count()).toBe(0);
        expect(api.updates).toBe(updates);
        expect(api.rows.get(NOTE)?.deleted_at).toBe(THEIRS);
        expect(rejections).toEqual([]);
    });

    it('does not lose an Undo queued during the read behind an erase that already landed', async () => {
        await store.create(makeNote(NOTE));
        await engine.flush();
        await store.delete(NOTE); // erase …
        await store.undoLast(); // … Undo …
        await store.redoLast(); // … Redo, all offline
        // The first erase landed, but its answer was lost: the server's
        // tombstone is this device's own.
        const ownTombstone = (await db.ops.toArray())[0]!.annotation.deletedAt!;
        api.rows.set(NOTE, { ...api.rows.get(NOTE)!, deleted_at: ownTombstone, seq: api.nextSeq++ });
        const reads = holdReads();
        const flushing = engine.flush();
        await reads.started;
        await store.undoLast(); // Undo again while the read is out
        expect(await queuedTypes()).toEqual(['delete', 'restore', 'delete', 'restore']);

        reads.release();
        await flushing;

        expect(api.rows.get(NOTE)?.deleted_at).toBeNull();
        expect(store.getPage(0).has(NOTE)).toBe(true);
        expect(await db.ops.count()).toBe(0);
    });

    /** Deterministic PRNG, so a failing interleaving can be replayed from its seed. */
    const mulberry32 = (seed: number) => () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    /** `n` yields, each a microtask, a timer or an immediate — fake-indexeddb settles on the latter two. */
    const yields = async (n: number, random: () => number) => {
        for (let i = 0; i < n; i++) {
            const pick = random();
            await new Promise<void>((resolve) => {
                if (pick < 0.3) {
                    queueMicrotask(resolve);
                } else if (pick < 0.65) {
                    setTimeout(resolve, 0);
                } else {
                    setImmediate(resolve);
                }
            });
        }
    };

    /**
     * One live trial: the erase and Undo queued, B's erase on the server
     * before the read or while it is out, the read answered after a random
     * number of yields, and the user's edit made at a random moment from
     * before the drain reads the queue to after reconcile has finished —
     * its day-snapshot check, before it is drawn, taking a random number of
     * yields too.
     *
     * `edited`: the note was on screen when the user pressed Done. Then the
     * edit must stand, however the rest interleaves. Otherwise reconcile had
     * already let the Undo yield, and B's erase stands.
     */
    const trial = async (random: () => number): Promise<{ ok: boolean; edited: boolean; outcome: string }> => {
        const tdb = new ScribblerDb(`c1-race-${crypto.randomUUID()}`);
        const tstore = new AnnotationStore(tdb, DOC);
        tstore.setAuthor(USER);
        await tstore.load();
        const server = new FakeApi();
        const refused: SyncRejection[] = [];
        const tengine = new SyncEngine({
            db: tdb,
            store: tstore,
            api: server,
            docId: DOC,
            getUserId: () => USER,
            onRejected: (r) => refused.push(r),
        });
        const theirsFirst = random() < 0.5;
        const readYields = Math.floor(random() * 10);
        // Skewed early, where the read is out; about half the runs edit in time.
        const editYields = Math.floor(random() ** 2 * 30);
        const shape = `theirsFirst=${theirsFirst} readYields=${readYields} editYields=${editYields}`;
        try {
            await eraseAndUndo({ db: tdb, store: tstore, engine: tengine });
            if (theirsFirst) {
                collaboratorErases(server);
            }
            const read = server.fetchMany.bind(server);
            server.fetchMany = async (docId, ids) => {
                await yields(readYields, random);
                if (server.rows.get(NOTE)?.deleted_at === null) {
                    collaboratorErases(server);
                }
                return read(docId, ids);
            };
            // From here on the edit is the only change the store can commit.
            let accepted = false;
            tstore.setDirtyHook(() => {
                accepted = true;
            });
            let edited = false;
            const editing = (async () => {
                await yields(editYields, random);
                edited = tstore.getPage(0).has(NOTE);
                await tstore.update(NOTE, { payload: EDITED });
            })();
            await tengine.flush();
            await editing;
            for (let i = 0; i < 5 && (await tdb.ops.count()) > 0; i++) {
                await tengine.flush(); // the dirty hook's flush
            }

            const row = server.rows.get(NOTE)!;
            const shown = tstore.getPage(0).get(NOTE);
            const outcome = `${shape} edited=${edited} accepted=${accepted} server=${row.deleted_at ?? 'live'}:${JSON.stringify(row.payload)} shown=${shown ? JSON.stringify(shown.payload) : 'gone'} queued=${await tdb.ops.count()} refused=${refused.length}`;
            const consistent = edited
                ? // The user's post-Undo edit stands, here and on the server.
                  accepted &&
                  row.deleted_at === null &&
                  JSON.stringify(row.payload) === JSON.stringify(EDITED) &&
                  JSON.stringify(shown?.payload) === JSON.stringify(EDITED)
                : // No edit was made: B's erase wins over the plain Undo, here too.
                  !accepted && row.deleted_at === THEIRS && shown === undefined;
            return { ok: consistent && refused.length === 0 && (await tdb.ops.count()) === 0, edited, outcome };
        } finally {
            tengine.stop();
            tdb.close();
            await tdb.delete();
        }
    };

    it('lets the post-Undo edit win in every one of 60 randomized interleavings', async () => {
        const seed = Number(process.env['C1_RACE_SEED'] ?? Math.floor(Math.random() * 2 ** 31));
        const random = mulberry32(seed);
        const snapshot = snapshotService.ensureDayStartingSnapshot;
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockImplementation(async (...args) => {
            await yields(Math.floor(random() * 6), random);
            return snapshot(...args);
        });
        const failures: string[] = [];
        let edits = 0;
        for (let run = 0; run < 60; run++) {
            const { ok, edited, outcome } = await trial(random);
            edits += edited ? 1 : 0;
            if (!ok) {
                failures.push(`run ${run}: ${outcome}`);
            }
        }
        expect(failures, `seed ${seed} (${edits}/60 runs edited)`).toEqual([]);
        // Both outcomes were exercised: edits that won, and Undos that yielded.
        expect(edits, `seed ${seed}`).toBeGreaterThan(0);
        expect(edits, `seed ${seed}`).toBeLessThan(60);
    }, 60_000);
});

/**
 * A pull runs beside the drain (on reconnect, the 'online' pull and the
 * drain resuming from offline). The server answers a push with no seq, so
 * the store keeps the seq from before it, and a row the pull read before the
 * push landed outranks what the push landed. Found by the randomized
 * interleaving test (reconcileInterleaving.test.ts): an erase came back, and
 * an edit of the note it showed went onto the tombstone.
 */
describe('SyncEngine: a pull read before this device’s push of the same mark landed', () => {
    /** The server reads the rows when asked; the answer is held until `release`. */
    const holdPull = () => {
        const pull = api.fetchSince.bind(api);
        let handled!: () => void;
        let release!: () => void;
        const out = {
            handled: new Promise<void>((resolve) => (handled = resolve)),
            released: new Promise<void>((resolve) => (release = resolve)),
            release: () => release(),
        };
        api.fetchSince = async (...args) => {
            api.fetchSince = pull;
            const answer = await pull(...args);
            handled();
            await out.released;
            return answer;
        };
        return out;
    };

    it('does not bring back a mark whose erase landed while the pull’s answer was on its way', async () => {
        await store.create(makeStroke('s1'));
        await engine.flush();
        const pull = holdPull();
        const pulling = engine.pullSince();
        await pull.handled; // the server read the stroke while it was live …
        await store.delete('s1');
        await engine.flush(); // … then the erase landed, and was acked
        expect(api.rows.get('s1')?.deleted_at).not.toBeNull();

        pull.release();
        await pulling;

        expect(store.getPage(0).has('s1')).toBe(false);
        expect(store.get('s1')?.deletedAt).toBe(api.rows.get('s1')?.deleted_at);
        expect(store.get('s1')?.seq).toBe(api.rows.get('s1')?.seq);
        expect(await db.ops.count()).toBe(0);
    });

    it('still applies what the pull brought for marks no push touched meanwhile', async () => {
        await store.create(makeStroke('s1'));
        await engine.flush();
        api.rows.set('theirs', serverRow('theirs', { seq: api.nextSeq++ }));
        const pull = holdPull();
        const pulling = engine.pullSince();
        await pull.handled;
        const fetches = api.fetchManys;
        pull.release();
        await pulling;

        expect(store.getPage(0).has('theirs')).toBe(true);
        expect(store.getPage(0).has('s1')).toBe(true);
        expect(api.fetchManys).toBe(fetches); // nothing in doubt, nothing asked again
    });

    it('drops, at the ack, a row held for the queued erase that the pull read before it left', async () => {
        await store.create(makeStroke('s1'));
        await engine.flush();
        const pull = holdPull();
        const pulling = engine.pullSince();
        await pull.handled; // read while live
        // The erase leaves, and is held on its way …
        const write = api.updateMany.bind(api);
        let sent!: () => void;
        const pushSent = new Promise<void>((resolve) => (sent = resolve));
        let land!: () => void;
        const landing = new Promise<void>((resolve) => (land = resolve));
        api.updateMany = async (patches) => {
            sent();
            await landing;
            return write(patches);
        };
        await store.delete('s1');
        const flushing = engine.flush();
        await pushSent;
        pull.release(); // … while the pull's answer comes in, held for the queued erase
        await pulling;
        expect(store.getPage(0).has('s1')).toBe(false);

        land();
        await flushing;

        expect(store.getPage(0).has('s1')).toBe(false);
        expect(store.get('s1')?.deletedAt).not.toBeNull();
        expect(api.rows.get('s1')?.deleted_at).not.toBeNull();
        expect(await db.ops.count()).toBe(0);
    });

    /** Each write is held after it leaves, and lands only on `land`. */
    const holdWrite = () => {
        const write = api.updateMany.bind(api);
        let sent!: () => void;
        let land!: () => void;
        const out = {
            sent: new Promise<void>((resolve) => (sent = resolve)),
            landing: new Promise<void>((resolve) => (land = resolve)),
            land: () => land(),
        };
        api.updateMany = async (patches) => {
            api.updateMany = write;
            sent();
            await out.landing;
            return write(patches);
        };
        return out;
    };

    it('asks again, rather than applying at the ack, for a row a pull read before an erase that had already left', async () => {
        await store.create(makeStroke('s1'));
        await engine.flush();
        const push = holdWrite();
        await store.delete('s1');
        const flushing = engine.flush();
        await push.sent; // the erase is on its way …
        const pull = holdPull();
        const pulling = engine.pullSince();
        await pull.handled; // … and the pull, sent after it, is read before it lands
        pull.release();
        await pulling; // held for the queued erase
        const fetches = api.fetchManys;

        push.land();
        await flushing;

        expect(store.getPage(0).has('s1')).toBe(false);
        expect(store.get('s1')?.seq).toBe(api.rows.get('s1')?.seq);
        expect(api.fetchManys).toBe(fetches + 1);
        expect(await db.ops.count()).toBe(0);
    });

    it('applies the push’s own echo, held while it was out, without asking again', async () => {
        await store.create(makeStroke('s1'));
        await engine.flush();
        const write = api.updateMany.bind(api);
        let answer!: () => void;
        const answered = new Promise<void>((resolve) => (answer = resolve));
        let landed!: () => void;
        const hasLanded = new Promise<void>((resolve) => (landed = resolve));
        api.updateMany = async (patches) => {
            api.updateMany = write;
            const result = await write(patches); // lands now …
            landed();
            await answered; // … its answer comes back later
            return result;
        };
        await store.update('s1', { color: '#ff0000' });
        const flushing = engine.flush();
        await hasLanded;
        // The realtime echo arrives first, and is held for the queued edit.
        await engine.applyServerRow(api.rows.get('s1')!);
        const fetches = api.fetchManys;

        answer();
        await flushing;

        expect(store.get('s1')?.color).toBe('#ff0000');
        expect(store.get('s1')?.seq).toBe(api.rows.get('s1')?.seq);
        expect(api.fetchManys).toBe(fetches);
    });
});

describe('isEchoOf', () => {
    const pushed = (type: PendingOpType, overrides: Partial<Annotation> = {}): PendingOp => ({
        docId: DOC,
        annotationId: 's1',
        type,
        queuedAt: '2026-01-01T00:00:00.000Z',
        annotation: { ...makeStroke('s1'), ...overrides },
    });
    const payload = { pts: [0.1, 0.1, 0.5, 0.2, 0.2, 0.5], w: 0.005 };
    const row = (overrides: Partial<AnnotationRow> = {}) =>
        serverRow('s1', { color: '#111111', payload, ...overrides });

    it('tells an update’s echo by its content, whatever order jsonb gives the keys', () => {
        const reordered = { w: 0.005, pts: [0.1, 0.1, 0.5, 0.2, 0.2, 0.5] };
        expect(isEchoOf(row({ payload: reordered }), pushed('update'))).toBe(true);
        // On a collaborator's tombstone: still the echo, and the truth.
        expect(isEchoOf(row({ deleted_at: '2026-05-05T05:05:05.000Z' }), pushed('update'))).toBe(true);
        expect(isEchoOf(row({ color: '#222222' }), pushed('update'))).toBe(false);
    });

    it('tells a delete’s echo by its own instant only', () => {
        const at = '2026-03-03T03:03:03.000Z';
        expect(isEchoOf(row({ deleted_at: '2026-03-03T03:03:03+00:00' }), pushed('delete', { deletedAt: at }))).toBe(
            true,
        );
        expect(isEchoOf(row({ deleted_at: '2026-04-04T04:04:04.000Z' }), pushed('delete', { deletedAt: at }))).toBe(
            false,
        );
        expect(isEchoOf(row(), pushed('delete', { deletedAt: at }))).toBe(false);
    });

    it('wants a restore’s echo live', () => {
        expect(isEchoOf(row(), pushed('restore'))).toBe(true);
        expect(isEchoOf(row({ deleted_at: '2026-04-04T04:04:04.000Z' }), pushed('restore'))).toBe(false);
    });
});

describe('SyncEngine status', () => {
    const statuses: string[] = [];
    let statusEngine: SyncEngine;

    beforeEach(() => {
        statuses.length = 0;
        statusEngine = new SyncEngine({
            db,
            store,
            api,
            docId: DOC,
            getUserId: () => USER,
            onStatus: (s) => statuses.push(s),
        });
    });

    afterEach(() => {
        statusEngine.stop();
    });

    it('stays offline after a failed pull, even with nothing queued', async () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        api.offline = true;
        await statusEngine.sync();
        expect(statuses.at(-1)).toBe('offline');
        expect(statuses).not.toContain('synced');
    });

    it('does not claim synced while the server cannot be reached', async () => {
        api.offline = true;
        await statusEngine.sync();
        expect(statuses.at(-1)).toBe('retrying');
        expect(statuses).not.toContain('synced');
    });

    it('shows a transient failure as retrying, and only a long one as an error', async () => {
        const start = Date.parse('2026-05-05T05:00:00Z');
        const now = vi.spyOn(Date, 'now').mockReturnValue(start);
        api.failWrites = { error: { message: 'too many', kind: 'retry' }, times: 10 };
        await store.create(makeStroke('a1'));
        await statusEngine.flush();
        expect(statuses.at(-1)).toBe('retrying');

        now.mockReturnValue(start + PERSISTENT_FAILURE_MS + 1);
        await statusEngine.flush();
        expect(statuses.at(-1)).toBe('error');

        api.failWrites = null;
        await statusEngine.sync();
        expect(statuses.at(-1)).toBe('synced');
    });

    it('reports a pull the server refuses as an error', async () => {
        api.fetchSince = async () => ({ data: null, error: { message: 'forbidden', kind: 'reject' } });
        await statusEngine.sync();
        expect(statuses.at(-1)).toBe('error');
    });

    it('says synced once a pull and the outbox both went through', async () => {
        await store.create(makeStroke('a1'));
        await statusEngine.sync();
        expect(statuses.at(-1)).toBe('synced');
    });
});

describe('SyncEngine shared outbox', () => {
    it('two engines on one document drain it one at a time, never pushing an op twice', async () => {
        const other = new SyncEngine({
            db,
            store: new AnnotationStore(db, DOC),
            api,
            docId: DOC,
            getUserId: () => USER,
        });
        for (let i = 0; i < 5; i++) {
            await store.create(makeStroke(`s${i}`));
        }
        const inserts = vi.spyOn(api, 'insertMany');
        await Promise.all([engine.flush(), other.flush()]);
        other.stop();

        expect(inserts).toHaveBeenCalledTimes(1);
        expect(await db.ops.count()).toBe(0);
    });
});

describe('SyncEngine mirror repairs reach the open viewer', () => {
    /**
     * The viewer: its own store and a started engine, as on screen. Its own
     * network is down, so whatever reaches its store came from the repair,
     * not from it syncing for itself.
     */
    let viewerStore: AnnotationStore;
    let viewer: SyncEngine;
    let viewerRejections: SyncRejection[];

    const openViewer = async () => {
        viewerStore = new AnnotationStore(db, DOC);
        viewerStore.setAuthor(USER);
        await viewerStore.load();
        const viewerApi = new FakeApi();
        viewerApi.offline = true;
        viewerRejections = [];
        viewer = new SyncEngine({
            db,
            store: viewerStore,
            api: viewerApi,
            docId: DOC,
            getUserId: () => USER,
            onRejected: (r) => viewerRejections.push(r),
        });
        viewer.start();
    };

    /**
     * Another engine on the score — the background drain's, sign-out's: a
     * headless engine over a store nobody draws.
     */
    const drainInBackground = async () => {
        const headless = new SyncEngine({
            db,
            store: new AnnotationStore(db, DOC),
            api,
            docId: DOC,
            getUserId: () => USER,
        });
        await headless.flush();
        headless.stop();
    };

    afterEach(() => {
        viewer.stop();
    });

    it('shows a collaborator’s delete that the background drain adopted over an offline undo/redo', async () => {
        await openViewer();
        await viewerStore.create(makeStroke('m5'));
        await viewerStore.create(makeStroke('m6'));
        await engine.flush(); // synced while online
        await viewerStore.undoLast(); // delete m6, offline
        await viewerStore.undoLast(); // delete m5
        await viewerStore.redoLast(); // restore m5
        await viewerStore.redoLast(); // restore m6
        expect(await db.ops.count()).toBe(4);
        expect(viewerStore.getPage(0).has('m6')).toBe(true);

        const erasedAt = '2026-03-03T03:03:03.000Z';
        api.rows.set('m6', { ...api.rows.get('m6')!, deleted_at: erasedAt, seq: api.nextSeq++ });

        await drainInBackground();

        expect(await db.ops.count()).toBe(0);
        await vi.waitFor(() => expect(viewerStore.getPage(0).has('m6')).toBe(false));
        expect(viewerStore.get('m6')?.deletedAt).toBe(erasedAt);
        expect(viewerStore.getPage(0).has('m5')).toBe(true);
        expect(viewerRejections).toEqual([]);
    });

    it('rolls a refused change back on the viewer’s screen and tells it why', async () => {
        await store.create(makeStroke('r1'));
        await engine.flush();
        await openViewer();
        await viewerStore.update('r1', { color: '#ff0000' });
        api.invisibleToUpdate.add('r1');
        // Sign-out's drain, say (the background drain holds refusals instead).

        await drainInBackground();

        await vi.waitFor(() => expect(viewerRejections.map((r) => r.annotationId)).toEqual(['r1']));
        expect(viewerStore.get('r1')?.color).toBe('#111111');
        expect(viewerStore.getPage(0).get('r1')?.color).toBe('#111111');
    });

    it('does not overwrite a change the viewer still has queued', async () => {
        await store.create(makeStroke('q1'));
        await engine.flush();
        await openViewer();
        await viewerStore.update('q1', { color: '#00aa00' });

        await viewerStore.reloadFromMirror(['q1']);

        expect(viewerStore.get('q1')?.color).toBe('#00aa00');
    });

    it('hears repairs made in another tab, for its own database only', async () => {
        await store.create(makeStroke('t1'));
        await engine.flush();
        await openViewer();
        // Another tab adopted the server's tombstone into the shared mirror.
        const mirror = (await db.annotations.get('t1'))!;
        await db.annotations.put({ ...mirror, deletedAt: '2026-05-05T05:05:05.000Z', seq: 99 });

        const otherTab = new BroadcastChannel('cleffy-sync');
        try {
            otherTab.postMessage({ db: 'some-other-db', docId: DOC, annotationIds: ['t1'], origin: 'tab-2' });
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(viewerStore.getPage(0).has('t1')).toBe(true);

            otherTab.postMessage({
                db: db.name,
                docId: DOC,
                annotationIds: ['t1'],
                origin: 'tab-2',
                rejection: { annotationId: 't1', opType: 'update', reason: 'refused' },
            });
            await vi.waitFor(() => expect(viewerStore.getPage(0).has('t1')).toBe(false));
            expect(viewerRejections.map((r) => r.annotationId)).toEqual(['t1']);
        } finally {
            otherTab.close();
        }
    });
});

describe('SyncEngine across tabs of the same account', () => {
    /** Another tab on the score: its own store and started engine over the shared mirror. */
    const openTab = async (tabApi: FakeApi) => {
        const tabStore = new AnnotationStore(db, DOC);
        tabStore.setAuthor(USER);
        await tabStore.load();
        const tab = new SyncEngine({ db, store: tabStore, api: tabApi, docId: DOC, getUserId: () => USER });
        tab.start();
        return { tabStore, tab };
    };

    const offlineApi = () => {
        const offline = new FakeApi();
        offline.offline = true;
        return offline;
    };

    /** The server as another tab reads it: its writes fail, so the first tab is the one that pushes. */
    const readerOf = (server: FakeApi): FakeApi => {
        const reader = Object.create(server) as FakeApi;
        const down = async () => ({ error: { message: 'network down', kind: 'retry' as const } });
        reader.insertIgnoreDuplicates = down;
        reader.insertMany = down;
        reader.update = down;
        reader.updateMany = down;
        return reader;
    };

    it('tells the other tab of each adoption at once, not after the rest of the batch', async () => {
        await store.create(makeStroke('e1'));
        await store.create(makeStroke('e2'));
        await engine.flush();
        // Offline, so it leaves the outbox to this tab.
        const second = await openTab(offlineApi());
        try {
            // Erased and brought back with Undo here, offline: nothing sent.
            for (const id of ['e1', 'e2']) {
                await store.delete(id);
                await store.undoLast();
            }
            // A collaborator erased both meanwhile.
            const erasedAt = '2026-04-04T04:04:04.000Z';
            for (const id of ['e1', 'e2']) {
                api.rows.set(id, { ...api.rows.get(id)!, deleted_at: erasedAt, seq: api.nextSeq++ });
            }
            const heard: string[] = [];
            const reload = second.tabStore.reloadFromMirror.bind(second.tabStore);
            vi.spyOn(second.tabStore, 'reloadFromMirror').mockImplementation((ids, options) => {
                heard.push(...ids);
                return reload(ids, options);
            });
            // What the other tab had heard when e2's verdict was taken.
            let heardBeforeE2: string[] | null = null;
            const unsaved = store.hasUnsavedEdit.bind(store);
            vi.spyOn(store, 'hasUnsavedEdit').mockImplementation((id) => {
                if (id === 'e2' && !heardBeforeE2) {
                    heardBeforeE2 = [...heard];
                }
                return unsaved(id);
            });

            await engine.flush();

            // Until it hears, the other tab draws e1, and an edit of it
            // there would go out as a plain update onto the tombstone.
            expect(heardBeforeE2).toEqual(['e1']);
            await vi.waitFor(() => expect(second.tabStore.getPage(0).size).toBe(0));
            expect(second.tabStore.get('e1')?.deletedAt).toBe(erasedAt);
            expect(await db.ops.count()).toBe(0);
        } finally {
            second.tab.stop();
        }
    });

    it('shows what the other tab draws and erases at once, offline included', async () => {
        const first = await openTab(offlineApi());
        const second = await openTab(offlineApi());
        try {
            for (let i = 0; i < 4; i++) {
                await first.tabStore.create(makeStroke(`s${i}`));
            }
            await vi.waitFor(() => expect(second.tabStore.getPage(0).size).toBe(4));

            await first.tabStore.delete('s2');
            await vi.waitFor(() => expect(second.tabStore.getPage(0).has('s2')).toBe(false));
            expect(await db.ops.count()).toBe(5);
        } finally {
            first.tab.stop();
            second.tab.stop();
        }
    });

    it('shows strokes whose broadcast reached the other tab before they were acked', async () => {
        const second = await openTab(readerOf(api));
        // Like the database broadcast: every committed row reaches every
        // subscriber — here, before this tab's request returns.
        const insert = api.insertMany.bind(api);
        vi.spyOn(api, 'insertMany').mockImplementation(async (rows) => {
            const result = await insert(rows);
            for (const row of rows) {
                await second.tab.applyServerRow(api.rows.get(row.id)!);
            }
            return result;
        });
        try {
            for (let i = 0; i < 4; i++) {
                await store.create(makeStroke(`s${i}`));
            }
            await engine.flush();

            expect(await db.ops.count()).toBe(0);
            await vi.waitFor(() => expect(second.tabStore.getPage(0).size).toBe(4));
            // The server's rows, not just this device's copies of them.
            await vi.waitFor(() => expect(second.tabStore.get('s0')?.seq).toBe(api.rows.get('s0')?.seq));
        } finally {
            second.tab.stop();
        }
    });

    it('applies a collaborator’s change that landed while this device’s edit was in flight', async () => {
        await store.create(makeStroke('m1'));
        await engine.flush();
        const second = await openTab(readerOf(api));
        try {
            await store.update('m1', { color: '#aa0000' });

            // The edit lands; a collaborator recolours the mark right after,
            // and that broadcast arrives while the edit is still queued here.
            const update = api.update.bind(api);
            vi.spyOn(api, 'update').mockImplementation(async (id, docId, patch) => {
                const result = await update(id, docId, patch);
                api.rows.set(id, { ...api.rows.get(id)!, color: '#00aa00', seq: api.nextSeq++ });
                await engine.applyServerRow(api.rows.get(id)!);
                await second.tab.applyServerRow(api.rows.get(id)!);
                return result;
            });
            await engine.flush();

            // Both tabs show the server's mark, not the edit it superseded.
            expect(api.rows.get('m1')?.color).toBe('#00aa00');
            expect(store.get('m1')?.color).toBe('#00aa00');
            await vi.waitFor(() => expect(second.tabStore.get('m1')?.color).toBe('#00aa00'));
        } finally {
            second.tab.stop();
        }
    });

    it('does not let a row older than an acked edit replace it', async () => {
        await store.create(makeStroke('m1'));
        await engine.flush();
        api.offline = true;
        await store.update('m1', { color: '#aa0000' });
        // A collaborator's earlier change, heard while the edit sat queued.
        api.rows.set('m1', { ...api.rows.get('m1')!, color: '#00aa00', seq: api.nextSeq++ });
        await engine.applyServerRow(api.rows.get('m1')!);
        api.offline = false;

        await engine.flush();

        expect(api.rows.get('m1')?.color).toBe('#aa0000');
        expect(store.get('m1')?.color).toBe('#aa0000');
    });

    /** Every colour `tabStore` draws for `id` from now on. */
    const coloursDrawn = (tabStore: AnnotationStore, id: string): string[] => {
        const seen: string[] = [];
        tabStore.subscribe(() => {
            const colour = tabStore.get(id)?.color;
            if (colour && seen[seen.length - 1] !== colour) {
                seen.push(colour);
            }
        });
        return seen;
    };

    /**
     * m1 synced; tab 1 recolours it offline; a collaborator's earlier change
     * reaches both tabs while that edit sits queued; tab 1 reconnects and
     * pushes. Returns the colours tab 2 draws from the push on.
     */
    const pushOverHeldRow = async (second: { tabStore: AnnotationStore; tab: SyncEngine }) => {
        const first = await openTab(api);
        api.offline = true;
        await first.tabStore.update('m1', { color: '#aa0000' });
        await vi.waitFor(() => expect(second.tabStore.get('m1')?.color).toBe('#aa0000'));
        api.rows.set('m1', { ...api.rows.get('m1')!, color: '#00aa00', seq: api.nextSeq++ });
        await first.tab.applyServerRow(api.rows.get('m1')!);
        await second.tab.applyServerRow(api.rows.get('m1')!);
        expect(second.tabStore.get('m1')?.color).toBe('#aa0000');

        const drawn = coloursDrawn(second.tabStore, 'm1');
        api.offline = false;
        await vi.waitFor(async () => {
            await first.tab.flush();
            expect(await db.ops.count()).toBe(0);
        });
        expect(api.rows.get('m1')?.color).toBe('#aa0000');
        expect(first.tabStore.get('m1')?.color).toBe('#aa0000');
        return { first, drawn };
    };

    it('never shows a row that the other tab’s acked edit superseded, even unable to ask the server', async () => {
        await store.create(makeStroke('m1'));
        await engine.flush();
        const second = await openTab(offlineApi());
        const { first, drawn } = await pushOverHeldRow(second);
        try {
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(drawn).not.toContain('#00aa00');
            expect(second.tabStore.get('m1')?.color).toBe('#aa0000');
        } finally {
            first.tab.stop();
            second.tab.stop();
        }
    });

    it('asks the server how a mark stands once the other tab’s push settles it', async () => {
        await store.create(makeStroke('m1'));
        await engine.flush();
        const second = await openTab(readerOf(api));
        const { first, drawn } = await pushOverHeldRow(second);
        try {
            // The server's row (its seq included), not the held one.
            await vi.waitFor(() => expect(second.tabStore.get('m1')?.seq).toBe(api.rows.get('m1')?.seq));
            expect(drawn).not.toContain('#00aa00');
            expect(second.tabStore.get('m1')?.color).toBe('#aa0000');
        } finally {
            first.tab.stop();
            second.tab.stop();
        }
    });

    it('shows a collaborator’s change made after the other tab’s push, held while it was in flight', async () => {
        await store.create(makeStroke('m1'));
        await engine.flush();
        const second = await openTab(readerOf(api));
        const first = await openTab(api);
        try {
            api.offline = true;
            await first.tabStore.update('m1', { color: '#aa0000' });
            await vi.waitFor(() => expect(second.tabStore.get('m1')?.color).toBe('#aa0000'));
            // The edit lands; a collaborator recolours the mark right after,
            // and that broadcast reaches tab 2 while the edit is still queued.
            const update = api.update.bind(api);
            vi.spyOn(api, 'update').mockImplementation(async (id, docId, patch) => {
                const result = await update(id, docId, patch);
                api.rows.set(id, { ...api.rows.get(id)!, color: '#0000aa', seq: api.nextSeq++ });
                await second.tab.applyServerRow(api.rows.get(id)!);
                return result;
            });
            api.offline = false;
            await vi.waitFor(async () => {
                await first.tab.flush();
                expect(await db.ops.count()).toBe(0);
            });

            await vi.waitFor(() => expect(second.tabStore.get('m1')?.color).toBe('#0000aa'));
        } finally {
            first.tab.stop();
            second.tab.stop();
        }
    });
});

describe('SyncEngine with another account’s changes queued on the device', () => {
    const OTHER = 'user-other';

    /** A mark drawn offline by `author` in an earlier session on this browser. */
    const queuedBy = async (author: string | null, id: string) => {
        const earlier = new AnnotationStore(db, DOC);
        earlier.setAuthor(author);
        await earlier.create(makeStroke(id));
    };

    const openAs = async (userId: string) => {
        const viewerStore = new AnnotationStore(db, DOC);
        viewerStore.setAuthor(userId);
        await viewerStore.load();
        const viewer = new SyncEngine({ db, store: viewerStore, api, docId: DOC, getUserId: () => userId });
        return { viewerStore, viewer };
    };

    it('never uploads them under the signed-in account, nor draws them', async () => {
        await queuedBy(OTHER, 'theirs');
        const { viewerStore, viewer } = await openAs(USER);
        try {
            expect(viewerStore.getPage(0).has('theirs')).toBe(false);
            await viewerStore.create(makeStroke('mine'));

            await viewer.flush();

            expect([...api.rows.keys()]).toEqual(['mine']);
            expect(api.rows.get('mine')?.created_by).toBe(USER);
            // Kept for their own account, untouched.
            const left = await db.ops.toArray();
            expect(left.map((op) => [op.annotationId, op.userId])).toEqual([['theirs', OTHER]]);
            expect((await db.annotations.get('theirs'))?.pending).toBe(1);
            expect(viewerStore.getPage(0).has('theirs')).toBe(false);
        } finally {
            viewer.stop();
        }
    });

    it('uploads them once their own account is back', async () => {
        await queuedBy(OTHER, 'theirs');
        const { viewerStore, viewer } = await openAs(OTHER);
        try {
            expect(viewerStore.getPage(0).has('theirs')).toBe(true);
            await viewer.flush();
            expect(api.rows.get('theirs')?.created_by).toBe(OTHER);
            expect(await db.ops.count()).toBe(0);
        } finally {
            viewer.stop();
        }
    });

    it('treats unstamped ops as this account’s only on a score it cached', async () => {
        await queuedBy(null, 'legacy');
        const first = await openAs(USER);
        await first.viewer.flush();
        first.viewer.stop();
        expect(api.rows.size).toBe(0);
        expect(first.viewerStore.getPage(0).has('legacy')).toBe(false);

        await db.pdfCache.put({ docId: DOC, bytes: new ArrayBuffer(8), title: 'Score', cachedAt: '', userId: USER });
        const second = await openAs(USER);
        expect(second.viewerStore.getPage(0).has('legacy')).toBe(true);
        await second.viewer.flush();
        second.viewer.stop();
        expect([...api.rows.keys()]).toEqual(['legacy']);
    });

    it('shows this account’s own queued marks once the session resolves', async () => {
        await queuedBy(USER, 'mine');
        // A warm open paints before the session (and so the author) is known.
        const viewerStore = new AnnotationStore(db, DOC);
        await viewerStore.load();
        expect(viewerStore.getPage(0).has('mine')).toBe(false);

        viewerStore.setAuthor(USER);
        await vi.waitFor(() => expect(viewerStore.getPage(0).has('mine')).toBe(true));
        viewerStore.setAuthor(OTHER);
        await vi.waitFor(() => expect(viewerStore.getPage(0).has('mine')).toBe(false));
    });
});

/**
 * A fake server that compacts tombstones the way compact_annotation_tombstones
 * does since 20261021120600: the tombstone rows go, and the score's floor
 * becomes the highest seq removed.
 */
class CompactingApi extends FakeApi {
    floor = 0;
    floorError: ApiError | null = null;
    floorChecks = 0;

    async fetchResyncFloor() {
        this.floorChecks += 1;
        return this.floorError ? { floor: null, error: this.floorError } : { floor: this.floor, error: null };
    }

    tombstone(id: string) {
        const row = this.rows.get(id)!;
        this.rows.set(id, { ...row, deleted_at: '2026-01-02T00:00:00Z', seq: this.nextSeq++ });
    }

    compact() {
        for (const [id, row] of this.rows) {
            if (row.deleted_at) {
                this.floor = Math.max(this.floor, row.seq);
                this.rows.delete(id);
            }
        }
    }

    add(id: string) {
        this.rows.set(id, serverRow(id, { seq: this.nextSeq++ }));
    }
}

describe('SyncEngine after tombstone compaction', () => {
    let server: CompactingApi;
    let device: SyncEngine;

    beforeEach(async () => {
        server = new CompactingApi();
        device = new SyncEngine({ db, store, api: server, docId: DOC, getUserId: () => USER });
        // The device syncs two marks, then goes away.
        server.add('m1');
        server.add('m2');
        await device.pullSince();
        expect((await db.syncState.get(DOC))?.watermarkSeq).toBe(2);
    });

    afterEach(() => device.stop());

    it('a live row arriving before the first pull back does not let the device off', async () => {
        server.tombstone('m1');
        server.add('m3');
        server.compact();
        server.add('m4');
        await device.applyServerRow(server.rows.get('m4')!); // broadcast, seq 5

        await device.pullSince();

        expect(store.getPage(0).has('m1')).toBe(false);
        expect(store.getPage(0).has('m4')).toBe(true);
    });

    it('a device back after its missed deletion was compacted resyncs, and the mark disappears', async () => {
        // Meanwhile: m1 is deleted (say, a deleted student's mark), its
        // tombstone is compacted, and someone adds m3.
        server.tombstone('m1');
        server.add('m3');
        server.compact();
        expect(server.floor).toBe(3);

        await device.pullSince();

        expect(store.get('m1')).toBeUndefined();
        expect(store.getPage(0).has('m1')).toBe(false);
        expect(await db.annotations.get('m1')).toBeUndefined();
        expect(store.getPage(0).has('m2')).toBe(true);
        expect(store.getPage(0).has('m3')).toBe(true);
        expect((await db.syncState.get(DOC))?.watermarkSeq).toBe(4);
    });

    it('keeps a mark with a change still queued, and one never synced', async () => {
        server.tombstone('m1');
        server.compact();
        server.offline = true;
        await store.update('m1', { color: '#123456' });
        await store.create(makeStroke('local'));
        server.offline = false;

        await device.pullSince();

        expect(store.get('m1')).toBeDefined();
        expect(store.getPage(0).has('local')).toBe(true);
        expect(store.getPage(0).has('m2')).toBe(true);
    });

    it('resyncs once: the watermark is then at or past the floor, and pulls go back to the watermark', async () => {
        server.tombstone('m1');
        server.compact();
        await device.pullSince();
        expect(store.get('m1')).toBeUndefined();

        const fetchSince = vi.spyOn(server, 'fetchSince');
        await device.pullSince();
        expect(fetchSince).toHaveBeenCalledWith(DOC, 0, expect.any(Number)); // 3 - overlap, clamped
        expect((await db.syncState.get(DOC))?.watermarkSeq).toBe(3);
        expect(store.getPage(0).has('m2')).toBe(true);
    });

    it('a device that saw the tombstone before it was compacted pulls by watermark and drops nothing', async () => {
        server.tombstone('m1');
        await device.pullSince(); // sees the tombstone (seq 3)
        server.add('m3');
        server.compact();
        const dropAbsent = vi.spyOn(store, 'dropAbsent');

        await device.pullSince();

        expect(dropAbsent).not.toHaveBeenCalled();
        expect(store.getPage(0).has('m1')).toBe(false);
        expect(store.getPage(0).has('m3')).toBe(true);
    });

    it('a failed floor check does not hold sync up: it pulls by watermark and asks again next time', async () => {
        server.tombstone('m1');
        server.add('m3');
        server.compact();
        server.floorError = { message: 'not deployed yet', kind: 'retry' };

        await device.pullSince();
        expect(store.getPage(0).has('m3')).toBe(true);
        expect(store.getPage(0).has('m1')).toBe(true);

        server.floorError = null;
        await device.pullSince();
        expect(store.getPage(0).has('m1')).toBe(false);
        expect(server.floorChecks).toBe(2); // the first pull ever had nothing to check
    });
});
