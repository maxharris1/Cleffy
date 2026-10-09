import { ensureDayStartingSnapshot } from '@/features/viewer/history/snapshotService';
import { UndoStack, type UndoableOp, type UndoBatchHandle } from '@/features/viewer/ink/undoStack';
import type { LocalAnnotation, PendingOp, ScribblerDb } from '@/sync/db';
import type { Annotation, AnnotationPayload } from '@/types/models';

export type PageListener = (pageIndex: number) => void;

export interface AnnotationPatch {
    color?: string;
    payload?: AnnotationPayload;
}

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
    private onDirty: (() => void) | null = null;
    private loading: Promise<void> | null = null;
    private loaded = false;
    /**
     * Local edits applied to memory whose mirror write has not finished, by
     * id. reloadFromMirror must not replace them with the older row Dexie
     * still holds.
     */
    private unpersisted = new Map<string, number>();

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
        const rows = await this.db.annotations.where('docId').equals(this.docId).toArray();
        const touched = new Set<number>();
        for (const row of rows) {
            if (this.byId.has(row.id)) {
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

    /** Hook for the sync engine (M3): poked after every committed op. */
    setDirtyHook(hook: (() => void) | null): void {
        this.onDirty = hook;
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
        await this.persistMany(ops);
        for (const page of touched) {
            this.notifyPage(page);
        }
        this.notifyMeta();
        this.onDirty?.();
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
     * Rows with a pending local op are skipped — local intent wins until the
     * flush acks, at which point the server re-broadcasts a newer seq.
     */
    async applyRemoteBatch(remotes: Annotation[], pendingIds: ReadonlySet<string>): Promise<void> {
        await this.ensureLoaded();
        const touchedPages = new Set<number>();
        const rows: LocalAnnotation[] = [];
        for (const remote of remotes) {
            if (pendingIds.has(remote.id)) {
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
        const prev = this.byId.get(remote.id);
        if (prev && prev.page !== remote.page) {
            this.pageMap(prev.page).delete(remote.id);
            this.notifyPage(prev.page);
        }
        this.applyMemory(remote);
        await this.db.annotations.put({ ...remote, pending: 0 });
        this.notifyPage(remote.page);
    }

    /**
     * Another engine rewrote these rows in the mirror from server truth — the
     * background drain adopting a collaborator's delete, another tab rolling a
     * refused change back. Re-read them so this tab draws what Dexie now holds
     * instead of the copy it loaded before. A row with local intent still
     * pending (queued in the outbox, or applied here and not yet written) is
     * left alone: that intent is newer, and its own sync settles it.
     */
    async reloadFromMirror(ids: readonly string[]): Promise<void> {
        await this.ensureLoaded();
        const { rows, queued } = await this.db.transaction('r', this.db.annotations, this.db.ops, async () => ({
            rows: await this.db.annotations.bulkGet([...ids]),
            queued: new Set(
                (await this.db.ops.where('docId').equals(this.docId).toArray()).map((op) => op.annotationId),
            ),
        }));
        const touched = new Set<number>();
        ids.forEach((id, i) => {
            if (queued.has(id) || this.unpersisted.has(id)) {
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
        let wrote = false;
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
                await this.persistMany(commits);
                for (const page of touched) {
                    this.notifyPage(page);
                }
                wrote = true;
            }
        }
        if (wrote) {
            this.onDirty?.();
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
                await ensureDayStartingSnapshot(this.db, this.docId, preEdit);
            }
            await this.persistMany([op]);
            this.notifyPage(op.annotation.page);
            this.notifyMeta();
            this.onDirty?.();
            return true;
        }

        // Capture today's starting point before the first user edit of the day.
        if (options.recordUndo) {
            await ensureDayStartingSnapshot(this.db, this.docId, this.liveAnnotations());
        }

        // The snapshot read yields. A peer erase in that window must not still
        // tombstone (or undo-record) a row that is already gone.
        if (!this.stillApplies(op)) {
            return false;
        }

        const { annotation } = op;

        // 1. In-memory map (render source) — synchronous, so the UI never waits on IndexedDB.
        this.applyLocal(annotation);

        // 2. Inverse for undo.
        if (options.recordUndo) {
            this.pushCommitInverse(op);
        }

        // 3. Durable mirror + outbox, atomically.
        await this.persistMany([op]);

        // 4. Repaint + wake the sync engine.
        this.notifyPage(annotation.page);
        this.notifyMeta();
        this.onDirty?.();
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
        try {
            await this.writeMany(ops);
        } finally {
            for (const op of ops) {
                const left = (this.unpersisted.get(op.annotation.id) ?? 1) - 1;
                if (left > 0) {
                    this.unpersisted.set(op.annotation.id, left);
                } else {
                    this.unpersisted.delete(op.annotation.id);
                }
            }
        }
    }

    private async writeMany(ops: CommitOp[]): Promise<void> {
        const CHUNK = 4000;
        for (let start = 0; start < ops.length; start += CHUNK) {
            const slice = ops.slice(start, start + CHUNK);
            const rows: LocalAnnotation[] = slice.map((op) => ({ ...op.annotation, pending: 1 }));
            const queuedAt = nowIso();
            const opRows = slice.map((op): PendingOp => ({
                docId: this.docId,
                type: op.type,
                annotationId: op.annotation.id,
                annotation: op.annotation,
                queuedAt,
                ...(op.type === 'restore' ? { baseDeletedAt: op.baseDeletedAt } : {}),
            }));
            await this.db.transaction('rw', this.db.annotations, this.db.ops, async () => {
                await this.db.annotations.bulkPut(rows);
                await this.db.ops.bulkAdd(opRows);
            });
        }
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

const nowIso = (): string => new Date().toISOString();
