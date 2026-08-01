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

/**
 * The slice of the Supabase client the engine needs — injected so tests can
 * exercise the full offline→queue→flush→converge cycle with a fake.
 */
export interface AnnotationsApi {
    insertIgnoreDuplicates(row: AnnotationInsert): Promise<{ error: ApiError | null }>;
    update(id: string, docId: string, patch: AnnotationUpdate): Promise<{ error: ApiError | null }>;
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
        void this.sync();
    }

    stop(): void {
        this.stopped = true;
        this.deps.store.setDirtyHook(null);
        window.removeEventListener('online', this.onlineListener);
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
                const op = ops[0];
                if (!op) {
                    break;
                }
                this.setStatus('syncing');
                const error = await this.pushOp(op);
                if (error?.transient) {
                    this.setStatus(navigator.onLine === false ? 'offline' : 'error');
                    this.scheduleRetry();
                    return;
                }
                if (error) {
                    // Rejected (RLS/validation). Drop the op and repair from server truth.
                    console.warn(`Sync op ${op.type} rejected for ${op.annotationId}: ${error.message}`);
                    await db.ops.delete(op.opId as number);
                    await this.repair(op.annotationId);
                    continue;
                }
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
            this.backoffMs = 1000;
            this.setStatus('synced');
        } finally {
            this.flushing = false;
        }
    }

    private async pushOp(op: PendingOp): Promise<ApiError | null> {
        const { api } = this.deps;
        const a = op.annotation;
        switch (op.type) {
            case 'create': {
                const userId = this.deps.getUserId();
                if (!userId) {
                    return { message: 'not signed in', transient: true };
                }
                const { error } = await api.insertIgnoreDuplicates({
                    id: a.id,
                    document_id: a.docId,
                    page: a.page,
                    kind: a.kind,
                    color: a.color,
                    payload: a.payload,
                    created_by: userId,
                    created_at: a.createdAt,
                    deleted_at: a.deletedAt,
                });
                return error;
            }
            case 'update':
                return (
                    await api.update(a.id, op.docId, { color: a.color, payload: a.payload, deleted_at: a.deletedAt })
                ).error;
            case 'delete':
                return (await api.update(a.id, op.docId, { deleted_at: a.deletedAt ?? new Date().toISOString() }))
                    .error;
            case 'restore':
                return (await api.update(a.id, op.docId, { color: a.color, payload: a.payload, deleted_at: null }))
                    .error;
        }
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
        async update(id, docId, patch) {
            const { error, status } = await supabase
                .from('annotations')
                .update(patch)
                .eq('id', id)
                .eq('document_id', docId);
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
