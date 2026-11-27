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

interface Entry {
    ops: UndoableOp[];
    pending: number;
    onSettled: (() => void)[];
}

interface OpenBatch extends Entry {
    id: UndoBatchHandle;
}

/** An inverse still to come, held by the entry it will join. */
export interface UndoSlot {
    entry: Entry;
}

/** The entries one Undo press may replay, newest first. */
export interface UndoRequest {
    entries: Entry[];
}

export class UndoStack {
    private undoStack: Entry[] = [];
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
        this.pushEntry({ ops: [op], pending: 0, onSettled: [] });
    }

    /**
     * Hold a place in `handle`'s frame (the innermost when omitted), or null
     * when no frame is open. A closed `handle` gets an entry of its own, so
     * its inverse never lands in another owner's frame.
     */
    reserve(handle?: UndoBatchHandle): UndoSlot | null {
        const frame = this.batches[this.frameIndex(handle)];
        if (frame) {
            frame.pending += 1;
            return { entry: frame };
        }
        if (handle === undefined) {
            return null;
        }
        const entry: Entry = { ops: [], pending: 1, onSettled: [] };
        this.pushEntry(entry);
        return { entry };
    }

    /** Record `op` where `slot` was reserved, or as `pushInverse` would without one. */
    fill(slot: UndoSlot | null, op: UndoableOp): void {
        if (!slot) {
            this.pushInverse(op);
            return;
        }
        this.redoStack = [];
        slot.entry.ops.push(op);
        this.settleOne(slot.entry);
    }

    /** Give up `slot`; a closed entry left with nothing to undo is dropped. */
    release(slot: UndoSlot | null): void {
        if (!slot) {
            return;
        }
        const { entry } = slot;
        if (entry.pending === 1 && entry.ops.length === 0) {
            const idx = this.undoStack.indexOf(entry);
            if (idx !== -1) {
                this.undoStack.splice(idx, 1);
            }
        }
        this.settleOne(entry);
    }

    beginBatch(): UndoBatchHandle {
        const id = this.nextHandle;
        this.nextHandle += 1;
        this.batches.push({ id, ops: [], pending: 0, onSettled: [] });
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
        if (batch && (batch.ops.length > 0 || batch.pending > 0)) {
            this.pushEntry(batch);
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

    /** Snapshot the stack for one Undo press; later pushes are not included. */
    requestUndo(): UndoRequest {
        return { entries: [...this.undoStack].reverse() };
    }

    /**
     * Pop the newest of `request`'s entries still on the stack, once every
     * inverse it holds a place for has landed. Entries pushed after the
     * request, or dropped by `clear`, are never taken.
     */
    async popUndo(request: UndoRequest): Promise<UndoableOp[] | null> {
        for (;;) {
            const entry = request.entries.shift();
            if (!entry) {
                return null;
            }
            while (entry.pending > 0) {
                await new Promise<void>((resolve) => entry.onSettled.push(resolve));
            }
            const idx = this.undoStack.indexOf(entry);
            if (idx !== -1) {
                this.undoStack.splice(idx, 1);
                return entry.ops;
            }
        }
    }

    popRedo(): UndoableOp[] | null {
        return this.redoStack.pop() ?? null;
    }

    pushRedoEntry(ops: UndoableOp[]): void {
        this.redoStack.push(ops);
    }

    pushUndoEntryRaw(ops: UndoableOp[]): void {
        this.pushEntry({ ops, pending: 0, onSettled: [] });
    }

    clear(): void {
        for (const entry of [...this.undoStack, ...this.batches]) {
            entry.pending = 0;
            this.wake(entry);
        }
        this.undoStack = [];
        this.redoStack = [];
        this.batches = [];
    }

    private settleOne(entry: Entry): void {
        entry.pending -= 1;
        if (entry.pending === 0) {
            this.wake(entry);
        }
    }

    private wake(entry: Entry): void {
        for (const resolve of entry.onSettled.splice(0)) {
            resolve();
        }
    }

    private pushEntry(entry: Entry): void {
        this.undoStack.push(entry);
        if (this.undoStack.length > MAX_DEPTH) {
            this.undoStack.shift();
        }
    }

    private frameIndex(handle?: UndoBatchHandle): number {
        if (handle === undefined) {
            return this.batches.length - 1;
        }
        return this.batches.findIndex((batch) => batch.id === handle);
    }
}
