import { ensureDayStartingSnapshot } from '@/features/viewer/history/snapshotService';
import { UndoStack, type UndoableOp, type UndoBatchHandle } from '@/features/viewer/ink/undoStack';
import type { LocalAnnotation, ScribblerDb } from '@/sync/db';
import {
    baseOf,
    conflictCount,
    conflictMarksFor,
    conflictNoticeHidden,
    discardConflicts,
    editBoundTo,
    HeldInkFull,
    RecoveryCancelled,
    heldMarkCount,
    heldMarkIds,
    heldMarksFor,
    hideConflictNotice,
    holdOps,
    isHeld,
    keepCancelled,
    noteEditsInFlight,
    noteRefusedEdit,
    overflowCount,
    owedStartingPoint,
    persistOps,
    refusedEditCount,
    registerOpenStore,
    retryHeld,
    settleOvertaken,
    startingPointWritten,
    sweepCutOffWrites,
    type CommitOp,
    type InkWriteGuard,
    type RetryOptions,
} from '@/sync/inkRecovery';
import { foreignMarkIds } from '@/sync/opOwnership';
import type { Annotation, AnnotationPayload } from '@/types/models';

export type PageListener = (pageIndex: number) => void;

export interface AnnotationPatch {
    color?: string;
    payload?: AnnotationPayload;
}

/**
 * For an edit nobody awaits (a pen-up, an eraser pass): a write that fails is
 * already flagged (hasPersistFailure) and shown by the viewer's "couldn't be
 * saved" banner, so it must not also surface as an unhandled rejection.
 */
export const settleEdit = (edit: Promise<unknown>): void => {
    void edit.catch((err: unknown) => console.warn('Could not save a mark on this device', err));
};

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
     * closed or blocked database) are held in inkRecovery, under the account
     * that made them, not here: a store lasts one viewer mount, and the next
     * one must find them (see hydrate). This store draws the author's held
     * marks, writes an edit of one behind its held ops, and holds remote and
     * mirror rows back from them (hasPersistFailure).
     */
    private onHeldChange: (() => void) | null = null;
    /** The sync engine's part in a Retry (see setRetryHooks). */
    private retryHooks: RetryHooks | null = null;
    /**
     * Moved on when memory is reset for another account (resetMemory): a
     * hydration or ownership pass begun before it applies nothing after.
     */
    private generation = 0;

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
        const generation = this.generation;
        // Rows of a write a sign-out cut off (inkRecovery.sweepCutOffWrites)
        // go first; any the sweep could not delete are nobody's
        // (opOwnerFor), so `foreign` keeps them out of memory.
        await sweepCutOffWrites(this.db, this.docId);
        const [rows, foreign] = await Promise.all([
            this.db.annotations.where('docId').equals(this.docId).toArray(),
            this.foreignIds(),
        ]);
        if (generation !== this.generation) {
            // Reset for another account meanwhile: its own load applies.
            return;
        }
        this.foreign = foreign;
        const touched = new Set<number>();
        // Drawn while the read was out: newer than anything held for them.
        const drawnMeanwhile = new Set(this.byId.keys());
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
        this.overlayHeld(new Map(rows.map((row) => [row.id, row])), drawnMeanwhile, touched);
        this.loaded = true;
        for (const page of touched) {
            this.notifyPage(page);
        }
        this.notifyMeta();
    }

    /**
     * Draw the author's held ink (inkRecovery) over the mirror's rows: an
     * edit this device could not store, made in an earlier mount of this
     * score, is still the newest version of its mark here. One a newer
     * version in the mirror has overtaken (another tab's edit, stored or
     * uploaded; inkRecovery.overtakes) is not drawn over it: memory keeps
     * the mirror's, and the held one stays for Export only. Marks in `skip`
     * keep what memory has.
     */
    private overlayHeld(
        rows: ReadonlyMap<string, LocalAnnotation | undefined>,
        skip: ReadonlySet<string>,
        touched: Set<number>,
    ): void {
        settleOvertaken(this.author, this.docId, rows);
        for (const held of heldMarksFor(this.author, this.docId)) {
            if (skip.has(held.id) || this.foreign.has(held.id)) {
                continue;
            }
            const prev = this.byId.get(held.id);
            if (prev && prev.page !== held.page) {
                this.pageMap(prev.page).delete(held.id);
                touched.add(prev.page);
            }
            this.applyMemory(held);
            touched.add(held.page);
        }
    }

    /**
     * Resolve once the mirror is in memory; no extra yield once it is. A
     * load overtaken by a reset (resetMemory) is waited past, to the one
     * that replaced it.
     */
    private async ensureLoaded(): Promise<void> {
        while (!this.loaded) {
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
        // Memory reset for another account part way (setAuthor): the rest of
        // this account's restore is not that one's to make.
        const generation = this.generation;
        try {
            for (const live of this.liveAnnotations()) {
                if (generation !== this.generation) {
                    return;
                }
                if (!snapById.has(live.id)) {
                    await this.delete(live.id);
                }
            }
            const now = nowIso();
            for (const snap of snapById.values()) {
                if (generation !== this.generation) {
                    return;
                }
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
                            prev: existing,
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
     * PendingOp.userId), and whose queued changes and held ink alone are
     * drawn (see `foreign`, inkRecovery).
     */
    setAuthor(userId: string | null): void {
        if (userId === this.author) {
            return;
        }
        const prev = this.author;
        this.author = userId;
        this.notifyMeta();
        if (!this.loading) {
            return;
        }
        if (prev !== null) {
            // Another account, or none, after one: nothing in memory may
            // carry over — not its marks, held ink, nor its undo history.
            this.resetMemory();
            return;
        }
        // The session resolving on a warm open: reveal what is this account's.
        const next = this.ownership.then(() => this.applyOwnership(prev));
        this.ownership = next.catch((err: unknown) => console.warn('Could not re-check queued marks', err));
    }

    /**
     * Forget everything in memory and hydrate again, for the current author:
     * the account changed (setAuthor), or this author signed out
     * (accountSignedOut). Writes of the previous account's still
     * on their way finish (or are cancelled, inkRecovery) as theirs, and are
     * that account's queued marks to this one (`foreign`).
     */
    private resetMemory(): void {
        this.generation += 1;
        const pages = new Set(this.pages.keys());
        this.pages.clear();
        this.byId.clear();
        this.foreign = new Set();
        this.undo.clear();
        this.loaded = false;
        this.loading = null;
        this.ownership = Promise.resolve();
        for (const page of pages) {
            this.notifyPage(page);
        }
        this.notifyMeta();
        void this.load().catch((err: unknown) => console.warn('Could not reload marks for the account', err));
    }

    /**
     * This store's author signed out (here or in another tab;
     * inkRecovery.retireAccountInk): what it drew for it goes, with the rest
     * of memory, and the mirror is read again. Its held ink is kept by
     * inkRecovery for Export or Discard, not drawn here.
     */
    accountSignedOut(): void {
        if (this.loading) {
            this.resetMemory();
        }
    }

    /** Marks with queued changes that are not `author`'s (see `foreign`). */
    private foreignIds(): Promise<Set<string>> {
        return foreignMarkIds(this.db, this.docId, this.author);
    }

    /** The account this store draws and stamps for (see setAuthor). */
    get authorId(): string | null {
        return this.author;
    }

    /** The author became known after hydration: hide and reveal marks to match. */
    private async applyOwnership(prevAuthor: string | null): Promise<void> {
        const generation = this.generation;
        await this.ensureLoaded();
        if (generation !== this.generation) {
            return;
        }
        await this.swapHeldInk(prevAuthor);
        const next = await this.foreignIds();
        if (generation !== this.generation) {
            return;
        }
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
        if (generation !== this.generation) {
            return;
        }
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

    /**
     * Held ink is the account's that made it: `prevAuthor`'s goes back to
     * what the mirror has (or out of memory, when the mirror cannot say), so
     * the next account never sees it, and the current author's is drawn.
     */
    private async swapHeldInk(prevAuthor: string | null): Promise<void> {
        const hide = [...heldMarkIds(prevAuthor, this.docId)].filter((id) => !isHeld(this.author, this.docId, id));
        const show = heldMarkIds(this.author, this.docId);
        if (hide.length === 0 && show.size === 0) {
            return;
        }
        const ids = [...new Set([...hide, ...show])];
        const generation = this.generation;
        const rows = await this.db.annotations.bulkGet(ids).catch(() => ids.map(() => undefined));
        if (generation !== this.generation) {
            return;
        }
        const byId = new Map(ids.map((id, i) => [id, rows[i]]));
        const touched = new Set<number>();
        for (const id of hide) {
            const shown = this.byId.get(id);
            if (shown) {
                this.byId.delete(id);
                this.pageMap(shown.page).delete(id);
                touched.add(shown.page);
            }
            const row = byId.get(id);
            if (row && row.docId === this.docId && !this.foreign.has(id)) {
                const { pending: _pending, ...annotation } = row;
                this.applyMemory(annotation);
                touched.add(annotation.page);
            }
        }
        this.overlayHeld(byId, new Set(), touched);
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
        const author = this.author;
        const live = editBoundTo(author, this.docId);
        const generation = this.generation;
        await this.captureStartingPoint(author, this.startingPointFor(author), live);
        if (!live() || generation !== this.generation) {
            // Signed out, the score lost, or memory reset for another
            // account, while it waited: none of these marks is applied here,
            // or written.
            throw new RecoveryCancelled();
        }
        const touched = new Set<number>();
        const ops: CommitOp[] = [];
        for (const annotation of annotations) {
            this.applyLocal(annotation);
            this.undo.pushInverse({ type: 'delete', id: annotation.id });
            ops.push({ type: 'create', annotation });
            touched.add(annotation.page);
        }
        try {
            await this.persistMany(ops, author, live);
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
            { type: 'delete', annotation: { ...prev, deletedAt: nowIso(), updatedAt: nowIso() }, prev },
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
                this.hasPersistFailure(remote.id) ||
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
                !this.hasPersistFailure(a.id) &&
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
     * written: it is drawn, or still waiting on the day snapshot to be
     * drawn, or its write failed and it is held (hasPersistFailure) — what
     * is queued for the mark is not all the user has done to it.
     */
    hasUnsavedEdit(id: string): boolean {
        return this.isWriting(id) || this.hasPersistFailure(id);
    }

    /** An edit of this mark is on its way to the outbox: still to be drawn, or drawn and being written. */
    private isWriting(id: string): boolean {
        return this.unpersisted.has(id) || this.committing.has(id);
    }

    /**
     * Settles once no edit of this mark made so far is still on its way:
     * true when every one is in the outbox (or was refused as no longer
     * applying, which leaves nothing of it unsaved), false when one is held
     * because its write failed (hasPersistFailure). False is not a save.
     */
    whenSaved(id: string): Promise<boolean> {
        if (!this.isWriting(id)) {
            return Promise.resolve(!this.hasPersistFailure(id));
        }
        return new Promise((resolve) => {
            const settle = () => resolve(!this.hasPersistFailure(id));
            const waiters = this.savedWaiters.get(id);
            if (waiters) {
                waiters.push(settle);
            } else {
                this.savedWaiters.set(id, [settle]);
            }
        });
    }

    /**
     * True while an edit of this mark by this author could not be written
     * to this device (see inkRecovery): it is drawn, but it is in neither
     * the mirror nor the outbox, and is lost on reload unless a retry, or a
     * later edit of the mark, writes it.
     */
    hasPersistFailure(id: string): boolean {
        return isHeld(this.author, this.docId, id);
    }

    /** How many marks have an edit that could not be written (see hasPersistFailure). */
    get persistFailureCount(): number {
        return heldMarkCount(this.author, this.docId);
    }

    /**
     * Edits of existing marks refused because the day's starting point could
     * not be written first (see commit): never applied, so nothing to retry
     * but the snapshot, yet the viewer says so.
     */
    get refusedEditCount(): number {
        return refusedEditCount(this.author, this.docId);
    }

    /**
     * Edits not made because this device could hold no more unsaved marks
     * (inkRecovery.MAX_HELD_*): undone on screen, and the viewer says so.
     */
    get overflowCount(): number {
        return overflowCount(this.author, this.docId);
    }

    /**
     * Held marks a newer version overtook before they could be written
     * (inkRecovery.overtakes): this store draws the newer one, Retry leaves
     * them alone, and Export keeps them as well.
     */
    get conflictCount(): number {
        return conflictCount(this.author, this.docId);
    }

    /** Of conflictCount, those Export can draw: an overtaken erase has no version of its own to keep. */
    get exportableConflictCount(): number {
        return conflictMarksFor(this.author, this.docId).filter((a) => !a.deletedAt).length;
    }

    /** The user hid the conflict notice (its Dismiss): the conflicts stay for Export. */
    get conflictNoticeHidden(): boolean {
        return conflictNoticeHidden(this.author, this.docId);
    }

    /** The banner's Dismiss: hides the notice only; Export still has the conflicts. */
    hideConflictNotice(): void {
        hideConflictNotice(this.author, this.docId);
        this.notifyMeta();
    }

    /** The banner's Discard, confirmed with Export offered first: the conflicts go for good. */
    discardConflicts(): void {
        discardConflicts(this.author, this.docId);
        this.notifyMeta();
    }

    /** The newest unsaved version of each mark with a failed write, tombstones included. */
    unsavedAnnotations(): Annotation[] {
        return heldMarksFor(this.author, this.docId);
    }

    /**
     * Write this author's held edits on this score again, oldest first,
     * after the day snapshot they owe — whichever store made them. True once
     * all are in the mirror and the outbox (the sync engine is woken for
     * them), false if a write failed again, with what was not written still
     * held. Each goes out under the account that made it.
     */
    async retryFailedPersist(): Promise<boolean> {
        const hooks = this.retryHooks;
        const options: RetryOptions = hooks ? { serverRows: hooks.serverRows } : {};
        const { ok, wrote, overtaken } = await retryHeld(this.author, this.docId, options);
        if (overtaken.length > 0) {
            // Drawn as the newer version: this device's newest copy, then the server's.
            await this.reloadFromMirror(overtaken, { includeQueued: true }).catch(() => undefined);
            hooks?.overtaken(overtaken);
        }
        this.notifyMeta();
        this.onHeldChange?.();
        if (wrote.length > 0) {
            this.onDirty?.(wrote);
        }
        return ok;
    }

    /**
     * Hooks for the sync engine's part in a Retry: the server's current
     * versions of held marks (a newer one overtakes them; see
     * inkRecovery.overtakes), and the marks that were, so it draws the
     * server's version of them.
     */
    setRetryHooks(hooks: RetryHooks | null): void {
        this.retryHooks = hooks;
    }

    /**
     * Hook for the sync engine: poked when this store's held ink changes, so
     * the score never reads "synced" while any is held (see SyncEngine.drain).
     */
    setHeldHook(hook: (() => void) | null): void {
        this.onHeldChange = hook;
    }

    /**
     * The viewer has this store open: export reads its memory when the
     * database cannot be read, and the recovery cap spares its score
     * (inkRecovery.registerOpenStore). Returns the detach, for the unmount.
     */
    attach(): () => void {
        void this.sweepStale();
        return registerOpenStore(this);
    }

    /**
     * Rows of writes a sign-out cut off (inkRecovery.sweepCutOffWrites):
     * swept, and the marks they were on read again from what the mirror
     * holds now. Until then they are another's to this store (`foreign`).
     */
    private async sweepStale(): Promise<void> {
        const stale = await sweepCutOffWrites(this.db, this.docId);
        if (stale.size === 0 || !this.loaded) {
            return;
        }
        const generation = this.generation;
        const foreign = await this.foreignIds().catch(() => null);
        if (!foreign || generation !== this.generation) {
            return;
        }
        const freed = [...stale].filter((id) => this.foreign.has(id) && !foreign.has(id));
        freed.forEach((id) => this.foreign.delete(id));
        if (freed.length > 0) {
            await this.reloadFromMirror(freed).catch(() => undefined);
        }
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
            if (queued.has(id) || this.unpersisted.has(id) || this.hasPersistFailure(id) || this.foreign.has(id)) {
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
                prev,
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
        const author = this.author;
        const live = editBoundTo(author, this.docId);
        const generation = this.generation;
        const reversed = [...ops].reverse();
        const inverses: UndoableOp[] = [];
        const wrote: string[] = [];
        for (let start = 0; start < reversed.length; start += CHUNK) {
            if (!live() || generation !== this.generation) {
                // Signed out, or reset for another account, between chunks:
                // the rest of the entry is not applied.
                throw new RecoveryCancelled();
            }
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
                    await this.persistMany(commits, author, live);
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
                return { commit: { type: 'delete', annotation, prev }, inverse: { type: 'restore', id: op.id } };
            }
            case 'restore': {
                const prev = this.byId.get(op.id);
                if (!prev || !prev.deletedAt) {
                    return null;
                }
                const annotation = { ...prev, deletedAt: null, updatedAt: nowIso() };
                this.applyLocal(annotation);
                return {
                    commit: { type: 'restore', annotation, baseDeletedAt: prev.deletedAt, prev },
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
        // The account the edit is made under, whatever it is by the time it
        // is written — and its epoch and the score's then: a sign-out, or the
        // score lost to this device, before the write ends it (editBoundTo).
        const author = this.author;
        const live = editBoundTo(author, this.docId);
        const generation = this.generation;

        // Creates apply to the live map before any IndexedDB yield so the
        // handwriting pause can start at pointer-up. Snapshot still uses the
        // pre-edit set. Updates/deletes keep snapshot-first because a peer
        // tombstone during that yield must not still apply (`stillApplies`).
        if (op.type === 'create') {
            const preEdit = options.recordUndo ? this.startingPointFor(author) : [];
            this.applyLocal(op.annotation);
            if (options.recordUndo) {
                this.pushCommitInverse(op);
                try {
                    await this.captureStartingPoint(author, preEdit, live);
                } catch (err) {
                    // Never written, but drawn: held for retry like a failed
                    // write, with the day's starting point it still owes —
                    // or, past the registry's bounds, undone and said so.
                    // Once its account has signed out, or the score is lost:
                    // held as signed-out or closed ink (Export or Discard),
                    // and no longer drawn here.
                    const cancelled = !live();
                    const held = { op, author, order: live.order };
                    if (cancelled) {
                        keepCancelled(this.db, author, this.docId, [held], live);
                    }
                    const refused = cancelled ? [op] : holdOps(this.db, this.docId, [held], preEdit);
                    if (refused.length > 0) {
                        this.rollBack([op]);
                    }
                    this.releaseUnpersisted([op]);
                    this.notifyPage(op.annotation.page);
                    this.notifyMeta();
                    this.onHeldChange?.();
                    throw cancelled ? new RecoveryCancelled() : refused.length > 0 ? new HeldInkFull([op], err) : err;
                }
            }
            try {
                await this.persistMany([op], author, live);
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
        noteEditsInFlight(1);
        try {
            // Capture today's starting point before the first user edit of the day.
            if (options.recordUndo) {
                const preEdit = this.startingPointFor(author);
                try {
                    await this.captureStartingPoint(author, preEdit, live);
                } catch (err) {
                    // Refused, as it always was: the edit never applies and
                    // the mark stays as it is. The viewer still says an edit
                    // could not be saved (refusedEditCount), and its Retry
                    // writes the starting point. (Not once its account has
                    // signed out: there is nothing left to say it to.)
                    if (live()) {
                        noteRefusedEdit(this.db, author, this.docId, preEdit);
                    }
                    this.notifyMeta();
                    throw err;
                }
            }

            // The snapshot read yields. A peer erase in that window must not still
            // tombstone (or undo-record) a row that is already gone. Nor may
            // the edit apply once its account has signed out, or memory been
            // reset for another account: it was never drawn, so nothing is lost.
            if (!live() || generation !== this.generation || !this.stillApplies(op)) {
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
            noteEditsInFlight(-1);
            this.releaseSavedWaiters(annotation.id);
        }

        // 2. Inverse for undo.
        if (options.recordUndo) {
            this.pushCommitInverse(op);
        }

        // 3. Durable mirror + outbox, atomically. 4. Repaint — memory has the
        // edit whether or not the write held — and wake the sync engine.
        try {
            await this.persistMany([op], author, live);
        } finally {
            this.notifyPage(annotation.page);
            this.notifyMeta();
        }
        this.onDirty?.([annotation.id]);
        return true;
    }

    /**
     * The live set the day's starting point is taken from: the one an
     * earlier edit whose snapshot failed still owes (inkRecovery), since the
     * live set now has that edit in it, or else the live set as it stands.
     */
    private startingPointFor(author: string | null): Annotation[] {
        return owedStartingPoint(author, this.docId) ?? this.liveAnnotations();
    }

    /**
     * ensureDayStartingSnapshot, and on success nothing more is owed
     * (startingPointWritten). Written only while `live` (the edit's account
     * has not signed out since).
     */
    private async captureStartingPoint(
        author: string | null,
        preEdit: Annotation[],
        live: InkWriteGuard,
    ): Promise<void> {
        await ensureDayStartingSnapshot(this.db, this.docId, preEdit, null, live);
        startingPointWritten(author, this.docId);
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
        noteEditsInFlight(1);
        this.applyMemory(annotation);
    }

    /**
     * Durable mirror + outbox for a set of ops made by `author`, atomically
     * per chunk (inkRecovery.persistOps). Bulk writes amortize the IndexedDB
     * transaction overhead that dominates per-row puts; chunks keep a 30k-op
     * import from building one giant transaction that starves concurrent
     * readers. An edit of a held mark is written behind its held ops; what
     * could not be written is held, and the error rethrown.
     */
    private async persistMany(ops: CommitOp[], author: string | null, live: InkWriteGuard): Promise<void> {
        const held = heldMarkCount(author, this.docId);
        try {
            await this.writeMany(ops, author, live);
        } catch (err) {
            if (err instanceof HeldInkFull) {
                // Neither written nor held: not made, so not drawn either.
                this.rollBack(err.ops);
                this.notifyMeta();
                this.onHeldChange?.();
            } else if (err instanceof RecoveryCancelled) {
                // Its account signed out, or the score was lost, on the way:
                // not written, and held as signed-out or closed ink
                // (inkRecovery.keepCancelled), so not drawn here any more,
                // whoever this store draws for now.
                this.rollBack(ops);
                this.notifyMeta();
                this.onHeldChange?.();
            }
            throw err;
        } finally {
            this.releaseUnpersisted(ops);
            if (heldMarkCount(author, this.docId) !== held) {
                this.notifyMeta();
                this.onHeldChange?.();
            }
        }
    }

    /** The write itself (a seam the interleaving tests slow down). */
    private writeMany(ops: CommitOp[], author: string | null, live: InkWriteGuard): Promise<void> {
        return persistOps(this.db, author, this.docId, ops, live);
    }

    /**
     * Undo these edits in memory, newest first: they were neither written
     * nor held (HeldInkFull), so they were not made, and the banner says so
     * (overflowCount). A mark a later edit has changed since is left as it is.
     */
    private rollBack(ops: readonly CommitOp[]): void {
        for (const op of [...ops].reverse()) {
            const { id } = op.annotation;
            if (this.byId.get(id) !== op.annotation) {
                continue;
            }
            const base = baseOf(op);
            this.pageMap(op.annotation.page).delete(id);
            this.notifyPage(op.annotation.page);
            if (base) {
                this.applyMemory(base);
                this.notifyPage(base.page);
            } else {
                this.byId.delete(id);
            }
        }
    }

    /** The applyLocal writes of these ops are over, written or not. */
    private releaseUnpersisted(ops: CommitOp[]): void {
        for (const op of ops) {
            const { id } = op.annotation;
            noteEditsInFlight(-1);
            const left = (this.unpersisted.get(id) ?? 1) - 1;
            if (left > 0) {
                this.unpersisted.set(id, left);
            } else {
                this.unpersisted.delete(id);
                this.releaseSavedWaiters(id);
            }
        }
    }

    /** Settle whenSaved for this mark once no edit of it is on its way. */
    private releaseSavedWaiters(id: string): void {
        if (this.isWriting(id)) {
            return;
        }
        const waiters = this.savedWaiters.get(id);
        this.savedWaiters.delete(id);
        waiters?.forEach((settle) => settle());
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

/** See AnnotationStore.setRetryHooks. */
export interface RetryHooks {
    serverRows: NonNullable<RetryOptions['serverRows']>;
    overtaken: (ids: readonly string[]) => void;
}

const EMPTY_PAGE: ReadonlyMap<string, Annotation> = new Map();

const nowIso = (): string => new Date().toISOString();
