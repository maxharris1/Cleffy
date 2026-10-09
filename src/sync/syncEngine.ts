import { takeRetryAfterHint } from '@/lib/retryAfter';
import type { TypedSupabaseClient } from '@/lib/supabase';
import type { AnnotationStore } from '@/sync/annotationStore';
import type { PendingOp, PendingOpType, ScribblerDb } from '@/sync/db';
import type { AnnotationInsert, AnnotationRow, AnnotationUpdate } from '@/types/database';
import type { Annotation } from '@/types/models';

/**
 * - retrying: a transient failure (throttling, a server fault, a dropped
 *   request); the outbox is kept and retried with backoff. Nothing is wrong
 *   that waiting will not fix, so the viewer shows it calmly.
 * - error: the server refused for good (a pull it will never answer, an
 *   archived score holding the outbox), or retries have been failing for
 *   PERSISTENT_FAILURE_MS — long enough that the user should know.
 */
export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'retrying' | 'error';

/** Pull overlap window: covers the commit-visibility race where seq N commits
 * after N+1 was pulled while broadcast was down (plan §sync). */
const PULL_OVERLAP = 50;
const PULL_PAGE_SIZE = 500;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
/** Outbox ops drained per round-trip (creates / patches). */
const FLUSH_BATCH_SIZE = 40;
/** Marks checked against the server per reconcile round-trip (see reconcile). */
const RECONCILE_BATCH_SIZE = 100;
/** Retryable failures this long in a row stop being "retrying" and become an error. */
export const PERSISTENT_FAILURE_MS = 3 * 60_000;

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
    /** Current server rows for these ids in one document (missing = not visible / gone). */
    fetchMany(docId: string, ids: string[]): Promise<{ data: AnnotationRow[] | null; error: ApiError | null }>;
    /**
     * Whether the document is archived (read-only past the plan's score cap).
     * False when it is not, or when this account can no longer see it at all.
     */
    fetchDocumentArchived(docId: string): Promise<{ archived: boolean; error: ApiError | null }>;
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
 * The outbox is refused because the score is archived (a lapsed plan), and is
 * being kept rather than dropped: an archive is undone by resubscribing, and
 * the marks then upload as if nothing happened.
 */
export interface SyncHold {
    reason: 'archived';
    /** Distinct marks with changes waiting on this document. */
    pendingMarks: number;
}

/** A refused op left in the outbox (see the engine's onRefusalHeld). */
export interface HeldRefusal {
    opId: number;
    annotationId: string;
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

type RejectionObserver = (rejection: SyncRejection & { docId: string }) => void;
const rejectionObservers = new Set<RejectionObserver>();

/**
 * Hear about every refusal from every engine (the open viewer's and headless
 * ones alike) until the returned function is called. Sign-out uses this so a
 * change refused while it drains is reported, not just logged.
 */
export const observeRejections = (observer: RejectionObserver): (() => void) => {
    rejectionObservers.add(observer);
    return () => {
        rejectionObservers.delete(observer);
    };
};

/**
 * Rows an engine rewrote in the Dexie mirror from server truth: reconcile
 * adopted the server's row, or a refusal rolled a change back. Every engine
 * renders through its own AnnotationStore, so without this the open viewer —
 * in another tab, or in this one when the background drain reached the score
 * first — keeps drawing the copy it loaded and calls it synced.
 */
interface MirrorRepair {
    /** The Dexie database the rows live in; another one is not this device's mirror. */
    db: string;
    docId: string;
    annotationIds: string[];
    /** Set when the repair rolled back a refused change, so the viewer can say so. */
    rejection?: SyncRejection;
    /** The engine that made it, which has already applied it. */
    origin: string;
}

const SYNC_CHANNEL_NAME = 'cleffy-sync';
const repairListeners = new Set<(repair: MirrorRepair) => void>();
let syncChannel: BroadcastChannel | null | undefined;

const deliverRepair = (repair: MirrorRepair): void => {
    for (const listener of [...repairListeners]) {
        listener(repair);
    }
};

/** This tab's end of the cross-tab channel, opened on first use (null where unsupported). */
const getSyncChannel = (): BroadcastChannel | null => {
    if (syncChannel !== undefined) {
        return syncChannel;
    }
    syncChannel = null;
    if (typeof BroadcastChannel !== 'undefined') {
        try {
            const channel = new BroadcastChannel(SYNC_CHANNEL_NAME);
            channel.onmessage = (event: MessageEvent<MirrorRepair>) => deliverRepair(event.data);
            // Node (tests) would otherwise keep the process alive for it.
            (channel as { unref?: () => void }).unref?.();
            syncChannel = channel;
        } catch {
            // No cross-tab delivery; this tab's engines still hear each other.
        }
    }
    return syncChannel;
};

/** Tell every other engine on the document — this tab's and other tabs' — to re-read these rows. */
const announceRepair = (repair: MirrorRepair): void => {
    deliverRepair(repair);
    try {
        getSyncChannel()?.postMessage(repair);
    } catch {
        // Best effort: the next pull covers another tab that missed it.
    }
};

const VIEWER_LOCK_PREFIX = 'cleffy-viewer:';

/**
 * Scores open in a viewer in any tab of this browser. Each started engine
 * holds a shared Web Lock for its document while it runs, so the background
 * drain can leave those to their viewers. Empty where Web Locks are missing.
 */
export const docsOpenInViewers = async (): Promise<Set<string>> => {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks || typeof locks.query !== 'function') {
        return new Set();
    }
    try {
        const { held = [] } = await locks.query();
        return new Set(
            held
                .map((lock) => lock.name ?? '')
                .filter((name) => name.startsWith(VIEWER_LOCK_PREFIX))
                .map((name) => name.slice(VIEWER_LOCK_PREFIX.length)),
        );
    } catch {
        return new Set();
    }
};

/** In-tab fallback for withOutboxLock where the Web Locks API is missing. */
const outboxLockTails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding the document's outbox. One document's outbox can be
 * drained by more than one engine — the open viewer's, the background drain's,
 * sign-out's, another tab's — and reconcile rewrites queued ops, which is only
 * safe while nothing else is pushing them. Web Locks serialize across tabs;
 * without them (older browsers, tests) a promise chain serializes this tab.
 * The lock is held for one drain pass only, never across a backoff wait.
 */
const withOutboxLock = async <T>(docId: string, fn: () => Promise<T>): Promise<T> => {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks && typeof locks.request === 'function') {
        return locks.request(`cleffy-outbox:${docId}`, fn) as Promise<T>;
    }
    const prev = outboxLockTails.get(docId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    outboxLockTails.set(docId, tail);
    try {
        return await run;
    } finally {
        if (outboxLockTails.get(docId) === tail) {
            outboxLockTails.delete(docId);
        }
    }
};

const sameInstant = (a: string | null | undefined, b: string | null | undefined): boolean =>
    !!a && !!b && Date.parse(a) === Date.parse(b);

/** One mark's queued ops, oldest first. */
interface OpGroup {
    annotationId: string;
    ops: PendingOp[];
}

/**
 * Marks whose queued ops must be checked against the server row before any is
 * sent (at most `limit`):
 *  - two or more ops: they collapse to their net effect, so an undo/redo pair
 *    made offline sends nothing instead of replaying both halves;
 *  - any restore: a restore must not resurrect a mark someone erased again
 *    after the tombstone it undoes.
 * Groups headed by a create are left alone — the row is not on the server yet
 * (or a lost response hides that it is, and an insert of a folded snapshot
 * would be ignored as a duplicate), so they replay op by op as before. So is a
 * group with a create further in (a delete + re-create under the same id),
 * whose page or kind may differ and cannot be patched.
 */
export const groupsToReconcile = (ops: PendingOp[], verified: ReadonlySet<number>, limit: number): OpGroup[] => {
    const groups = new Map<string, PendingOp[]>();
    for (const op of ops) {
        const group = groups.get(op.annotationId);
        if (group) {
            group.push(op);
        } else {
            groups.set(op.annotationId, [op]);
        }
    }
    const out: OpGroup[] = [];
    for (const [annotationId, group] of groups) {
        if (out.length >= limit) {
            break;
        }
        if (group.some((op) => op.type === 'create')) {
            continue;
        }
        if (group.length < 2 && !group.some((op) => op.type === 'restore')) {
            continue;
        }
        if (group.every((op) => verified.has(op.opId as number))) {
            continue;
        }
        out.push({ annotationId, ops: group });
    }
    return out;
};

/** What to do with a mark's queued ops once its server row is known. */
export type Reconciled =
    /** Replace them with this one op. */
    | { kind: 'send'; op: PendingOp }
    /** Send them as queued, one by one. */
    | { kind: 'keep' }
    /** Send nothing: the server already holds the outcome, or a newer change there wins. Adopt its row. */
    | { kind: 'adopt' };

/**
 * Collapse one mark's queued ops (no create among them) to a single op that
 * takes the server row as it is NOW to the state the user left the mark in —
 * or to nothing at all. Judged against the server rather than against what
 * the device last saw because either may have moved: a collaborator's edit,
 * or one of these very ops that landed although its response was lost.
 *
 * Tombstones are told apart by deleted_at, which the client sends and the
 * server keeps verbatim: a server row deleted at an instant one of these ops
 * (or the tombstone a restore undoes) carries is this device's own delete; any
 * other instant is a collaborator's, made after the tombstone the restore
 * undoes, and wins over the restore — undo/redo replays the user's history, it
 * does not get to erase someone else's. It does not win over an edit made
 * after the restore, though: the user brought the mark back and went on
 * working on it, and device clocks cannot say whether that came before or
 * after the other delete. Those ops are sent as queued, and the user's
 * version stands, rather than the edit being dropped without a word.
 */
export const reconcileWithServer = (ops: PendingOp[], server: AnnotationRow): Reconciled => {
    const first = ops[0];
    const last = ops[ops.length - 1];
    if (!first || !last) {
        return { kind: 'adopt' };
    }
    const finalLive = !last.annotation.deletedAt;
    const serverLive = server.deleted_at === null;
    const net = (type: PendingOpType, extra: Partial<PendingOp> = {}): Reconciled => ({
        kind: 'send',
        op: {
            opId: first.opId,
            docId: first.docId,
            annotationId: first.annotationId,
            queuedAt: first.queuedAt,
            type,
            annotation: last.annotation,
            ...(last.userId !== undefined ? { userId: last.userId } : {}),
            ...extra,
        },
    });
    if (!finalLive) {
        // Already erased on the server (by anyone): nothing left to say.
        return serverLive ? net('delete') : { kind: 'adopt' };
    }
    if (serverLive) {
        // Only edits change what a live mark looks like; a delete + restore
        // pair, or a restore someone else already made, leaves nothing to send.
        return ops.some((op) => op.type === 'update') ? net('update') : { kind: 'adopt' };
    }
    const ours =
        ops.some((op) => op.type === 'delete' && sameInstant(op.annotation.deletedAt, server.deleted_at)) ||
        (first.type === 'restore' &&
            // Queued by a build that did not record the tombstone: restore, as it always did.
            (first.baseDeletedAt === undefined || sameInstant(first.baseDeletedAt, server.deleted_at)));
    if (ours) {
        return net('restore', { baseDeletedAt: server.deleted_at });
    }
    const restoredAt = ops.findIndex((op) => op.type === 'restore');
    const editedAfterRestore = restoredAt >= 0 && ops.slice(restoredAt + 1).some((op) => op.type === 'update');
    return editedAfterRestore ? { kind: 'keep' } : { kind: 'adopt' };
};

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
    /** When the current run of retryable failures began; null while healthy. */
    private failingSince: number | null = null;
    /**
     * How the last pull ended. A flush that empties the outbox says "synced"
     * only after a pull that worked: with the pull failing (offline, or the
     * server down) this device has not heard what changed elsewhere.
     */
    private lastPullError: ApiError | null = null;
    /**
     * Ops reconcile already checked against the server during this flush, so
     * a mark it decided to send is pushed rather than checked again. Cleared
     * per flush: a later flush re-checks, since the server may have moved.
     */
    private reconciled = new Set<number>();
    /** Names this engine in the repairs it announces, so it skips its own. */
    private readonly engineId = crypto.randomUUID();
    private releaseViewerLock: (() => void) | null = null;
    private repairListener = (repair: MirrorRepair) => this.onRepair(repair);

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
            /** The outbox is refused but kept (archived score) — see SyncHold. */
            onHeld?: (hold: SyncHold) => void;
            /**
             * Set by a driver nobody is watching (the background drain). A
             * refusal then changes nothing: the op and everything queued
             * after it stay, no mark is rolled back, the pass stops, and the
             * refused op is reported here. Rolled back where no one sees it,
             * the marks would just vanish; left queued, they meet the refusal
             * again in the score's viewer or at sign-out, which say so.
             */
            onRefusalHeld?: (refusal: HeldRefusal) => void;
        },
    ) {}

    start(): void {
        this.deps.store.setDirtyHook(() => this.requestFlush());
        window.addEventListener('online', this.onlineListener);
        window.addEventListener('offline', this.offlineListener);
        activeEngines.set(this.deps.docId, this);
        repairListeners.add(this.repairListener);
        getSyncChannel();
        this.holdViewerLock();
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
        repairListeners.delete(this.repairListener);
        this.releaseViewerLock?.();
        this.releaseViewerLock = null;
        this.clearRetry();
    }

    /** See docsOpenInViewers. Released by stop(). */
    private holdViewerLock(): void {
        const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
        if (!locks || typeof locks.request !== 'function') {
            return;
        }
        void locks
            .request(
                `${VIEWER_LOCK_PREFIX}${this.deps.docId}`,
                { mode: 'shared' },
                () =>
                    new Promise<void>((resolve) => {
                        if (this.stopped) {
                            resolve();
                        } else {
                            this.releaseViewerLock = resolve;
                        }
                    }),
            )
            .catch(() => undefined);
    }

    /**
     * Another engine repaired rows of this document in the mirror (see
     * MirrorRepair): draw them as they now are, and pass a refusal on to the
     * viewer, which is the one that can tell the user.
     */
    private onRepair(repair: MirrorRepair): void {
        const { db, store, docId } = this.deps;
        if (this.stopped || repair.origin === this.engineId || repair.docId !== docId || repair.db !== db.name) {
            return;
        }
        void store
            .reloadFromMirror(repair.annotationIds)
            .then(() => {
                if (repair.rejection && !this.stopped) {
                    this.deps.onRejected?.(repair.rejection);
                }
            })
            .catch((err: unknown) => console.warn('Could not reload repaired marks', err));
    }

    private announce(annotationIds: string[], rejection?: SyncRejection): void {
        if (annotationIds.length === 0) {
            return;
        }
        announceRepair({
            db: this.deps.db.name,
            docId: this.deps.docId,
            annotationIds,
            ...(rejection ? { rejection } : {}),
            origin: this.engineId,
        });
    }

    /** Delay of the currently scheduled retry (ms), or null when none is pending. */
    get pendingRetryDelayMs(): number | null {
        return this.retryTimer ? this.lastRetryDelay : null;
    }

    /**
     * For a driver that schedules its own retries (the background drain):
     * cancel the retry this engine scheduled and return its delay, keeping the
     * backoff it was computed from so the next failure waits longer still.
     */
    takeScheduledRetry(): number | null {
        const delay = this.pendingRetryDelayMs;
        this.clearRetry();
        return delay;
    }

    /** The network is back: retry at the shortest delay again. */
    resetBackoff(): void {
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.failingSince = null;
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
        this.resetBackoff();
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
        this.failingSince ??= Date.now();
        this.setStatus(this.failureStatus());
        this.scheduleRetry(error.retryAfterMs);
    }

    /**
     * What a retryable failure looks like to the user: offline when the
     * browser says so, a calm "retrying" through ordinary throttling and
     * blips, and an error only once it has gone on for PERSISTENT_FAILURE_MS.
     */
    private failureStatus(): SyncStatus {
        if (navigator.onLine === false) {
            return 'offline';
        }
        const since = this.failingSince ?? Date.now();
        return Date.now() - since >= PERSISTENT_FAILURE_MS ? 'error' : 'retrying';
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
            await withOutboxLock(this.deps.docId, () => this.drain());
        } finally {
            this.flushing = false;
        }
    }

    /** One pass over the outbox, under the document's outbox lock. */
    private async drain(): Promise<void> {
        const { db, docId } = this.deps;
        this.reconciled = new Set();
        for (;;) {
            if (this.stopped) {
                return;
            }
            const ops = await db.ops.where('docId').equals(docId).sortBy('opId');
            if (ops.length === 0) {
                break;
            }
            this.setStatus('syncing');

            const groups = groupsToReconcile(ops, this.reconciled, RECONCILE_BATCH_SIZE);
            if (groups.length > 0) {
                if (!(await this.reconcile(groups))) {
                    return;
                }
                continue;
            }

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

            if (result.error) {
                // An error covers the whole batch; settling the head is enough
                // to either stop (retry later) or reject the single op it was.
                const head = batch[0];
                if (head && !(await this.settle(head, result))) {
                    return;
                }
                continue;
            }

            // The server applied the batch. Ack everything it reports as
            // updated BEFORE repairing the ids it missed: a repair whose
            // fetch fails stops the drain, and an applied op left queued
            // behind it would be pushed again on retry — re-sending an
            // update over a collaborator's newer edit, or a restore over
            // their delete.
            const missed: PendingOp[] = [];
            for (const op of batch) {
                if (result.updatedIds && !result.updatedIds.has(op.annotationId)) {
                    missed.push(op);
                } else {
                    await this.ackOp(op);
                }
            }
            for (const op of missed) {
                if (!(await this.reject(op, 'the change matched no row this account may edit'))) {
                    return;
                }
            }
        }
        // The outbox is empty. Healthy only if the pull that came with it
        // worked too: a failed pull means changes made elsewhere have not
        // arrived, which is not "synced", and the retry it scheduled keeps
        // its backoff rather than starting over at the shortest delay.
        if (navigator.onLine === false) {
            this.setStatus('offline');
            return;
        }
        if (this.lastPullError) {
            this.setStatus(this.lastPullError.kind === 'reject' ? 'error' : this.failureStatus());
            return;
        }
        this.backoffMs = INITIAL_BACKOFF_MS;
        this.failingSince = null;
        this.setStatus('synced');
    }

    /**
     * Check marks with several queued ops, or a restore, against their server
     * rows and rewrite their ops to the net change (see reconcileWithServer).
     * False when the rows could not be read: the ops stay exactly as queued
     * and the whole pass is retried, so nothing is sent on a guess.
     */
    private async reconcile(groups: OpGroup[]): Promise<boolean> {
        const { api, docId } = this.deps;
        const { data, error } = await this.withAuth(() =>
            api.fetchMany(
                docId,
                groups.map((g) => g.annotationId),
            ),
        );
        if (error) {
            // A refused read says nothing about the ops; keep them and retry.
            this.deferRetry(error.kind === 'reject' ? { ...error, kind: 'retry' } : error);
            return false;
        }
        if (this.stopped) {
            return false;
        }
        const rows = new Map((data ?? []).map((row) => [row.id, row]));
        const adopted: string[] = [];
        try {
            for (const group of groups) {
                if (!(await this.reconcileGroup(group, rows.get(group.annotationId), adopted))) {
                    return false;
                }
            }
        } finally {
            this.announce(adopted);
        }
        return true;
    }

    /** reconcile for one mark; false once the engine has been stopped. */
    private async reconcileGroup(group: OpGroup, row: AnnotationRow | undefined, adopted: string[]): Promise<boolean> {
        const { db, store } = this.deps;
        const opIds = group.ops.map((op) => op.opId as number);
        if (!row) {
            // Not visible (or gone): send the ops as queued, and the
            // refusal path repairs from what the server says about each.
            opIds.forEach((id) => this.reconciled.add(id));
            return true;
        }
        const outcome = reconcileWithServer(group.ops, row);
        if (outcome.kind === 'keep') {
            opIds.forEach((id) => this.reconciled.add(id));
            return true;
        }
        const applied = await db.transaction('rw', db.ops, async () => {
            // Another tab may have drained (or rewritten) these meanwhile.
            const current = await db.ops.bulkGet(opIds);
            if (current.some((op) => !op)) {
                return false;
            }
            if (outcome.kind === 'send') {
                await db.ops.bulkDelete(opIds.slice(1));
                await db.ops.put(outcome.op);
            } else {
                await db.ops.bulkDelete(opIds);
            }
            return true;
        });
        if (this.stopped) {
            return false;
        }
        if (!applied) {
            return true;
        }
        if (outcome.kind === 'send') {
            this.reconciled.add(outcome.op.opId as number);
        } else if ((await this.queuedFor(group.annotationId)) === 0) {
            // Nothing to send: the server's row is how the mark stands.
            // Pulls skipped it while ops were queued, so adopt it here.
            await store.adoptServerRow(fromServerRow(row));
            adopted.push(group.annotationId);
        }
        return true;
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
     *
     * Except on an archived score. RLS refuses every write there, but the
     * archive is a billing state the owner undoes by resubscribing — and marks
     * drawn offline before the archive landed would otherwise be discarded
     * for good, a whole lesson's work lost to a failed card. Those ops are kept
     * and the drain stops (false) until the score is writable again.
     *
     * And except in a headless engine that holds refusals (onRefusalHeld):
     * the op is kept for an engine whose refusal someone will see.
     */
    private async reject(op: PendingOp, reason: string): Promise<boolean> {
        const { api, db, store, docId } = this.deps;
        const archive = await this.withAuth(() => api.fetchDocumentArchived(docId));
        if (archive.error) {
            this.deferRetry(archive.error.kind === 'reject' ? { ...archive.error, kind: 'retry' } : archive.error);
            return false;
        }
        if (archive.archived) {
            await this.holdForArchive();
            return false;
        }
        if (this.deps.onRefusalHeld) {
            if (!this.stopped) {
                console.warn(`Sync op ${op.type} refused for ${op.annotationId}, kept for the viewer: ${reason}`);
                this.deps.onRefusalHeld({ opId: op.opId as number, annotationId: op.annotationId, reason });
            }
            return false;
        }
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
        const rejection: SyncRejection = { annotationId: op.annotationId, opType: op.type, reason };
        this.announce([op.annotationId], rejection);
        this.deps.onRejected?.(rejection);
        for (const observer of rejectionObservers) {
            observer({ ...rejection, docId });
        }
        return true;
    }

    /**
     * Keep the outbox of an archived score and say so. Retried at the slowest
     * backoff: nothing changes until the plan does, but when it does (a
     * resubscribe in another tab) the marks should upload without a reload.
     */
    private async holdForArchive(): Promise<void> {
        if (this.stopped) {
            return;
        }
        const { db, docId } = this.deps;
        const queued = await db.ops.where('docId').equals(docId).toArray();
        this.setStatus('error');
        this.deps.onHeld?.({ reason: 'archived', pendingMarks: new Set(queued.map((o) => o.annotationId)).size });
        this.scheduleRetry(MAX_BACKOFF_MS);
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
        // Re-checked after every await: stop() may have come in meanwhile
        // because this account lost the score, and the caller is purging its
        // local copy — nothing may be written back over that.
        if (this.stopped) {
            return;
        }
        await store.applyRemoteBatch([fromServerRow(row)], pendingIds);
        const state = await db.syncState.get(docId);
        if (this.stopped) {
            return;
        }
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
                // stop() can land during any await below (the account lost
                // the score and its local copy is being purged): a pull that
                // was already in flight must not write rows or a watermark
                // back afterwards.
                if (this.stopped) {
                    return;
                }
                if (error) {
                    this.lastPullError = error;
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
                if (this.stopped) {
                    return;
                }
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
            if (this.stopped) {
                return;
            }
            await db.syncState.put({ docId, watermarkSeq: watermark });
            this.lastPullError = null;
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
        async fetchMany(docId, ids) {
            if (ids.length === 0) {
                return { data: [], error: null };
            }
            const { data, error, status } = await supabase
                .from('annotations')
                .select('*')
                .eq('document_id', docId)
                .in('id', ids);
            return { data, error: fail(error, status) };
        },
        async fetchDocumentArchived(docId) {
            const { data, error, status } = await supabase
                .from('documents')
                .select('archived_at')
                .eq('id', docId)
                .maybeSingle();
            return { archived: !error && data !== null && data.archived_at !== null, error: fail(error, status) };
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
