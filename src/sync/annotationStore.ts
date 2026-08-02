import { ensureDayStartingSnapshot } from '@/features/viewer/history/snapshotService';
import { UndoStack, type UndoableOp } from '@/features/viewer/ink/undoStack';
import type { LocalAnnotation, PendingOpType, ScribblerDb } from '@/sync/db';
import type { Annotation, AnnotationPayload } from '@/types/models';

export type PageListener = (pageIndex: number) => void;

export interface AnnotationPatch {
    color?: string;
    payload?: AnnotationPayload;
}

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
    private listeners = new Set<PageListener>();
    private metaListeners = new Set<() => void>();
    private undo = new UndoStack();
    private onDirty: (() => void) | null = null;

    constructor(
        private db: ScribblerDb,
        readonly docId: string,
    ) {}

    /** Hydrate the in-memory map from the Dexie mirror. Call once on document open. */
    async load(): Promise<void> {
        const rows = await this.db.annotations.where('docId').equals(this.docId).toArray();
        this.pages.clear();
        this.byId.clear();
        for (const row of rows) {
            const { pending: _pending, ...annotation } = row;
            this.byId.set(annotation.id, annotation);
            if (!annotation.deletedAt) {
                this.pageMap(annotation.page).set(annotation.id, annotation);
            }
        }
        for (const page of this.pages.keys()) {
            this.notifyPage(page);
        }
        this.notifyMeta();
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

    /** Show a day's starting annotations read-only (null clears). */
    setHistoryOverlay(annotations: Annotation[] | null): void {
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
        this.beginBatch();
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
                        { type: 'restore', annotation: { ...next, seq: existing.seq } },
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
            this.endBatch();
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

    async update(id: string, patch: AnnotationPatch): Promise<void> {
        const prev = this.byId.get(id);
        if (!prev || prev.deletedAt) {
            return;
        }
        const next: Annotation = { ...prev, ...patch, updatedAt: nowIso() };
        await this.commit({ type: 'update', annotation: next, prev }, { recordUndo: true });
    }

    async delete(id: string): Promise<void> {
        const prev = this.byId.get(id);
        if (!prev || prev.deletedAt) {
            return;
        }
        await this.commit(
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

    /** Remove an annotation the server rejected/never had (sync repair path). */
    async discardLocal(id: string): Promise<void> {
        const existing = this.byId.get(id);
        if (!existing) {
            return;
        }
        this.byId.delete(id);
        this.pageMap(existing.page).delete(id);
        await this.db.annotations.delete(id);
        this.notifyPage(existing.page);
    }

    /** Group several ops (e.g. an eraser drag) into one undo entry. */
    beginBatch(): void {
        this.undo.beginBatch();
    }

    endBatch(): void {
        this.undo.endBatch();
        this.notifyMeta();
    }

    async undoLast(): Promise<void> {
        const ops = this.undo.popUndo();
        if (!ops) {
            return;
        }
        const redoOps: UndoableOp[] = [];
        // Replay inverses in reverse order; collect redo counterparts.
        for (const op of [...ops].reverse()) {
            const redo = await this.applyUndoable(op);
            if (redo) {
                redoOps.push(redo);
            }
        }
        if (redoOps.length > 0) {
            this.undo.pushRedoEntry(redoOps);
        }
        this.notifyMeta();
    }

    async redoLast(): Promise<void> {
        const ops = this.undo.popRedo();
        if (!ops) {
            return;
        }
        const undoOps: UndoableOp[] = [];
        for (const op of [...ops].reverse()) {
            const inverse = await this.applyUndoable(op);
            if (inverse) {
                undoOps.push(inverse);
            }
        }
        if (undoOps.length > 0) {
            this.undo.pushUndoEntryRaw(undoOps);
        }
        this.notifyMeta();
    }

    /** Apply an undo/redo op through commit (no new undo recording); return its inverse. */
    private async applyUndoable(op: UndoableOp): Promise<UndoableOp | null> {
        switch (op.type) {
            case 'create': {
                await this.commit({ type: 'create', annotation: { ...op.annotation, updatedAt: nowIso() } }, {});
                return { type: 'delete', id: op.annotation.id };
            }
            case 'delete': {
                const prev = this.byId.get(op.id);
                if (!prev || prev.deletedAt) {
                    return null;
                }
                await this.commit(
                    { type: 'delete', annotation: { ...prev, deletedAt: nowIso(), updatedAt: nowIso() } },
                    {},
                );
                return { type: 'restore', id: op.id };
            }
            case 'restore': {
                const prev = this.byId.get(op.id);
                if (!prev || !prev.deletedAt) {
                    return null;
                }
                await this.commit(
                    { type: 'restore', annotation: { ...prev, deletedAt: null, updatedAt: nowIso() } },
                    {},
                );
                return { type: 'delete', id: op.id };
            }
            case 'update': {
                const prev = this.byId.get(op.id);
                if (!prev) {
                    return null;
                }
                await this.commit({ type: 'update', annotation: { ...op.annotation, updatedAt: nowIso() }, prev }, {});
                return { type: 'update', id: op.id, annotation: prev };
            }
        }
    }

    private async commit(
        op:
            | { type: 'create'; annotation: Annotation }
            | { type: 'update'; annotation: Annotation; prev: Annotation }
            | { type: 'delete'; annotation: Annotation }
            | { type: 'restore'; annotation: Annotation },
        options: { recordUndo?: boolean },
    ): Promise<void> {
        if (this.historyOverlay) {
            return;
        }

        // Capture today's starting point before the first user edit of the day.
        if (options.recordUndo) {
            await ensureDayStartingSnapshot(this.db, this.docId, this.liveAnnotations());
        }

        const { annotation } = op;

        // 1. In-memory map (render source) — synchronous, so the UI never waits on IndexedDB.
        this.byId.set(annotation.id, annotation);
        if (annotation.deletedAt) {
            this.pageMap(annotation.page).delete(annotation.id);
        } else {
            this.pageMap(annotation.page).set(annotation.id, annotation);
        }

        // 2. Inverse for undo.
        if (options.recordUndo) {
            switch (op.type) {
                case 'create':
                    this.undo.pushInverse({ type: 'delete', id: annotation.id });
                    break;
                case 'update':
                    this.undo.pushInverse({ type: 'update', id: annotation.id, annotation: op.prev });
                    break;
                case 'delete':
                    this.undo.pushInverse({ type: 'restore', id: annotation.id });
                    break;
                case 'restore':
                    this.undo.pushInverse({ type: 'delete', id: annotation.id });
                    break;
            }
        }

        // 3. Durable mirror + outbox, atomically.
        const row: LocalAnnotation = { ...annotation, pending: 1 };
        const opType: PendingOpType = op.type;
        await this.db.transaction('rw', this.db.annotations, this.db.ops, async () => {
            await this.db.annotations.put(row);
            await this.db.ops.add({
                docId: this.docId,
                type: opType,
                annotationId: annotation.id,
                annotation,
                queuedAt: nowIso(),
            });
        });

        // 4. Repaint + wake the sync engine.
        this.notifyPage(annotation.page);
        this.notifyMeta();
        this.onDirty?.();
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
