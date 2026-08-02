import type { TypedSupabaseClient } from '@/lib/supabase';
import type { AnnotationStore } from '@/sync/annotationStore';
import type { PendingOp, ScribblerDb } from '@/sync/db';
import type { AnnotationInsert, AnnotationRow, AnnotationUpdate } from '@/types/database';
import type { Annotation } from '@/types/models';

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error';

/** Pull overlap window: covers the commit-visibility race where seq N commits
 * after N+1 was pulled while broadcast was down (plan §sync). */
const PULL_OVERLAP = 50;
const PULL_PAGE_SIZE = 500;
const MAX_BACKOFF_MS = 60_000;
/** Outbox ops drained per round-trip (creates / patches). */
const FLUSH_BATCH_SIZE = 40;

/**
 * The slice of the Supabase client the engine needs — injected so tests can
 * exercise the full offline→queue→flush→converge cycle with a fake.
 */
export interface AnnotationsApi {
    insertIgnoreDuplicates(row: AnnotationInsert): Promise<{ error: ApiError | null }>;
    /** Multi-row create; same semantics as insertIgnoreDuplicates per row. */
    insertMany(rows: AnnotationInsert[]): Promise<{ error: ApiError | null }>;
    update(id: string, docId: string, patch: AnnotationUpdate): Promise<{ error: ApiError | null }>;
    /** Multi-row patch; each entry is { id, document_id, ...AnnotationUpdate }. */
    updateMany(
        patches: Array<{ id: string; document_id: string } & AnnotationUpdate>,
    ): Promise<{ error: ApiError | null }>;
    fetchOne(id: string): Promise<{ data: AnnotationRow | null; error: ApiError | null }>;
    fetchSince(
        docId: string,
        afterSeq: number,
        limit: number,
    ): Promise<{ data: AnnotationRow[] | null; error: ApiError | null }>;
}

export interface ApiError {
    message: string;
    /** True for connectivity failures (retry); false for rejections (drop+repair). */
    transient: boolean;
}

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

/**
 * Drains the Dexie outbox to Supabase and pulls remote changes by watermark.
 * One instance per open cloud document. Local-first: the UI never waits on
 * this — it reacts to AnnotationStore, which this engine feeds via
 * applyRemoteBatch (plan §sync).
 */
export class SyncEngine {
    private flushing = false;
    private pulling = false;
    private stopped = false;
    private backoffMs = 1000;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
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
        },
    ) {}

    start(): void {
        this.deps.store.setDirtyHook(() => this.requestFlush());
        window.addEventListener('online', this.onlineListener);
        window.addEventListener('offline', this.offlineListener);
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
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
        }
    }

    /** Full cycle: pull remote changes, then push local ops. */
    async sync(): Promise<void> {
        await this.pullSince();
        await this.flush();
    }

    requestFlush(): void {
        queueMicrotask(() => void this.flush());
    }

    private onOnline(): void {
        this.backoffMs = 1000;
        void this.sync();
    }

    private setStatus(status: SyncStatus): void {
        if (this.status !== status) {
            this.status = status;
            this.deps.onStatus?.(status);
        }
    }

    private scheduleRetry(): void {
        if (this.stopped || this.retryTimer) {
            return;
        }
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.sync();
        }, this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }

    async flush(): Promise<void> {
        if (this.flushing || this.stopped) {
            return;
        }
        this.flushing = true;
        try {
            const { db, docId } = this.deps;
            for (;;) {
                const ops = await db.ops.where('docId').equals(docId).sortBy('opId');
                if (ops.length === 0) {
                    break;
                }
                this.setStatus('syncing');

                const batch = takeHomogeneousBatch(ops, FLUSH_BATCH_SIZE);
                let error = await this.pushBatch(batch);

                // Non-transient batch reject: RPC is transactional (nothing applied).
                // Peel one-by-one so an innocent head is not discarded for a sibling fault.
                if (error && !error.transient && batch.length > 1) {
                    for (const op of batch) {
                        const single = await this.pushBatch([op]);
                        if (single?.transient) {
                            this.setStatus(navigator.onLine === false ? 'offline' : 'error');
                            this.scheduleRetry();
                            return;
                        }
                        if (single) {
                            console.warn(`Sync op ${op.type} rejected for ${op.annotationId}: ${single.message}`);
                            await db.ops.delete(op.opId as number);
                            await this.repair(op.annotationId);
                            continue;
                        }
                        await this.ackOp(op);
                    }
                    continue;
                }

                if (error?.transient) {
                    this.setStatus(navigator.onLine === false ? 'offline' : 'error');
                    this.scheduleRetry();
                    return;
                }
                if (error) {
                    const head = batch[0]!;
                    console.warn(`Sync op ${head.type} rejected for ${head.annotationId}: ${error.message}`);
                    await db.ops.delete(head.opId as number);
                    await this.repair(head.annotationId);
                    continue;
                }

                for (const op of batch) {
                    await this.ackOp(op);
                }
            }
            this.backoffMs = 1000;
            this.setStatus('synced');
        } finally {
            this.flushing = false;
        }
    }

    private async ackOp(op: PendingOp): Promise<void> {
        const { db, docId } = this.deps;
        await db.ops.delete(op.opId as number);
        const remaining = await db.ops
            .where('docId')
            .equals(docId)
            .filter((o) => o.annotationId === op.annotationId)
            .count();
        if (remaining === 0) {
            const mirror = await db.annotations.get(op.annotationId);
            if (mirror) {
                await db.annotations.put({ ...mirror, pending: 0 });
            }
        }
    }

    private async pushBatch(ops: PendingOp[]): Promise<ApiError | null> {
        const head = ops[0];
        if (!head) {
            return null;
        }
        if (head.type === 'create') {
            const userId = this.deps.getUserId();
            if (!userId) {
                return { message: 'not signed in', transient: true };
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
            return (await this.deps.api.insertMany(rows)).error;
        }

        const patches = ops.map((op) => {
            const a = op.annotation;
            switch (op.type) {
                case 'update':
                    return {
                        id: a.id,
                        document_id: op.docId,
                        color: a.color,
                        payload: a.payload,
                        deleted_at: a.deletedAt,
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
        return (await this.deps.api.updateMany(patches)).error;
    }

    /** After a rejected op: adopt server truth for the annotation (or discard it). */
    private async repair(annotationId: string): Promise<void> {
        const { api, store } = this.deps;
        const { data, error } = await api.fetchOne(annotationId);
        if (error) {
            return; // transient — next sync cycle repairs
        }
        if (data) {
            await store.applyRemoteBatch([fromServerRow(data)], new Set());
        } else {
            await store.discardLocal(annotationId);
        }
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
                const { data, error } = await api.fetchSince(docId, after, PULL_PAGE_SIZE);
                if (error) {
                    this.setStatus(error.transient && navigator.onLine === false ? 'offline' : 'error');
                    if (error.transient) {
                        this.scheduleRetry();
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
    const classify = (message: string, status?: number): ApiError => ({
        message,
        // PostgREST/HTTP failures with no status (network) are transient.
        transient: status === undefined || status === 0 || status >= 500,
    });
    return {
        async insertIgnoreDuplicates(row) {
            const { error, status } = await supabase
                .from('annotations')
                .upsert(row, { onConflict: 'id', ignoreDuplicates: true });
            return { error: error ? classify(error.message, status) : null };
        },
        async insertMany(rows) {
            if (rows.length === 0) {
                return { error: null };
            }
            if (rows.length === 1) {
                return this.insertIgnoreDuplicates(rows[0]!);
            }
            const { error, status } = await supabase.rpc('insert_annotations_batch', { p_rows: rows });
            return { error: error ? classify(error.message, status) : null };
        },
        async update(id, docId, patch) {
            const { error, status } = await supabase
                .from('annotations')
                .update(patch)
                .eq('id', id)
                .eq('document_id', docId);
            return { error: error ? classify(error.message, status) : null };
        },
        async updateMany(patches) {
            if (patches.length === 0) {
                return { error: null };
            }
            if (patches.length === 1) {
                const p = patches[0]!;
                return this.update(p.id, p.document_id, {
                    color: p.color,
                    payload: p.payload,
                    deleted_at: p.deleted_at,
                });
            }
            const { error, status } = await supabase.rpc('patch_annotations_batch', { p_patches: patches });
            return { error: error ? classify(error.message, status) : null };
        },
        async fetchOne(id) {
            const { data, error, status } = await supabase.from('annotations').select('*').eq('id', id).maybeSingle();
            return { data, error: error ? classify(error.message, status) : null };
        },
        async fetchSince(docId, afterSeq, limit) {
            const { data, error, status } = await supabase
                .from('annotations')
                .select('*')
                .eq('document_id', docId)
                .gt('seq', afterSeq)
                .order('seq', { ascending: true })
                .limit(limit);
            return { data, error: error ? classify(error.message, status) : null };
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
