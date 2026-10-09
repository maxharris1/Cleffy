/**
 * Session-local undo/redo of annotation operations, capped at 100 entries.
 * Entries are batches of INVERSE ops (an eraser drag deleting 5 strokes undoes
 * as one step). Undo/redo replay through AnnotationStore.commit, so they
 * persist and sync like any other edit (plan §sync).
 *
 * Batches nest and are owned: `beginBatch` returns a handle, and
 * `endBatch`/`cancelBatch` close only that frame — even when it is not
 * innermost. Convert can therefore land as its own Cmd+Z step while an
 * eraser/drag/pinch batch is still open, and an outer `endBatch` cannot
 * steal convert's frame.
 */

import type { Annotation } from '@/types/models';

export type UndoableOp =
    | { type: 'create'; annotation: Annotation }
    | { type: 'update'; id: string; annotation: Annotation }
    | { type: 'delete'; id: string }
    | { type: 'restore'; id: string };

/** Identifies one open undo frame. Only the caller that opened it may close it. */
export type UndoBatchHandle = number;

const MAX_DEPTH = 100;

interface OpenBatch {
    id: UndoBatchHandle;
    ops: UndoableOp[];
}

export class UndoStack {
    private undoStack: UndoableOp[][] = [];
    private redoStack: UndoableOp[][] = [];
    /** Open batches, innermost last. Inverse ops record into the top frame. */
    private batches: OpenBatch[] = [];
    private nextHandle: UndoBatchHandle = 1;

    get canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    get canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    /** Record the inverse of a user op. Clears the redo stack. */
    pushInverse(op: UndoableOp): void {
        this.redoStack = [];
        const current = this.batches[this.batches.length - 1];
        if (current) {
            current.ops.push(op);
            return;
        }
        this.undoStack.push([op]);
        if (this.undoStack.length > MAX_DEPTH) {
            this.undoStack.shift();
        }
    }

    beginBatch(): UndoBatchHandle {
        const id = this.nextHandle;
        this.nextHandle += 1;
        this.batches.push({ id, ops: [] });
        return id;
    }

    /**
     * Close `handle`'s frame. When omitted, closes the innermost (callers that
     * still use the untokened API). A missing handle is a no-op — never pop
     * someone else's frame.
     */
    endBatch(handle?: UndoBatchHandle): void {
        const idx = this.frameIndex(handle);
        if (idx === -1) {
            return;
        }
        const batch = this.batches.splice(idx, 1)[0];
        if (batch && batch.ops.length > 0) {
            this.undoStack.push(batch.ops);
            if (this.undoStack.length > MAX_DEPTH) {
                this.undoStack.shift();
            }
        }
    }

    /** Drop `handle`'s frame without recording it (aborted convert). */
    cancelBatch(handle?: UndoBatchHandle): void {
        const idx = this.frameIndex(handle);
        if (idx === -1) {
            return;
        }
        this.batches.splice(idx, 1);
    }

    /** Pop the ops to replay for undo; push their redo counterparts via fn. */
    popUndo(): UndoableOp[] | null {
        return this.undoStack.pop() ?? null;
    }

    popRedo(): UndoableOp[] | null {
        return this.redoStack.pop() ?? null;
    }

    pushRedoEntry(ops: UndoableOp[]): void {
        this.redoStack.push(ops);
    }

    pushUndoEntryRaw(ops: UndoableOp[]): void {
        this.undoStack.push(ops);
        if (this.undoStack.length > MAX_DEPTH) {
            this.undoStack.shift();
        }
    }

    clear(): void {
        this.undoStack = [];
        this.redoStack = [];
        this.batches = [];
    }

    private frameIndex(handle?: UndoBatchHandle): number {
        if (handle === undefined) {
            return this.batches.length - 1;
        }
        return this.batches.findIndex((batch) => batch.id === handle);
    }
}
