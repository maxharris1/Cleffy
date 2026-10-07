import { takeRetryAfterHint } from '@/lib/retryAfter';
import type { TypedSupabaseClient } from '@/lib/supabase';
import type { AnnotationStore } from '@/sync/annotationStore';
import type { PendingOp, PendingOpType, ScribblerDb } from '@/sync/db';
import type { AnnotationInsert, AnnotationRow, AnnotationUpdate } from '@/types/database';
import type { Annotation } from '@/types/models';

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error';

/** Pull overlap window: covers the commit-visibility race where seq N commits
 * after N+1 was pulled while broadcast was down (plan §sync). */
const PULL_OVERLAP = 50;
const PULL_PAGE_SIZE = 500;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
/** Outbox ops drained per round-trip (creates / patches). */
const FLUSH_BATCH_SIZE = 40;

export type AnnotationPatchRow = { id: string; document_id: string } & AnnotationUpdate;

/**
 * The slice of the Supabase client the engine needs — injected so tests can
 * exercise the full offline→queue→flush→converge cycle with a fake.
 */
export interface AnnotationsApi {
    insertIgnoreDuplicates(row: AnnotationInsert): Promise<{ error: ApiError | null }>;
    /** Multi-row create; same semantics as insertIgnoreDuplicates per row. */
    insertMany(rows: AnnotationInsert[]): Promise<{ error: ApiError | null }>;
    update(id: string, docId: string, patch: AnnotationUpdate): Promise<PatchResult>;
    /** Multi-row patch; each entry is { id, document_id, ...AnnotationUpdate }. */
    updateMany(patches: AnnotationPatchRow[]): Promise<PatchResult>;
    fetchOne(id: string): Promise<{ data: AnnotationRow | null; error: ApiError | null }>;
    fetchSince(
        docId: string,
        afterSeq: number,
        limit: number,
    ): Promise<{ data: AnnotationRow[] | null; error: ApiError | null }>;
    /**
     * Get a fresh access token after a 401. True when one is now in place.
     * A tab that slept past its JWT's expiry wakes before the auth client's
     * refresh timer does, and its first flush would otherwise be refused.
     */
    refreshAuth?(): Promise<boolean>;
}

export interface PatchResult {
    error: ApiError | null;
    /**
     * Ids of the rows the server actually updated. A patch RLS filtered out
     * (or whose row does not exist) succeeds with zero rows and no error, so
     * an id missing here is a refusal, not a success. Null/undefined means the
     * server could not say (the pre-20261007120200 void RPC) — treated as
     * applied, the old behaviour.
     */
    updatedIds?: string[] | null;
}

/**
 * - retry: connectivity, timeouts, throttling, server faults — keep the op and back off.
 * - auth: the access token was refused (401) — refresh it, then retry; never drop.
 * - reject: the server refused this op for good (RLS 403, check/invalid-input 400,
 *   conflict 409) — drop it, adopt server truth, tell the user.
 */
export type ApiErrorKind = 'retry' | 'auth' | 'reject';

export interface ApiError {
    message: string;
    kind: ApiErrorKind;
    /** Server-requested wait before retrying (Retry-After), when it sent one. */
    retryAfterMs?: number;
}

/** A local change the server permanently refused; local state has been repaired. */
export interface SyncRejection {
    annotationId: string;
    opType: PendingOpType;
    reason: string;
}

/**
 * Classify a failed PostgREST/RPC response by HTTP status.
 *
 * Only statuses that cannot change on retry may lose a user's edit, so the
 * default for anything ambiguous is to keep the op. 404 is retried too: from
 * PostgREST it means a missing table or function — a deploy in progress, not
 * a verdict on this row.
 */
export const classifyFailure = (message: string, status?: number): ApiError => {
    if (status === undefined || status === 0) {
        return { message, kind: 'retry' };
    }
    if (status === 401) {
        return { message, kind: 'auth' };
    }
    if (status === 429 || status === 503) {
        const retryAfterMs = takeRetryAfterHint();
        return retryAfterMs === undefined ? { message, kind: 'retry' } : { message, kind: 'retry', retryAfterMs };
    }
    if (status === 404 || status === 408 || status === 425 || status >= 500) {
        return { message, kind: 'retry' };
    }
    return { message, kind: 'reject' };
};

export const fromServerRow = (row: AnnotationRow): Annotation => ({
    id: row.id,
    docId: row.document_id,
    page: row.page,
    kind: row.kind,
    color: row.color,
    payload: row.payload,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    seq: row.seq,
});

interface PushResult {
    error: ApiError | null;
    /** Set when the server reported which rows a patch batch touched. */
    updatedIds: ReadonlySet<string> | null;
}

/** Engines currently running, by document — sign-out drains through these. */
const activeEngines = new Map<string, SyncEngine>();

export const activeEngineFor = (docId: string): SyncEngine | undefined => activeEngines.get(docId);

/**
 * Drains the Dexie outbox to Supabase and pulls remote changes by watermark.
 * One instance per open cloud document. Local-first: the UI never waits on
 * this — it reacts to AnnotationStore, which this engine feeds via
 * applyRemoteBatch (plan §sync).
 *
 * An op leaves the outbox only when the server accepted it, or refused it for
 * good AND the row's server state has been fetched to repair local state
 * from. Everything else — offline, timeouts, throttling, an expired token,
 * a server fault — keeps the op and retries with backoff.
 */
export class SyncEngine {
    private flushing = false;
    private pulling = false;
    private stopped = false;
    private backoffMs = INITIAL_BACKOFF_MS;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private retryAt = 0;
    private lastRetryDelay: number | null = null;
    private onlineListener = () => this.onOnline();
    private offlineListener = () => this.setStatus('offline');
    private status: SyncStatus = 'syncing';

    constructor(
        private deps: {
            db: ScribblerDb;
            store: AnnotationStore;
            api: AnnotationsApi;
            docId: string;
            getUserId: () => string | null;
            onStatus?: (status: SyncStatus) => void;
            /** A local change was refused for good and rolled back to server truth. */
            onRejected?: (rejection: SyncRejection) => void;
        },
    ) {}

    start(): void {
        this.deps.store.setDirtyHook(() => this.requestFlush());
        window.addEventListener('online', this.onlineListener);
        window.addEventListener('offline', this.offlineListener);
        activeEngines.set(this.deps.docId, this);
        if (navigator.onLine === false) {
            this.setStatus('offline');
        }
        void this.sync();
    }

    stop(): void {
        this.stopped = true;
        this.deps.store.setDirtyHook(null);
        window.removeEventListener('online', this.onlineListener);
        window.removeEventListener('offline', this.offlineListener);
        if (activeEngines.get(this.deps.docId) === this) {
            activeEngines.delete(this.deps.docId);
        }
        this.clearRetry();
    }

    /** Delay of the currently scheduled retry (ms), or null when none is pending. */
    get pendingRetryDelayMs(): number | null {
        return this.retryTimer ? this.lastRetryDelay : null;
    }

    /**
     * Full cycle: pull remote changes, then push local ops. Waits for the
     * store to hydrate from Dexie first, so pulled rows merge against the
     * mirror instead of racing the load that would otherwise replace them.
     */
    async sync(): Promise<void> {
        await this.deps.store.load();
        await this.pullSince();
        await this.flush();
    }

    /**
     * Wake the flush after a local edit. While a retry is scheduled the edit
     * just queues: the timer drains everything, and a throttled server is not
     * hit again early because someone drew another stroke.
     */
    requestFlush(): void {
        if (this.retryTimer) {
            return;
        }
        queueMicrotask(() => void this.flush());
    }

    private onOnline(): void {
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.clearRetry();
        void this.sync();
    }

    private setStatus(status: SyncStatus): void {
        if (this.status !== status) {
            this.status = status;
            this.deps.onStatus?.(status);
        }
    }

    private clearRetry(): void {
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
    }

    /**
     * Exponential backoff with jitter (half fixed, half random, so devices that
     * lost the same server together do not come back in lockstep). A server
     * Retry-After is a floor, and it may push an already-scheduled retry later.
     */
    private scheduleRetry(retryAfterMs?: number): void {
        if (this.stopped) {
            return;
        }
        const base = this.backoffMs;
        const delay = Math.max(Math.round(base / 2 + Math.random() * (base / 2)), retryAfterMs ?? 0);
        const at = Date.now() + delay;
        if (this.retryTimer) {
            if (retryAfterMs === undefined || at <= this.retryAt) {
                return;
            }
            this.clearRetry();
        }
        this.backoffMs = Math.min(base * 2, MAX_BACKOFF_MS);
        this.retryAt = at;
        this.lastRetryDelay = delay;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.sync();
        }, delay);
    }

    /** Keep the outbox as it is and come back later. */
    private deferRetry(error: ApiError): void {
        this.setStatus(navigator.onLine === false ? 'offline' : 'error');
        this.scheduleRetry(error.retryAfterMs);
    }

    /**
     * Run a request; on a 401, refresh the session once and run it again. A
     * 401 that survives the refresh (or a refresh that failed — offline, or
     * the refresh token itself expired) is reported as retryable: the op is
     * kept, never treated as a refusal of its content.
     */
    private async withAuth<T extends { error: ApiError | null }>(call: () => Promise<T>): Promise<T> {
        const first = await call();
        if (first.error?.kind !== 'auth') {
            return first;
        }
        const refreshed = this.deps.api.refreshAuth ? await this.deps.api.refreshAuth().catch(() => false) : false;
        const second = refreshed ? await call() : first;
        if (second.error?.kind === 'auth') {
            return { ...second, error: { ...second.error, kind: 'retry' } };
        }
        return second;
    }

    async flush(): Promise<void> {
        if (this.flushing || this.stopped) {
            return;
        }
        this.flushing = true;
        try {
            const { db, docId } = this.deps;
            for (;;) {
                if (this.stopped) {
                    return;
                }
                const ops = await db.ops.where('docId').equals(docId).sortBy('opId');
                if (ops.length === 0) {
                    break;
                }
                this.setStatus('syncing');

                const batch = takeHomogeneousBatch(ops, FLUSH_BATCH_SIZE);
                const result = await this.push(batch);

                if (result.error?.kind === 'reject' && batch.length > 1) {
                    // Non-transient batch reject: RPC is transactional (nothing applied).
                    // Peel one-by-one so an innocent head is not discarded for a sibling fault.
                    for (const op of batch) {
                        if (this.stopped || !(await this.settle(op, await this.push([op])))) {
                            return;
                        }
                    }
                    continue;
                }

                // An error covers the whole batch; settling the head is enough
                // to either stop (retry later) or reject the single op it was.
                for (const op of result.error ? batch.slice(0, 1) : batch) {
                    if (!(await this.settle(op, result))) {
                        return;
                    }
                }
            }
            this.backoffMs = INITIAL_BACKOFF_MS;
            this.setStatus('synced');
        } finally {
            this.flushing = false;
        }
    }

    /**
     * Resolve one op against the response that covered it: ack, reject +
     * repair, or (false) stop draining and retry later.
     */
    private async settle(op: PendingOp, result: PushResult): Promise<boolean> {
        if (result.error) {
            if (result.error.kind !== 'reject') {
                this.deferRetry(result.error);
                return false;
            }
            return this.reject(op, result.error.message);
        }
        if (result.updatedIds && !result.updatedIds.has(op.annotationId)) {
            return this.reject(op, 'the change matched no row this account may edit');
        }
        await this.ackOp(op);
        return true;
    }

    private async ackOp(op: PendingOp): Promise<void> {
        await this.deps.db.ops.delete(op.opId as number);
        if ((await this.queuedFor(op.annotationId)) === 0) {
            const createdBy = op.type === 'create' ? this.deps.getUserId() : null;
            await this.deps.store.markSynced(op.annotationId, createdBy);
        }
    }

    private queuedFor(annotationId: string): Promise<number> {
        const { db, docId } = this.deps;
        return db.ops
            .where('docId')
            .equals(docId)
            .filter((o) => o.annotationId === annotationId)
            .count();
    }

    /**
     * The server refused `op` for good. Fetch the row's server state FIRST —
     * if that fails the op stays queued (false) and the whole thing is retried,
     * so a refusal never costs the local copy without a server copy to adopt.
     * Then drop the op, repair local state, and tell the user.
     */
    private async reject(op: PendingOp, reason: string): Promise<boolean> {
        const { api, db, store, docId } = this.deps;
        const { data, error } = await this.withAuth(() => api.fetchOne(op.annotationId));
        if (error) {
            this.deferRetry(error.kind === 'reject' ? { ...error, kind: 'retry' } : error);
            return false;
        }
        if (this.stopped) {
            return false;
        }
        console.warn(`Sync op ${op.type} rejected for ${op.annotationId}: ${reason}`);
        if (data) {
            await db.ops.delete(op.opId as number);
            // Later ops for the row are still queued: they are the user's newer
            // intent and get their own verdict. Only adopt the server row when
            // nothing local is left to apply on top of it.
            if ((await this.queuedFor(op.annotationId)) === 0) {
                await store.adoptServerRow(fromServerRow(data));
            }
        } else {
            // No row this account can see: nothing queued for it can apply.
            await db.ops
                .where('docId')
                .equals(docId)
                .filter((o) => o.annotationId === op.annotationId)
                .delete();
            await store.discardLocal(op.annotationId);
        }
        this.deps.onRejected?.({ annotationId: op.annotationId, opType: op.type, reason });
        return true;
    }

    private async push(ops: PendingOp[]): Promise<PushResult> {
        const head = ops[0];
        if (!head) {
            return { error: null, updatedIds: null };
        }
        if (head.type === 'create') {
            const userId = this.deps.getUserId();
            if (!userId) {
                return { error: { message: 'not signed in', kind: 'retry' }, updatedIds: null };
            }
            const rows: AnnotationInsert[] = ops.map((op) => {
                const a = op.annotation;
                return {
                    id: a.id,
                    document_id: a.docId,
                    page: a.page,
                    kind: a.kind,
                    color: a.color,
                    payload: a.payload,
                    created_by: userId,
                    created_at: a.createdAt,
                    deleted_at: a.deletedAt,
                };
            });
            const { error } = await this.withAuth(() => this.deps.api.insertMany(rows));
            return { error, updatedIds: null };
        }

        const patches = ops.map((op): AnnotationPatchRow => {
            const a = op.annotation;
            switch (op.type) {
                case 'update':
                    // No deleted_at: an edit is not a statement about whether the
                    // mark exists. Sending the snapshot's `null` would undelete a
                    // mark a collaborator erased while this edit sat in the outbox.
                    return {
                        id: a.id,
                        document_id: op.docId,
                        color: a.color,
                        payload: a.payload,
                    };
                case 'delete':
                    return {
                        id: a.id,
                        document_id: op.docId,
                        deleted_at: a.deletedAt ?? new Date().toISOString(),
                    };
                case 'restore':
                    return {
                        id: a.id,
                        document_id: op.docId,
                        color: a.color,
                        payload: a.payload,
                        deleted_at: null,
                    };
                case 'create':
                    throw new Error('unreachable create in patch batch');
                default: {
                    const _exhaustive: never = op.type;
                    return _exhaustive;
                }
            }
        });
        const { error, updatedIds } = await this.withAuth(() => this.deps.api.updateMany(patches));
        return { error, updatedIds: updatedIds ? new Set(updatedIds) : null };
    }

    /** Apply one row fanned out via broadcast-from-database (M4). */
    async applyServerRow(row: AnnotationRow): Promise<void> {
        const { db, store, docId } = this.deps;
        if (row.document_id !== docId || this.stopped) {
            return;
        }
        const pendingIds = new Set((await db.ops.where('docId').equals(docId).toArray()).map((o) => o.annotationId));
        await store.applyRemoteBatch([fromServerRow(row)], pendingIds);
        const state = await db.syncState.get(docId);
        if (!state || row.seq > state.watermarkSeq) {
            await db.syncState.put({ docId, watermarkSeq: row.seq });
        }
    }

    async pullSince(): Promise<void> {
        if (this.pulling || this.stopped) {
            return;
        }
        this.pulling = true;
        try {
            const { db, api, store, docId } = this.deps;
            const state = await db.syncState.get(docId);
            let watermark = state?.watermarkSeq ?? 0;
            let after = Math.max(0, watermark - PULL_OVERLAP);

            for (;;) {
                const { data, error } = await this.withAuth(() => api.fetchSince(docId, after, PULL_PAGE_SIZE));
                if (error) {
                    if (error.kind === 'reject') {
                        this.setStatus('error');
                    } else {
                        this.deferRetry(error);
                    }
                    return;
                }
                const rows = data ?? [];
                if (rows.length === 0) {
                    break;
                }
                const pendingIds = new Set(
                    (await db.ops.where('docId').equals(docId).toArray()).map((o) => o.annotationId),
                );
                await store.applyRemoteBatch(rows.map(fromServerRow), pendingIds);
                const last = rows[rows.length - 1];
                if (last) {
                    watermark = Math.max(watermark, last.seq);
                    after = last.seq;
                }
                if (rows.length < PULL_PAGE_SIZE) {
                    break;
                }
            }
            await db.syncState.put({ docId, watermarkSeq: watermark });
        } finally {
            this.pulling = false;
        }
    }
}

/** Production AnnotationsApi backed by the shared Supabase client. */
export const createSupabaseAnnotationsApi = (supabase: TypedSupabaseClient): AnnotationsApi => {
    const fail = (error: { message: string } | null, status: number): ApiError | null =>
        error ? classifyFailure(error.message, status) : null;
    return {
        async insertIgnoreDuplicates(row) {
            const { error, status } = await supabase
                .from('annotations')
                .upsert(row, { onConflict: 'id', ignoreDuplicates: true });
            return { error: fail(error, status) };
        },
        async insertMany(rows) {
            if (rows.length === 0) {
                return { error: null };
            }
            if (rows.length === 1) {
                return this.insertIgnoreDuplicates(rows[0]!);
            }
            const { error, status } = await supabase.rpc('insert_annotations_batch', { p_rows: rows });
            return { error: fail(error, status) };
        },
        async update(id, docId, patch) {
            // .select('id') makes PostgREST return the rows it updated, so a
            // patch RLS filtered out shows up as an empty list, not a success.
            const { data, error, status } = await supabase
                .from('annotations')
                .update(patch)
                .eq('id', id)
                .eq('document_id', docId)
                .select('id');
            return { error: fail(error, status), updatedIds: error ? null : (data ?? []).map((row) => row.id) };
        },
        async updateMany(patches) {
            if (patches.length === 0) {
                return { error: null, updatedIds: [] };
            }
            if (patches.length === 1) {
                const { id, document_id, ...patch } = patches[0]!;
                return this.update(id, document_id, patch);
            }
            const { data, error, status } = await supabase.rpc('patch_annotations_batch', { p_patches: patches });
            return { error: fail(error, status), updatedIds: error ? null : (data ?? null) };
        },
        async fetchOne(id) {
            const { data, error, status } = await supabase.from('annotations').select('*').eq('id', id).maybeSingle();
            return { data, error: fail(error, status) };
        },
        async fetchSince(docId, afterSeq, limit) {
            const { data, error, status } = await supabase
                .from('annotations')
                .select('*')
                .eq('document_id', docId)
                .gt('seq', afterSeq)
                .order('seq', { ascending: true })
                .limit(limit);
            return { data, error: fail(error, status) };
        },
        async refreshAuth() {
            // The auth client serializes refreshes behind its own lock, so a
            // refresh already in flight from its timer is shared, not doubled.
            const { data, error } = await supabase.auth.refreshSession();
            return !error && data.session !== null;
        },
    };
};

/** Leading run of same op family (create vs mutate), capped at `limit`. */
const takeHomogeneousBatch = (ops: PendingOp[], limit: number): PendingOp[] => {
    const first = ops[0];
    if (!first) {
        return [];
    }
    const wantCreate = first.type === 'create';
    const batch: PendingOp[] = [];
    for (const op of ops) {
        if (batch.length >= limit) {
            break;
        }
        const isCreate = op.type === 'create';
        if (isCreate !== wantCreate) {
            break;
        }
        batch.push(op);
    }
    return batch;
};
