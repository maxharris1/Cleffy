import { ensureDayStartingSnapshot } from '@/features/viewer/history/snapshotService';
import { UndoStack, type UndoableOp, type UndoBatchHandle } from '@/features/viewer/ink/undoStack';
import type { LocalAnnotation, PendingOp, ScribblerDb } from '@/sync/db';
import { foreignMarkIds } from '@/sync/opOwnership';
import type { Annotation, AnnotationPayload } from '@/types/models';

export type PageListener = (pageIndex: number) => void;

export interface AnnotationPatch {
    color?: string;
    payload?: AnnotationPayload;
}

/**
 * Every store with edits it could not write (see `failedPersist`), so sign-out
 * and export, which read Dexie, can still account for marks that exist only in
 * a viewer's memory.
 */
const storesWithFailures = new Set<AnnotationStore>();

/** Marks, across open scores, whose latest edit is not on this device (see AnnotationStore.hasPersistFailure). */
export const unsavedMarkCount = (): number => {
    let count = 0;
    for (const store of storesWithFailures) {
        count += store.persistFailureCount;
    }
    return count;
};

/**
 * The in-memory versions of `docId`'s marks that could not be written —
 * tombstones included, so an erase that failed to save still leaves the mark
 * out. Export lays them over the mirror's rows.
 */
export const unsavedMarksFor = (docId: string): Annotation[] =>
    [...storesWithFailures].filter((store) => store.docId === docId).flatMap((store) => store.unsavedAnnotations());

/**
 * For an edit nobody awaits (a pen-up, an eraser pass): a write that fails is
 * already flagged (hasPersistFailure) and shown by the viewer's "couldn't be
 * saved" banner, so it must not also surface as an unhandled rejection.
 */
export const settleEdit = (edit: Promise<unknown>): void => {
    void edit.catch((err: unknown) => console.warn('Could not save a mark on this device', err));
};

type CommitOp =
    | { type: 'create'; annotation: Annotation }
    | { type: 'update'; annotation: Annotation; prev: Annotation }
    | { type: 'delete'; annotation: Annotation }
    /** baseDeletedAt: the tombstone being undone — see PendingOp.baseDeletedAt. */
    | { type: 'restore'; annotation: Annotation; baseDeletedAt: string | null };

/**
 * THE single write path for annotations (plan §sync).
 *
 * Owns the in-memory per-page Map that is the sole render/hit-test source.
 * Every mutation — draw, erase, edit, undo, redo — flows through commit():
 * one Dexie transaction writes the mirror row and enqueues the outbox op,
 * the undo stack records the inverse, then page listeners repaint.
 * Dexie is a write-behind mirror hydrated once per document; Supabase results
 * enter only via applyRemote (M4). The UI store (zustand) never holds
 * annotation data.
 */
export class AnnotationStore {
    private pages = new Map<number, Map<string, Annotation>>();
    /** All rows incl. tombstones, by id — needed for undo-restore + LWW merge. */
    private byId = new Map<string, Annotation>();
    /** When set, getPage returns this instead of live state (lesson history view). */
    private historyOverlay: Map<number, Map<string, Annotation>> | null = null;
    private overlayKind: 'history' | 'preview' = 'history';
    private listeners = new Set<PageListener>();
    private metaListeners = new Set<() => void>();
    private undo = new UndoStack();
    private onDirty: ((ids: readonly string[]) => void) | null = null;
    private author: string | null = null;
    /**
     * Marks with changes another account queued on this device (see
     * opOwnerFor), e.g. offline before its session expired. Their mirror rows
     * hold that account's unsynced version, which is not this account's to
     * see, edit or carry into its history: they are left out of memory
     * altogether, and left alone in Dexie, until that account uploads them or
     * a sign-out clears them. Decided on hydration and again whenever the
     * author changes (ownership), since a warm open can paint before the
     * session resolves.
     */
    private foreign = new Set<string>();
    private ownership: Promise<void> = Promise.resolve();
    private loading: Promise<void> | null = null;
    private loaded = false;
    /**
     * Local edits applied to memory whose mirror write has not finished, by
     * id. reloadFromMirror must not replace them with the older row Dexie
     * still holds.
     */
    private unpersisted = new Map<string, number>();
    /**
     * Edits of an existing mark that commit() has begun but not yet drawn,
     * by id: they wait for the day snapshot before they apply (see commit).
     * The user has already asked for them, so they count as unsaved too
     * (see hasUnsavedEdit).
     */
    private committing = new Map<string, number>();
    /** whenSaved callers, by id, released once the mark has nothing in `committing` or `unpersisted`. */
    private savedWaiters = new Map<string, Array<() => void>>();
    /**
     * Local edits whose mirror + outbox write threw (IndexedDB over quota, a
     * closed or blocked database), oldest first. They are applied in memory —
     * drawn, exported (unsavedMarksFor), counted at sign-out — and nowhere
     * else, so they are held here for retryFailedPersist. A later edit of one
     * of these marks joins them unwritten, so the outbox never holds a mark's
     * newer op without the older one it builds on.
     */
    private failedOps: CommitOp[] = [];
    /** The marks in `failedOps` (see hasPersistFailure). */
    private failedPersist = new Set<string>();
    private retrying: Promise<boolean> | null = null;

    constructor(
        private db: ScribblerDb,
        readonly docId: string,
    ) {}

    /**
     * Hydrate the in-memory map from the Dexie mirror. Idempotent: every caller
     * (the viewport, the sync engine, a remote apply) shares one read.
     *
     * The read is async, and the viewport opens the document and starts the
     * sync engine in the same tick. Hydration therefore MERGES instead of
     * replacing: a row already in memory was put there after the read began —
     * a stroke drawn while the mirror was still loading — and is newer than
     * what the read returned. Remote rows never race it: applyRemoteBatch,
     * adoptServerRow and discardLocal wait for hydration first, so their LWW
     * checks see the mirror's seq rather than an empty map (which used to let
     * a pull-overlap row older than the mirror overwrite it in Dexie).
     */
    load(): Promise<void> {
        if (!this.loading) {
            this.loading = this.hydrate().catch((err: unknown) => {
                // Let the next caller try again instead of caching the failure.
                this.loading = null;
                throw err;
            });
        }
        return this.loading;
    }

    private async hydrate(): Promise<void> {
        const [rows, foreign] = await Promise.all([
            this.db.annotations.where('docId').equals(this.docId).toArray(),
            this.foreignIds(),
        ]);
        this.foreign = foreign;
        const touched = new Set<number>();
        for (const row of rows) {
            if (this.byId.has(row.id) || foreign.has(row.id)) {
                continue;
            }
            const { pending: _pending, ...annotation } = row;
            this.byId.set(annotation.id, annotation);
            if (!annotation.deletedAt) {
                this.pageMap(annotation.page).set(annotation.id, annotation);
                touched.add(annotation.page);
            }
        }
        this.loaded = true;
        for (const page of touched) {
            this.notifyPage(page);
        }
        this.notifyMeta();
    }

    /** Resolve once the mirror is in memory; no extra yield once it is. */
    private async ensureLoaded(): Promise<void> {
        if (!this.loaded) {
            await this.load();
        }
    }

    /** Live (non-deleted) annotations on a page. Do not mutate. */
    getPage(pageIndex: number): ReadonlyMap<string, Annotation> {
        if (this.historyOverlay) {
            return this.historyOverlay.get(pageIndex) ?? EMPTY_PAGE;
        }
        return this.pages.get(pageIndex) ?? EMPTY_PAGE;
    }

    get(id: string): Annotation | undefined {
        if (this.historyOverlay) {
            for (const page of this.historyOverlay.values()) {
                const hit = page.get(id);
                if (hit) {
                    return hit;
                }
            }
            return undefined;
        }
        return this.byId.get(id);
    }

    get isHistoryMode(): boolean {
        return this.historyOverlay !== null;
    }

    /** Which UI owns the overlay — 'history' (day snapshot) or 'preview' (import review); null when live. */
    get overlayMode(): 'history' | 'preview' | null {
        return this.historyOverlay ? this.overlayKind : null;
    }

    /** Show a set of annotations read-only in place of the live ones (null clears). */
    setHistoryOverlay(annotations: Annotation[] | null, kind: 'history' | 'preview' = 'history'): void {
        this.overlayKind = kind;
        const touched = new Set<number>([...this.pages.keys()]);
        if (this.historyOverlay) {
            for (const page of this.historyOverlay.keys()) {
                touched.add(page);
            }
        }
        if (!annotations) {
            this.historyOverlay = null;
        } else {
            const overlay = new Map<number, Map<string, Annotation>>();
            for (const annotation of annotations) {
                if (annotation.deletedAt) {
                    continue;
                }
                let map = overlay.get(annotation.page);
                if (!map) {
                    map = new Map();
                    overlay.set(annotation.page, map);
                }
                map.set(annotation.id, annotation);
                touched.add(annotation.page);
            }
            this.historyOverlay = overlay;
        }
        for (const page of touched) {
            this.notifyPage(page);
        }
        this.notifyMeta();
    }

    /** All currently live annotations (ignores history overlay). */
    liveAnnotations(): Annotation[] {
        const out: Annotation[] = [];
        for (const annotation of this.byId.values()) {
            if (!annotation.deletedAt) {
                out.push(annotation);
            }
        }
        return out;
    }

    /**
     * Replace live annotations with a day's starting point (editors only).
     * Soft-deletes anything not in the snapshot; creates/updates/restores the rest.
     */
    async restoreFromSnapshot(snapshot: Annotation[]): Promise<void> {
        if (this.historyOverlay) {
            this.setHistoryOverlay(null);
        }
        const snapById = new Map(snapshot.filter((a) => !a.deletedAt).map((a) => [a.id, a]));
        const batch = this.beginBatch();
        try {
            for (const live of this.liveAnnotations()) {
                if (!snapById.has(live.id)) {
                    await this.delete(live.id);
                }
            }
            const now = nowIso();
            for (const snap of snapById.values()) {
                const existing = this.byId.get(snap.id);
                const next: Annotation = {
                    ...snap,
                    docId: this.docId,
                    updatedAt: now,
                    deletedAt: null,
                };
                if (!existing) {
                    await this.create({ ...next, createdAt: snap.createdAt || now, seq: 0 });
                } else if (existing.deletedAt) {
                    await this.commit(
                        {
                            type: 'restore',
                            annotation: { ...next, seq: existing.seq },
                            baseDeletedAt: existing.deletedAt,
                        },
                        { recordUndo: true },
                    );
                    // After restore, payload/color may still differ — update if needed.
                    const restored = this.byId.get(snap.id);
                    if (
                        restored &&
                        (restored.color !== next.color ||
                            JSON.stringify(restored.payload) !== JSON.stringify(next.payload) ||
                            restored.page !== next.page ||
                            restored.kind !== next.kind)
                    ) {
                        await this.update(snap.id, { color: next.color, payload: next.payload });
                    }
                } else if (
                    existing.color !== next.color ||
                    JSON.stringify(existing.payload) !== JSON.stringify(next.payload) ||
                    existing.page !== next.page ||
                    existing.kind !== next.kind
                ) {
                    // Page/kind changes aren't in AnnotationPatch — delete+create if page/kind differ.
                    if (existing.page !== next.page || existing.kind !== next.kind) {
                        await this.delete(existing.id);
                        await this.create({ ...next, seq: 0 });
                    } else {
                        await this.update(snap.id, { color: next.color, payload: next.payload });
                    }
                }
            }
        } finally {
            this.endBatch(batch);
        }
    }

    /** Pages that currently have live annotations. */
    annotatedPages(): number[] {
        return [...this.pages.entries()].filter(([, m]) => m.size > 0).map(([p]) => p);
    }

    subscribe(listener: PageListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Meta = undo/redo availability changes. */
    subscribeMeta(listener: () => void): () => void {
        this.metaListeners.add(listener);
        return () => this.metaListeners.delete(listener);
    }

    /** Hook for the sync engine (M3): poked after every committed op, with the marks it wrote. */
    setDirtyHook(hook: ((ids: readonly string[]) => void) | null): void {
        this.onDirty = hook;
    }

    /**
     * The signed-in account, stamped on every op queued from now on (see
     * PendingOp.userId), and whose queued changes alone are drawn (see
     * `foreign`).
     */
    setAuthor(userId: string | null): void {
        if (userId === this.author) {
            return;
        }
        this.author = userId;
        if (this.loading) {
            const next = this.ownership.then(() => this.applyOwnership());
            this.ownership = next.catch((err: unknown) => console.warn('Could not re-check queued marks', err));
        }
    }

    /** Marks with queued changes that are not `author`'s (see `foreign`). */
    private foreignIds(): Promise<Set<string>> {
        return foreignMarkIds(this.db, this.docId, this.author);
    }

    /** The author changed after hydration: hide and reveal marks to match. */
    private async applyOwnership(): Promise<void> {
        await this.ensureLoaded();
        const next = await this.foreignIds();
        const touched = new Set<number>();
        for (const id of next) {
            const hidden = this.byId.get(id);
            if (!this.foreign.has(id) && hidden) {
                this.byId.delete(id);
                this.pageMap(hidden.page).delete(id);
                touched.add(hidden.page);
            }
        }
        const revealed = [...this.foreign].filter((id) => !next.has(id));
        this.foreign = next;
        const rows = await this.db.annotations.bulkGet(revealed);
        for (const row of rows) {
            if (row && row.docId === this.docId && !this.byId.has(row.id) && !this.foreign.has(row.id)) {
                const { pending: _pending, ...annotation } = row;
                this.applyMemory(annotation);
                touched.add(annotation.page);
            }
        }
        for (const page of touched) {
            this.notifyPage(page);
        }
    }

    get canUndo(): boolean {
        return this.undo.canUndo;
    }

    get canRedo(): boolean {
        return this.undo.canRedo;
    }

    async create(annotation: Annotation): Promise<void> {
        await this.commit({ type: 'create', annotation }, { recordUndo: true });
    }

    /**
     * Bulk create — one Dexie transaction per chunk instead of one per row.
     * Semantically identical to awaiting create() in a loop (same undo ops,
     * same outbox rows, same LWW fields) but ~10× faster for imports: the
     * per-row cost is dominated by IndexedDB transaction overhead and the
     * day-snapshot existence check, both of which happen once here.
     */
    async createMany(annotations: Annotation[]): Promise<void> {
        if (annotations.length === 0 || this.historyOverlay) {
            return;
        }
        await ensureDayStartingSnapshot(this.db, this.docId, this.liveAnnotations());
        const touched = new Set<number>();
        const ops: CommitOp[] = [];
        for (const annotation of annotations) {
            this.applyLocal(annotation);
            this.undo.pushInverse({ type: 'delete', id: annotation.id });
            ops.push({ type: 'create', annotation });
            touched.add(annotation.page);
        }
        try {
            await this.persistMany(ops);
        } finally {
            for (const page of touched) {
                this.notifyPage(page);
            }
            this.notifyMeta();
        }
        this.onDirty?.(annotations.map((annotation) => annotation.id));
    }

    async update(id: string, patch: AnnotationPatch): Promise<void> {
        const prev = this.byId.get(id);
        if (!prev || prev.deletedAt) {
            return;
        }
        const next: Annotation = { ...prev, ...patch, updatedAt: nowIso() };
        await this.commit({ type: 'update', annotation: next, prev }, { recordUndo: true });
    }

    /** True when this call tombstoned the row; false if it was already gone. */
    async delete(id: string): Promise<boolean> {
        const prev = this.byId.get(id);
        if (!prev || prev.deletedAt) {
            return false;
        }
        return this.commit(
            { type: 'delete', annotation: { ...prev, deletedAt: nowIso(), updatedAt: nowIso() } },
            {
                recordUndo: true,
            },
        );
    }

    /**
     * Merge remote rows (pull or broadcast) under server-seq LWW.
     * Rows with local intent are held back — a pending op, an edit whose
     * mirror write is still in flight, another account's queued change (see
     * `foreign`) — since local intent wins until the flush acks. Returns the
     * ids held back, for the sync engine to apply once they settle.
     */
    async applyRemoteBatch(remotes: Annotation[], pendingIds: ReadonlySet<string>): Promise<Set<string>> {
        await this.ensureLoaded();
        const held = new Set<string>();
        const touchedPages = new Set<number>();
        const rows: LocalAnnotation[] = [];
        for (const remote of remotes) {
            if (
                pendingIds.has(remote.id) ||
                this.unpersisted.has(remote.id) ||
                this.failedPersist.has(remote.id) ||
                this.foreign.has(remote.id)
            ) {
                held.add(remote.id);
                continue;
            }
            const local = this.byId.get(remote.id);
            if (local && local.seq >= remote.seq) {
                continue;
            }
            this.byId.set(remote.id, remote);
            if (remote.deletedAt) {
                this.pageMap(remote.page).delete(remote.id);
            } else {
                this.pageMap(remote.page).set(remote.id, remote);
            }
            touchedPages.add(remote.page);
            rows.push({ ...remote, pending: 0 });
        }
        if (rows.length > 0) {
            await this.db.annotations.bulkPut(rows);
        }
        for (const page of touchedPages) {
            this.notifyPage(page);
        }
        return held;
    }

    /**
     * The server accepted the outbox for this row. A local create is born with
     * createdBy null, which means "this device, still waiting". Leave it null
     * after the ack and the next account on this browser treats the row as
     * theirs, and treats another account's marks as its own.
     */
    async markSynced(id: string, createdBy: string | null): Promise<void> {
        await this.ensureLoaded();
        const current = this.byId.get(id);
        if (current && createdBy && !current.createdBy) {
            this.applyMemory({ ...current, createdBy });
            this.notifyPage(current.page);
        }
        const mirror = await this.db.annotations.get(id);
        if (!mirror) {
            return;
        }
        const attributed = mirror.createdBy ?? createdBy;
        if (mirror.pending === 0 && mirror.createdBy === attributed) {
            return;
        }
        await this.db.annotations.put({ ...mirror, pending: 0, createdBy: attributed });
    }

    /**
     * After a full resync (the device was away past tombstone compaction):
     * remove every synced mark at or below `upToSeq` that the server did not
     * return in `seen`. Marks with local intent (queued, unsaved, another
     * account's) and marks never synced (seq 0) are left alone. Returns how
     * many went.
     */
    async dropAbsent(seen: ReadonlySet<string>, upToSeq: number, pendingIds: ReadonlySet<string>): Promise<number> {
        await this.ensureLoaded();
        const gone = [...this.byId.values()].filter(
            (a) =>
                a.seq > 0 &&
                a.seq <= upToSeq &&
                !seen.has(a.id) &&
                !pendingIds.has(a.id) &&
                !this.unpersisted.has(a.id) &&
                !this.committing.has(a.id) &&
                !this.failedPersist.has(a.id) &&
                !this.foreign.has(a.id),
        );
        if (gone.length === 0) {
            return 0;
        }
        const pages = new Set<number>();
        for (const a of gone) {
            this.byId.delete(a.id);
            this.pageMap(a.page).delete(a.id);
            pages.add(a.page);
        }
        await this.db.annotations.bulkDelete(gone.map((a) => a.id));
        pages.forEach((page) => this.notifyPage(page));
        return gone.length;
    }

    /** Remove an annotation the server rejected/never had (sync repair path). */
    async discardLocal(id: string): Promise<void> {
        await this.ensureLoaded();
        const existing = this.byId.get(id);
        if (existing) {
            this.byId.delete(id);
            this.pageMap(existing.page).delete(id);
        }
        // The mirror row goes even when memory never had it, or it would
        // come back on the next open.
        await this.db.annotations.delete(id);
        if (existing) {
            this.notifyPage(existing.page);
        }
    }

    /**
     * Sync repair: the server refused a local op, so its row is the truth.
     * Unlike applyRemoteBatch this ignores the seq comparison — a refused
     * local edit keeps the seq it started from, which equals the server's,
     * and LWW would otherwise keep the edit the server just refused.
     */
    async adoptServerRow(remote: Annotation): Promise<void> {
        await this.ensureLoaded();
        const { saved, repaint } = this.adoptServerRowWithin(remote);
        await saved;
        repaint();
    }

    /**
     * adoptServerRow for a caller rewriting the outbox in a Dexie transaction
     * over the mirror and the outbox (reconcile dropping a mark's queued ops),
     * which the mirror write joins. Memory changes before this returns, so an
     * edit that starts afterwards finds the mark as the server has it, not as
     * the dropped ops left it. Repainting waits for `repaint`, called once the
     * transaction has committed. The store must already be loaded.
     */
    adoptServerRowWithin(remote: Annotation): { saved: Promise<void>; repaint: () => void } {
        const prev = this.byId.get(remote.id);
        const pages = new Set([remote.page]);
        if (prev && prev.page !== remote.page) {
            this.pageMap(prev.page).delete(remote.id);
            pages.add(prev.page);
        }
        this.applyMemory(remote);
        return {
            saved: this.db.annotations.put({ ...remote, pending: 0 }).then(() => undefined),
            repaint: () => pages.forEach((page) => this.notifyPage(page)),
        };
    }

    /**
     * A local edit of this mark has been made but its outbox op is not
     * written yet — it is drawn, or still waiting on the day snapshot to be
     * drawn: what is queued for the mark is not all the user has done to it.
     */
    hasUnsavedEdit(id: string): boolean {
        return this.unpersisted.has(id) || this.committing.has(id);
    }

    /**
     * Resolves once every local edit of this mark made so far is in the
     * outbox, or failed to get there (refused as no longer applying, or its
     * write threw). Resolving is not success: a caller that goes on as if
     * the edit were saved checks hasPersistFailure first.
     */
    whenSaved(id: string): Promise<void> {
        if (!this.hasUnsavedEdit(id)) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const waiters = this.savedWaiters.get(id);
            if (waiters) {
                waiters.push(resolve);
            } else {
                this.savedWaiters.set(id, [resolve]);
            }
        });
    }

    /**
     * True while an edit of this mark could not be written to this device
     * (see `failedOps`): it is drawn, but it is in neither the mirror nor the
     * outbox, and is lost on reload unless retryFailedPersist succeeds.
     */
    hasPersistFailure(id: string): boolean {
        return this.failedPersist.has(id);
    }

    /** How many marks have an edit that could not be written (see hasPersistFailure). */
    get persistFailureCount(): number {
        return this.failedPersist.size;
    }

    /** The in-memory versions of the marks with a failed write (see unsavedMarksFor). */
    unsavedAnnotations(): Annotation[] {
        return [...this.failedPersist].flatMap((id) => {
            const annotation = this.byId.get(id);
            return annotation ? [annotation] : [];
        });
    }

    /**
     * Write the held edits again, oldest first. True once every one is in the
     * mirror and the outbox — the sync engine is woken for them — and false
     * if a write failed again, with what was not written still held.
     * Concurrent calls share one attempt.
     */
    retryFailedPersist(): Promise<boolean> {
        this.retrying ??= this.writeFailed().finally(() => {
            this.retrying = null;
        });
        return this.retrying;
    }

    private async writeFailed(): Promise<boolean> {
        const wrote: string[] = [];
        let ok = true;
        while (this.failedOps.length > 0) {
            // Edits held meanwhile only ever join at the end.
            const chunk = this.failedOps.slice(0, PERSIST_CHUNK);
            try {
                await this.writeMany(chunk);
            } catch (err) {
                console.warn('Retrying the unsaved marks failed', err);
                ok = false;
                break;
            }
            this.failedOps.splice(0, chunk.length);
            wrote.push(...chunk.map((op) => op.annotation.id));
            this.failedPersist = new Set(this.failedOps.map((op) => op.annotation.id));
        }
        if (this.failedOps.length === 0) {
            storesWithFailures.delete(this);
        }
        this.notifyMeta();
        if (wrote.length > 0) {
            this.onDirty?.([...new Set(wrote)]);
        }
        return ok;
    }

    /** Hold ops whose write failed, or that queue behind one (see `failedOps`). */
    private holdFailed(ops: CommitOp[]): void {
        if (ops.length === 0) {
            return;
        }
        this.failedOps.push(...ops);
        for (const op of ops) {
            this.failedPersist.add(op.annotation.id);
        }
        storesWithFailures.add(this);
        this.notifyMeta();
    }

    /**
     * Another engine rewrote these rows in the mirror from server truth — the
     * background drain adopting a collaborator's delete, another tab rolling a
     * refused change back. Re-read them so this tab draws what Dexie now holds
     * instead of the copy it loaded before. A row with local intent still
     * pending (queued in the outbox, or applied here and not yet written) is
     * left alone: that intent is newer, and its own sync settles it.
     *
     * includeQueued: the rows are local edits another tab of this browser
     * just wrote (a written message). The mirror holds the device's newest
     * intent for them, queued or not, so only an edit of this store's own
     * still on its way to Dexie keeps its copy.
     */
    async reloadFromMirror(ids: readonly string[], options: { includeQueued?: boolean } = {}): Promise<void> {
        await this.ensureLoaded();
        const { rows, queued } = await this.db.transaction('r', this.db.annotations, this.db.ops, async () => ({
            rows: await this.db.annotations.bulkGet([...ids]),
            queued: options.includeQueued
                ? new Set<string>()
                : new Set((await this.db.ops.where('docId').equals(this.docId).toArray()).map((op) => op.annotationId)),
        }));
        const touched = new Set<number>();
        ids.forEach((id, i) => {
            if (queued.has(id) || this.unpersisted.has(id) || this.failedPersist.has(id) || this.foreign.has(id)) {
                return;
            }
            const row = rows[i];
            const prev = this.byId.get(id);
            if (row && row.docId !== this.docId) {
                return;
            }
            if (prev && (!row || prev.page !== row.page)) {
                this.pageMap(prev.page).delete(id);
                touched.add(prev.page);
            }
            if (!row) {
                this.byId.delete(id);
                return;
            }
            const { pending: _pending, ...annotation } = row;
            this.applyMemory(annotation);
            touched.add(annotation.page);
        });
        for (const page of touched) {
            this.notifyPage(page);
        }
    }

    /** Group several ops (e.g. an eraser drag) into one undo entry. Nests. */
    beginBatch(): UndoBatchHandle {
        return this.undo.beginBatch();
    }

    endBatch(handle?: UndoBatchHandle): void {
        this.undo.endBatch(handle);
        this.notifyMeta();
    }

    /** Drop `handle`'s open batch without recording it. */
    cancelBatch(handle?: UndoBatchHandle): void {
        this.undo.cancelBatch(handle);
        this.notifyMeta();
    }

    /** Undelete a tombstone (convert abort restores siblings it already deleted). */
    async restore(id: string): Promise<void> {
        const prev = this.byId.get(id);
        if (!prev || !prev.deletedAt) {
            return;
        }
        await this.commit(
            {
                type: 'restore',
                annotation: { ...prev, deletedAt: null, updatedAt: nowIso() },
                baseDeletedAt: prev.deletedAt,
            },
            { recordUndo: true },
        );
    }

    /**
     * Undo the newest entry that still has something to undo. An entry whose
     * every op targets a mark a collaborator has since deleted is dropped and
     * the next one is tried, so one press always does something visible
     * instead of silently spending itself on a mark that is already gone.
     */
    async undoLast(): Promise<void> {
        if (this.historyOverlay) {
            return; // read-only while an overlay is shown — don't consume the entry
        }
        for (;;) {
            const entry = this.undo.popUndo();
            if (!entry) {
                break;
            }
            const inverses = await this.replayEntry(entry);
            if (inverses) {
                this.undo.pushRedoEntry(inverses);
                break;
            }
        }
        this.notifyMeta();
    }

    async redoLast(): Promise<void> {
        if (this.historyOverlay) {
            return;
        }
        for (;;) {
            const entry = this.undo.popRedo();
            if (!entry) {
                break;
            }
            const inverses = await this.replayEntry(entry);
            if (inverses) {
                this.undo.pushUndoEntryRaw(inverses);
                break;
            }
        }
        this.notifyMeta();
    }

    /**
     * Replay one undo/redo entry: inverses in reverse order, chunked so a
     * 30k-op import undoes with visible progress (memory + persist + repaint
     * per chunk) instead of one silent multi-second write. Memory state
     * updates op by op — later ops may read earlier ops' effects.
     */
    private async replayEntry(ops: UndoableOp[] | null): Promise<UndoableOp[] | null> {
        if (!ops) {
            return null;
        }
        const CHUNK = 4000;
        const reversed = [...ops].reverse();
        const inverses: UndoableOp[] = [];
        const wrote: string[] = [];
        for (let start = 0; start < reversed.length; start += CHUNK) {
            const commits: CommitOp[] = [];
            const touched = new Set<number>();
            for (const op of reversed.slice(start, start + CHUNK)) {
                const planned = this.applyUndoableInMemory(op);
                if (planned) {
                    commits.push(planned.commit);
                    inverses.push(planned.inverse);
                    touched.add(planned.commit.annotation.page);
                }
            }
            if (commits.length > 0) {
                try {
                    await this.persistMany(commits);
                } finally {
                    // Drawn as memory has it either way: a write that failed
                    // is held for retry, not undone.
                    for (const page of touched) {
                        this.notifyPage(page);
                    }
                }
                wrote.push(...commits.map((commit) => commit.annotation.id));
            }
        }
        if (wrote.length > 0) {
            this.onDirty?.(wrote);
        }
        return inverses.length > 0 ? inverses : null;
    }

    /** Apply an undo/redo op to memory and plan its durable write; return the write + its inverse. */
    private applyUndoableInMemory(op: UndoableOp): { commit: CommitOp; inverse: UndoableOp } | null {
        switch (op.type) {
            case 'create': {
                const annotation = { ...op.annotation, updatedAt: nowIso() };
                this.applyLocal(annotation);
                return { commit: { type: 'create', annotation }, inverse: { type: 'delete', id: annotation.id } };
            }
            case 'delete': {
                const prev = this.byId.get(op.id);
                if (!prev || prev.deletedAt) {
                    return null;
                }
                const annotation = { ...prev, deletedAt: nowIso(), updatedAt: nowIso() };
                this.applyLocal(annotation);
                return { commit: { type: 'delete', annotation }, inverse: { type: 'restore', id: op.id } };
            }
            case 'restore': {
                const prev = this.byId.get(op.id);
                if (!prev || !prev.deletedAt) {
                    return null;
                }
                const annotation = { ...prev, deletedAt: null, updatedAt: nowIso() };
                this.applyLocal(annotation);
                return {
                    commit: { type: 'restore', annotation, baseDeletedAt: prev.deletedAt },
                    inverse: { type: 'delete', id: op.id },
                };
            }
            case 'update': {
                // A tombstone here means a collaborator deleted the mark after
                // this entry was recorded (a local delete would have pushed its
                // own restore, replayed before this op). Replaying the old
                // fields — deletedAt null among them — would resurrect a mark
                // someone else removed, so the op is skipped and dropped.
                const prev = this.byId.get(op.id);
                if (!prev || prev.deletedAt) {
                    return null;
                }
                const annotation = { ...op.annotation, updatedAt: nowIso() };
                this.applyLocal(annotation);
                return {
                    commit: { type: 'update', annotation, prev },
                    inverse: { type: 'update', id: op.id, annotation: prev },
                };
            }
        }
    }

    private async commit(op: CommitOp, options: { recordUndo?: boolean }): Promise<boolean> {
        if (this.historyOverlay) {
            return false;
        }

        // Creates apply to the live map before any IndexedDB yield so the
        // handwriting pause can start at pointer-up. Snapshot still uses the
        // pre-edit set. Updates/deletes keep snapshot-first because a peer
        // tombstone during that yield must not still apply (`stillApplies`).
        if (op.type === 'create') {
            const preEdit = options.recordUndo ? this.liveAnnotations() : [];
            this.applyLocal(op.annotation);
            if (options.recordUndo) {
                this.pushCommitInverse(op);
                try {
                    await ensureDayStartingSnapshot(this.db, this.docId, preEdit);
                } catch (err) {
                    // Never written, so never to be waited for (see whenSaved),
                    // but drawn: held for retry like a failed write.
                    this.holdFailed([op]);
                    this.releaseUnpersisted([op]);
                    this.notifyPage(op.annotation.page);
                    throw err;
                }
            }
            try {
                await this.persistMany([op]);
            } finally {
                this.notifyPage(op.annotation.page);
                this.notifyMeta();
            }
            this.onDirty?.([op.annotation.id]);
            return true;
        }

        const { annotation } = op;

        // From here the edit is unsaved (see hasUnsavedEdit), though it is
        // not drawn until the snapshot below is checked: a reconcile of this
        // mark deciding in that yield would otherwise decide without it, and
        // could drop an Undo this edit builds on (QA C1).
        this.committing.set(annotation.id, (this.committing.get(annotation.id) ?? 0) + 1);
        try {
            // Capture today's starting point before the first user edit of the day.
            if (options.recordUndo) {
                await ensureDayStartingSnapshot(this.db, this.docId, this.liveAnnotations());
            }

            // The snapshot read yields. A peer erase in that window must not still
            // tombstone (or undo-record) a row that is already gone.
            if (!this.stillApplies(op)) {
                return false;
            }

            // 1. In-memory map (render source) — synchronous, so the UI never waits on IndexedDB.
            // `unpersisted` holds the edit from here.
            this.applyLocal(annotation);
        } finally {
            const left = (this.committing.get(annotation.id) ?? 1) - 1;
            if (left > 0) {
                this.committing.set(annotation.id, left);
            } else {
                this.committing.delete(annotation.id);
            }
            this.releaseSavedWaiters(annotation.id);
        }

        // 2. Inverse for undo.
        if (options.recordUndo) {
            this.pushCommitInverse(op);
        }

        // 3. Durable mirror + outbox, atomically. 4. Repaint — memory has the
        // edit whether or not the write held — and wake the sync engine.
        try {
            await this.persistMany([op]);
        } finally {
            this.notifyPage(annotation.page);
            this.notifyMeta();
        }
        this.onDirty?.([annotation.id]);
        return true;
    }

    /** False when a concurrent erase/restore won during `commit`'s snapshot yield. */
    private stillApplies(op: CommitOp): boolean {
        switch (op.type) {
            case 'create':
                return true;
            case 'update':
            case 'delete': {
                const live = this.byId.get(op.annotation.id);
                return !!live && !live.deletedAt;
            }
            case 'restore': {
                const live = this.byId.get(op.annotation.id);
                return !!live && !!live.deletedAt;
            }
            default: {
                const _exhaustive: never = op;
                return _exhaustive;
            }
        }
    }

    private pushCommitInverse(op: CommitOp): void {
        switch (op.type) {
            case 'create':
                this.undo.pushInverse({ type: 'delete', id: op.annotation.id });
                return;
            case 'update':
                this.undo.pushInverse({ type: 'update', id: op.annotation.id, annotation: op.prev });
                return;
            case 'delete':
                this.undo.pushInverse({ type: 'restore', id: op.annotation.id });
                return;
            case 'restore':
                this.undo.pushInverse({ type: 'delete', id: op.annotation.id });
                return;
            default: {
                const _exhaustive: never = op;
                return _exhaustive;
            }
        }
    }

    /** In-memory map updates (render source) — synchronous, UI never waits on IndexedDB. */
    private applyMemory(annotation: Annotation): void {
        this.byId.set(annotation.id, annotation);
        if (annotation.deletedAt) {
            this.pageMap(annotation.page).delete(annotation.id);
        } else {
            this.pageMap(annotation.page).set(annotation.id, annotation);
        }
    }

    /** applyMemory for a local edit, which persistMany will write (and release). */
    private applyLocal(annotation: Annotation): void {
        this.unpersisted.set(annotation.id, (this.unpersisted.get(annotation.id) ?? 0) + 1);
        this.applyMemory(annotation);
    }

    /**
     * Durable mirror + outbox for a set of ops, atomically per chunk. Bulk
     * writes amortize the IndexedDB transaction overhead that dominates
     * per-row puts; chunks keep a 30k-op import from building one giant
     * transaction that starves concurrent readers.
     */
    private async persistMany(ops: CommitOp[]): Promise<void> {
        // A mark already waiting on a retry: queue behind its held edit.
        const behind = this.failedPersist.size > 0 ? ops.filter((op) => this.failedPersist.has(op.annotation.id)) : [];
        const fresh = behind.length > 0 ? ops.filter((op) => !this.failedPersist.has(op.annotation.id)) : ops;
        let written = 0;
        try {
            this.holdFailed(behind);
            for (; written < fresh.length; written += PERSIST_CHUNK) {
                await this.writeMany(fresh.slice(written, written + PERSIST_CHUNK));
            }
        } catch (err) {
            // Chunks before this one committed; this one rolled back whole.
            this.holdFailed(fresh.slice(written));
            throw err;
        } finally {
            this.releaseUnpersisted(ops);
        }
    }

    /** The applyLocal writes of these ops are over, written or not. */
    private releaseUnpersisted(ops: CommitOp[]): void {
        for (const op of ops) {
            const { id } = op.annotation;
            const left = (this.unpersisted.get(id) ?? 1) - 1;
            if (left > 0) {
                this.unpersisted.set(id, left);
            } else {
                this.unpersisted.delete(id);
                this.releaseSavedWaiters(id);
            }
        }
    }

    /** Resolve whenSaved for this mark once nothing of it is unsaved. */
    private releaseSavedWaiters(id: string): void {
        if (this.hasUnsavedEdit(id)) {
            return;
        }
        const waiters = this.savedWaiters.get(id);
        this.savedWaiters.delete(id);
        waiters?.forEach((resolve) => resolve());
    }

    /** One atomic mirror + outbox write (persistMany chunks to PERSIST_CHUNK). */
    private async writeMany(slice: CommitOp[]): Promise<void> {
        const rows: LocalAnnotation[] = slice.map((op) => ({ ...op.annotation, pending: 1 }));
        const queuedAt = nowIso();
        const author = this.author;
        const opRows = slice.map((op): PendingOp => ({
            docId: this.docId,
            type: op.type,
            annotationId: op.annotation.id,
            annotation: op.annotation,
            queuedAt,
            ...(op.type === 'restore' ? { baseDeletedAt: op.baseDeletedAt } : {}),
            ...(author ? { userId: author } : {}),
        }));
        await this.db.transaction('rw', this.db.annotations, this.db.ops, async () => {
            await this.db.annotations.bulkPut(rows);
            await this.db.ops.bulkAdd(opRows);
        });
    }

    private pageMap(pageIndex: number): Map<string, Annotation> {
        let map = this.pages.get(pageIndex);
        if (!map) {
            map = new Map();
            this.pages.set(pageIndex, map);
        }
        return map;
    }

    private notifyPage(pageIndex: number): void {
        for (const listener of this.listeners) {
            listener(pageIndex);
        }
    }

    private notifyMeta(): void {
        for (const listener of this.metaListeners) {
            listener();
        }
    }
}

const EMPTY_PAGE: ReadonlyMap<string, Annotation> = new Map();

/** Ops per mirror + outbox transaction: one per row is too slow, one per 30k-op import starves readers. */
const PERSIST_CHUNK = 4000;

const nowIso = (): string => new Date().toISOString();
