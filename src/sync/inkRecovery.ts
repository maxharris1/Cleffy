import { ensureDayStartingSnapshot } from '@/features/viewer/history/snapshotService';
import { localDateString } from '@/features/viewer/history/snapshotTypes';
import type { LocalAnnotation, PendingOp, ScribblerDb } from '@/sync/db';
import type { Annotation } from '@/types/models';

/**
 * Ink this device could not store (SF-1): local edits whose mirror + outbox
 * write threw — IndexedDB over quota, a closed or blocked database — and that
 * exist only in this tab's memory until a write succeeds.
 *
 * Held here rather than in the AnnotationStore that made them, for three
 * reasons. A store lives as long as one viewer mount: leaving the score and
 * opening it again makes a new one, which must still find them, draw them,
 * and offer Retry. Each edit belongs to the account that made it: entries are
 * keyed by (account, score), so another account signed in later in the same
 * tab neither draws, exports nor retries them, and Retry writes each op under
 * the account it was made by, never the current one. And sign-out, export and
 * the unload guard can see them without any viewer open.
 *
 * Latest wins per mark: an edit of a held mark is written together with the
 * held ops it builds on (persistOps), so once it succeeds none of them is
 * left to override it. A held mark another write on this device has since
 * replaced in the mirror is dropped (supersededBy).
 */

export type CommitOp =
    | { type: 'create'; annotation: Annotation }
    | { type: 'update'; annotation: Annotation; prev: Annotation }
    | { type: 'delete'; annotation: Annotation }
    /** baseDeletedAt: the tombstone being undone — see PendingOp.baseDeletedAt. */
    | { type: 'restore'; annotation: Annotation; baseDeletedAt: string | null };

/** A local edit and the account it was made under (PendingOp.userId), fixed when it was made. */
export interface AuthoredOp {
    op: CommitOp;
    author: string | null;
}

/** What export reads from an open viewer when the database cannot be read (see registerOpenStore). */
export interface OpenStore {
    readonly docId: string;
    readonly authorId: string | null;
    liveAnnotations(): Annotation[];
}

interface RecoveryEntry {
    readonly userId: string | null;
    readonly docId: string;
    db: ScribblerDb;
    /** Held edits, oldest first. */
    ops: AuthoredOp[];
    /** How many held ops each mark has. */
    marks: Map<string, number>;
    /**
     * The live set before the first edit whose day-start snapshot could not
     * be written, and the day it was for: the day's true starting point,
     * written before the held ops on Retry, and used by the next edit instead
     * of a live set that already has the held ones in it.
     */
    startingPoint: { live: Annotation[]; day: string } | null;
    /**
     * Edits of existing marks refused because their day snapshot could not
     * be written (AnnotationStore.commit). Nothing of them is held — they
     * never applied — but the banner says so until storage works again.
     */
    refused: number;
    /** Writes of this entry's ops run one at a time, so a held op is never in two writes at once. */
    chain: Promise<void>;
    touchedAt: number;
}

/** Ops per mirror + outbox transaction: one per row is too slow, one per 30k-op import starves readers. */
export const PERSIST_CHUNK = 4000;

/**
 * Scores with held ink kept at once. Past it the score touched longest ago
 * that no viewer has open goes, with a warning: only a reload would free it
 * otherwise, and each can hold a whole import.
 */
export const MAX_HELD_SCORES = 20;

/** Held ops across every score before the oldest unopened scores go (see MAX_HELD_SCORES). */
export const MAX_HELD_OPS = 100_000;

const entries = new Map<string, RecoveryEntry>();
const listeners = new Set<() => void>();
const openStores = new Set<OpenStore>();
let clock = 0;
/** Local edits applied in memory whose write has not finished (AnnotationStore.hasUnsavedEdit). */
let inFlight = 0;

const keyOf = (userId: string | null, docId: string): string => JSON.stringify([userId, docId]);

const entryFor = (userId: string | null, docId: string): RecoveryEntry | undefined => entries.get(keyOf(userId, docId));

const ensureEntry = (db: ScribblerDb, userId: string | null, docId: string): RecoveryEntry => {
    const key = keyOf(userId, docId);
    let entry = entries.get(key);
    if (!entry) {
        entry = {
            userId,
            docId,
            db,
            ops: [],
            marks: new Map(),
            startingPoint: null,
            refused: 0,
            chain: Promise.resolve(),
            touchedAt: ++clock,
        };
        entries.set(key, entry);
    }
    entry.db = db;
    entry.touchedAt = ++clock;
    return entry;
};

/** Drop an entry with nothing left to hold or say. */
const pruneEntry = (entry: RecoveryEntry): void => {
    if (entry.ops.length === 0 && !entry.startingPoint && entry.refused === 0) {
        if (entries.get(keyOf(entry.userId, entry.docId)) === entry) {
            entries.delete(keyOf(entry.userId, entry.docId));
        }
    }
};

const changed = (): void => {
    syncUnloadGuard();
    for (const listener of listeners) {
        listener();
    }
};

/** Told whenever held ink, or a refused edit, is added or goes. */
export const subscribeInkRecovery = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/** The marks with held ops for this account on this score. */
export const heldMarkIds = (userId: string | null, docId: string): ReadonlySet<string> => {
    const entry = entryFor(userId, docId);
    return entry ? new Set(entry.marks.keys()) : EMPTY_IDS;
};

export const isHeld = (userId: string | null, docId: string, id: string): boolean =>
    entryFor(userId, docId)?.marks.has(id) ?? false;

/** How many marks have held ops for this account on this score. */
export const heldMarkCount = (userId: string | null, docId: string): number => entryFor(userId, docId)?.marks.size ?? 0;

/** Edits refused for want of a day snapshot (see RecoveryEntry.refused). */
export const refusedEditCount = (userId: string | null, docId: string): number => entryFor(userId, docId)?.refused ?? 0;

/**
 * The newest held version of each of this account's marks on this score —
 * tombstones included, so an erase that failed to save still leaves the mark
 * out of an export.
 */
export const heldMarksFor = (userId: string | null, docId: string): Annotation[] => {
    const entry = entryFor(userId, docId);
    if (!entry) {
        return [];
    }
    const latest = new Map<string, Annotation>();
    for (const { op } of entry.ops) {
        latest.set(op.annotation.id, op.annotation);
    }
    return [...latest.values()];
};

/**
 * Marks with held ops on scores of this account, for the sign-out warning.
 * Device-only scores (no account) are left out: sign-out does not clear them.
 */
export const unsavedMarkCount = (userId?: string | null): number => {
    let count = 0;
    for (const entry of entries.values()) {
        if (entry.userId !== null && (userId === undefined || entry.userId === userId)) {
            count += entry.marks.size;
        }
    }
    return count;
};

/**
 * A mirror row a later write on this device made (still queued, and newer
 * than the held version): it replaces the held one, so a stale failed edit,
 * or a failed erase, never overrides it. A row from the server does not:
 * local intent wins until it uploads, as everywhere in the store.
 */
export const supersededBy = (held: Annotation, row: LocalAnnotation | undefined): boolean =>
    !!row && row.pending === 1 && row.updatedAt > held.updatedAt;

/** Forget these marks' held ops (superseded; see supersededBy). */
export const evictHeldMarks = (userId: string | null, docId: string, ids: Iterable<string>): void => {
    const entry = entryFor(userId, docId);
    if (!entry) {
        return;
    }
    const gone = new Set([...ids].filter((id) => entry.marks.has(id)));
    if (gone.size === 0) {
        return;
    }
    entry.ops = entry.ops.filter((held) => !gone.has(held.op.annotation.id));
    gone.forEach((id) => entry.marks.delete(id));
    pruneEntry(entry);
    changed();
};

/** The day-start snapshot an earlier failed edit still owes today, if any (see RecoveryEntry.startingPoint). */
export const owedStartingPoint = (userId: string | null, docId: string): Annotation[] | null => {
    const entry = entryFor(userId, docId);
    if (!entry?.startingPoint) {
        return null;
    }
    if (entry.startingPoint.day !== localDateString()) {
        // Yesterday's: today's starting point is today's live set.
        entry.startingPoint = null;
        pruneEntry(entry);
        return null;
    }
    return entry.startingPoint.live;
};

/** The day's snapshot is written (or another tab wrote it): nothing is owed, and storage works again. */
export const startingPointWritten = (userId: string | null, docId: string): void => {
    const entry = entryFor(userId, docId);
    if (!entry || (!entry.startingPoint && entry.refused === 0)) {
        return;
    }
    entry.startingPoint = null;
    entry.refused = 0;
    pruneEntry(entry);
    changed();
};

/** Hold ops whose write failed. `startingPoint`: the day snapshot that failed with them, when one did. */
export const holdOps = (
    db: ScribblerDb,
    docId: string,
    ops: AuthoredOp[],
    startingPoint: Annotation[] | null = null,
): void => {
    if (ops.length === 0) {
        return;
    }
    const byAuthor = new Map<string | null, AuthoredOp[]>();
    for (const held of ops) {
        byAuthor.set(held.author, [...(byAuthor.get(held.author) ?? []), held]);
    }
    for (const [author, authored] of byAuthor) {
        const entry = ensureEntry(db, author, docId);
        for (const held of authored) {
            appendHeld(entry, held);
        }
        if (startingPoint && !entry.startingPoint) {
            entry.startingPoint = { live: startingPoint, day: localDateString() };
        }
    }
    enforceCap();
    changed();
};

/**
 * Append one op. A run of updates to one mark keeps only the newest (each
 * carries the whole mark), so dragging a held text note does not grow the
 * entry by an op per frame. The replacement is a new object: a write already
 * carrying the older one releases that one, and this one stays held.
 */
const appendHeld = (entry: RecoveryEntry, held: AuthoredOp): void => {
    const { id } = held.op.annotation;
    if (held.op.type === 'update' && entry.marks.has(id)) {
        for (let i = entry.ops.length - 1; i >= 0; i--) {
            const prior = entry.ops[i];
            if (prior?.op.annotation.id !== id) {
                continue;
            }
            if (prior.op.type === 'update' && prior.author === held.author) {
                entry.ops[i] = { author: held.author, op: { ...held.op, prev: prior.op.prev } };
                return;
            }
            break;
        }
    }
    entry.ops.push(held);
    entry.marks.set(id, (entry.marks.get(id) ?? 0) + 1);
};

/** Held ops written: they leave the entry (by identity — see appendHeld). */
const releaseHeld = (entry: RecoveryEntry, written: readonly AuthoredOp[]): void => {
    const done = new Set(written);
    const kept: AuthoredOp[] = [];
    for (const held of entry.ops) {
        if (!done.has(held)) {
            kept.push(held);
            continue;
        }
        const { id } = held.op.annotation;
        const left = (entry.marks.get(id) ?? 1) - 1;
        if (left > 0) {
            entry.marks.set(id, left);
        } else {
            entry.marks.delete(id);
        }
    }
    entry.ops = kept;
};

/** A day snapshot that failed for an edit of an existing mark, which was refused (see RecoveryEntry.refused). */
export const noteRefusedEdit = (
    db: ScribblerDb,
    userId: string | null,
    docId: string,
    startingPoint: Annotation[],
): void => {
    const entry = ensureEntry(db, userId, docId);
    entry.refused += 1;
    entry.startingPoint ??= { live: startingPoint, day: localDateString() };
    changed();
};

/** One atomic mirror + outbox write, each op stamped with its own author. */
const writeOps = async (db: ScribblerDb, docId: string, slice: readonly AuthoredOp[]): Promise<void> => {
    const rows: LocalAnnotation[] = slice.map(({ op }) => ({ ...op.annotation, pending: 1 }));
    const queuedAt = new Date().toISOString();
    const opRows = slice.map(({ op, author }): PendingOp => ({
        docId,
        type: op.type,
        annotationId: op.annotation.id,
        annotation: op.annotation,
        queuedAt,
        ...(op.type === 'restore' ? { baseDeletedAt: op.baseDeletedAt } : {}),
        ...(author ? { userId: author } : {}),
    }));
    await db.transaction('rw', db.annotations, db.ops, async () => {
        await db.annotations.bulkPut(rows);
        await db.ops.bulkAdd(opRows);
    });
};

/**
 * Write a store's edits, made by `author`: the durable mirror + outbox,
 * atomically per chunk. An edit of a mark with held ops goes out behind
 * them, in the same write, so the outbox never has a mark's newer op without
 * the older one it builds on, and once it lands nothing older is held to
 * override it. What could not be written is held, and the error rethrown.
 */
export const persistOps = (db: ScribblerDb, author: string | null, docId: string, ops: CommitOp[]): Promise<void> => {
    const fresh = ops.map((op): AuthoredOp => ({ op, author }));
    const entry = entryFor(author, docId);
    if (!entry) {
        return writeQueue(db, author, docId, [], fresh);
    }
    const run = entry.chain.then(() => {
        const ids = new Set(ops.map((op) => op.annotation.id));
        const current = entryFor(author, docId);
        const carried = current ? current.ops.filter((held) => ids.has(held.op.annotation.id)) : [];
        return writeQueue(db, author, docId, carried, fresh);
    });
    entry.chain = run.catch(() => undefined);
    return run;
};

const writeQueue = async (
    db: ScribblerDb,
    author: string | null,
    docId: string,
    carried: AuthoredOp[],
    fresh: AuthoredOp[],
): Promise<void> => {
    const queue = [...carried, ...fresh];
    let written = 0;
    try {
        for (; written < queue.length; written += PERSIST_CHUNK) {
            const chunk = queue.slice(written, written + PERSIST_CHUNK);
            await writeOps(db, docId, chunk);
            const entry = entryFor(author, docId);
            if (entry && carried.length > 0) {
                releaseHeld(entry, chunk);
                pruneEntry(entry);
                changed();
            }
        }
    } catch (err) {
        // Chunks before this one committed; this one rolled back whole. The
        // carried ops it had are still held; the fresh ones join them.
        const carriedSet = new Set(carried);
        holdOps(
            db,
            docId,
            queue.slice(written).filter((held) => !carriedSet.has(held)),
        );
        throw err;
    }
};

export interface RetryResult {
    /** Every held op, and any owed day snapshot, is written. */
    ok: boolean;
    /** Marks whose held ops this retry wrote. */
    wrote: string[];
}

/**
 * Write this account's held ops on this score again, oldest first, after the
 * day snapshot they owe. Each op goes out under the account that made it.
 * `ok` false: a write failed again, and what was not written is still held.
 */
export const retryHeld = (userId: string | null, docId: string): Promise<RetryResult> => {
    const entry = entryFor(userId, docId);
    if (!entry) {
        return Promise.resolve({ ok: true, wrote: [] });
    }
    const run = entry.chain.then(() => writeHeld(entry));
    entry.chain = run.then(() => undefined);
    return run;
};

const writeHeld = async (entry: RecoveryEntry): Promise<RetryResult> => {
    if (entries.get(keyOf(entry.userId, entry.docId)) !== entry) {
        // Cleared while it waited (sign-out): nothing of it may be written now.
        return { ok: true, wrote: [] };
    }
    const wrote: string[] = [];
    let ok = true;
    try {
        const owed = owedStartingPoint(entry.userId, entry.docId);
        if (owed) {
            await ensureDayStartingSnapshot(entry.db, entry.docId, owed);
        }
        entry.startingPoint = null;
        entry.refused = 0;
        // Ops held meanwhile only ever join at the end.
        while (entry.ops.length > 0) {
            const chunk = entry.ops.slice(0, PERSIST_CHUNK).filter((held) => held.author === entry.userId);
            if (chunk.length === 0) {
                break;
            }
            await writeOps(entry.db, entry.docId, chunk);
            releaseHeld(entry, chunk);
            wrote.push(...chunk.map((held) => held.op.annotation.id));
        }
    } catch (err) {
        console.warn('Retrying the unsaved marks failed', err);
        ok = false;
    }
    pruneEntry(entry);
    changed();
    return { ok, wrote: [...new Set(wrote)] };
};

/**
 * Write every held op of this account's, on every score (retryHeld), before
 * a sign-out that keeps the account's queued changes for its next sign-in
 * (signOutKeepingChanges): written, they are kept with the rest. Never throws.
 */
export const retryAccountInk = async (userId: string): Promise<void> => {
    const docs = [...entries.values()].filter((entry) => entry.userId === userId).map((entry) => entry.docId);
    for (const docId of docs) {
        await retryHeld(userId, docId);
    }
};

/**
 * Sign-out: forget every account's held ink and refused edits (the signed-out
 * account's, after its warning; any other account's left from before). The
 * next account in this tab must not see, export or retry them. Device-only
 * scores' entries stay, as their marks do.
 */
export const clearAccountInk = (): void => {
    let any = false;
    for (const [key, entry] of entries) {
        if (entry.userId !== null) {
            entries.delete(key);
            any = true;
        }
    }
    if (any) {
        changed();
    }
};

/** The score is closed for good on this device (deleted, left, access taken back): its held ink goes. */
export const forgetDocInk = (docId: string): void => {
    let any = false;
    for (const [key, entry] of entries) {
        if (entry.docId === docId) {
            entries.delete(key);
            any = true;
        }
    }
    if (any) {
        changed();
    }
};

/** Keep the registry bounded (MAX_HELD_SCORES, MAX_HELD_OPS), sparing scores a viewer has open. */
const enforceCap = (): void => {
    const total = () => [...entries.values()].reduce((sum, entry) => sum + entry.ops.length, 0);
    if (entries.size <= MAX_HELD_SCORES && total() <= MAX_HELD_OPS) {
        return;
    }
    const open = new Set([...openStores].map((store) => keyOf(store.authorId, store.docId)));
    const oldestFirst = [...entries.entries()]
        .filter(([key]) => !open.has(key))
        .sort(([, a], [, b]) => a.touchedAt - b.touchedAt);
    for (const [key, entry] of oldestFirst) {
        if (entries.size <= MAX_HELD_SCORES && total() <= MAX_HELD_OPS) {
            break;
        }
        console.warn(`Dropping ${entry.marks.size} unsaved marks on a score not open, to bound memory`);
        entries.delete(key);
    }
};

/**
 * An open viewer's store: export reads its memory when the database cannot
 * be read (see openMarksFor), and the cap spares its score. Returns the
 * unregister, for the viewer's unmount.
 */
export const registerOpenStore = (store: OpenStore): (() => void) => {
    openStores.add(store);
    return () => {
        openStores.delete(store);
    };
};

/**
 * Every live mark an open viewer of this score draws for this account, held
 * ones included, or null when none is open — what export falls back on when
 * the database cannot be read.
 */
export const openMarksFor = (userId: string | null, docId: string): Annotation[] | null => {
    for (const store of openStores) {
        if (store.docId === docId && store.authorId === userId) {
            return store.liveAnnotations();
        }
    }
    return null;
};

/** A local edit started (+1) or finished (-1) its write (see hasUnsavedInk). */
export const noteEditsInFlight = (delta: number): void => {
    inFlight = Math.max(0, inFlight + delta);
    syncUnloadGuard();
};

/** Ink a reload or closing the tab would lose: a write still on its way, or held. */
export const hasUnsavedInk = (): boolean => inFlight > 0 || [...entries.values()].some((e) => e.ops.length > 0);

const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    // The browser shows its own "leave site?" prompt; the text is not used.
    event.preventDefault();
    event.returnValue = true;
};

let guarded = false;

/**
 * Ask before the tab unloads while hasUnsavedInk. Attached only then: an
 * unload listener can keep a page out of the back-forward cache.
 */
const syncUnloadGuard = (): void => {
    if (typeof window === 'undefined') {
        return;
    }
    const need = hasUnsavedInk();
    if (need === guarded) {
        return;
    }
    guarded = need;
    if (need) {
        window.addEventListener('beforeunload', onBeforeUnload);
    } else {
        window.removeEventListener('beforeunload', onBeforeUnload);
    }
};

/** Tests: start from an empty registry. */
export const resetInkRecoveryForTests = (): void => {
    entries.clear();
    openStores.clear();
    inFlight = 0;
    changed();
};

const EMPTY_IDS: ReadonlySet<string> = new Set();
