/**
 * Session-local undo/redo of annotation operations, capped at 100 entries.
 * Entries are batches of INVERSE ops (an eraser drag deleting 5 strokes undoes
 * as one step). Undo/redo replay through AnnotationStore.commit, so they
 * persist and sync like any other edit (plan §sync).
 *
 * Batches nest: each `beginBatch` opens its own frame, and `endBatch` closes
 * only that frame. Convert can therefore land as its own Cmd+Z step while an
 * eraser/drag/pinch batch is still open, instead of closing the outer slot.
 */

import type { Annotation } from '@/types/models';

export type UndoableOp =
    | { type: 'create'; annotation: Annotation }
    | { type: 'update'; id: string; annotation: Annotation }
    | { type: 'delete'; id: string }
    | { type: 'restore'; id: string };

const MAX_DEPTH = 100;

export class UndoStack {
    private undoStack: UndoableOp[][] = [];
    private redoStack: UndoableOp[][] = [];
    /** Open batches, innermost last. Inverse ops record into the top frame. */
    private batches: UndoableOp[][] = [];

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
            current.push(op);
            return;
        }
        this.undoStack.push([op]);
        if (this.undoStack.length > MAX_DEPTH) {
            this.undoStack.shift();
        }
    }

    beginBatch(): void {
        this.batches.push([]);
    }

    endBatch(): void {
        const batch = this.batches.pop();
        if (batch && batch.length > 0) {
            this.undoStack.push(batch);
            if (this.undoStack.length > MAX_DEPTH) {
                this.undoStack.shift();
            }
        }
    }

    /** Drop the innermost open batch without recording it (aborted convert). */
    cancelBatch(): void {
        this.batches.pop();
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
}
