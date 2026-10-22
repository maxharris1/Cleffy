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
 * left to override it. A held mark that a newer version has overtaken since
 * (another tab's edit, stored or uploaded; a collaborator's, on the server)
 * is never written over it: it leaves Retry and stays for Export only, as a
 * conflict (see overtakes).
 *
 * Every write is bound to its account's epoch (see epochOf): sign-out moves
 * it on, and any write of that account's still on its way — a Retry spanning
 * the sign-out, a chunk of a long write, one stalled behind a blocked
 * database — then writes nothing, checked inside its own transaction.
 */

export type CommitOp =
    | { type: 'create'; annotation: Annotation }
    | { type: 'update'; annotation: Annotation; prev: Annotation }
    /** prev: the mark before the erase (what a newer version is told from; see baseOf). */
    | { type: 'delete'; annotation: Annotation; prev?: Annotation }
    /** baseDeletedAt: the tombstone being undone — see PendingOp.baseDeletedAt. prev: that tombstone. */
    | { type: 'restore'; annotation: Annotation; baseDeletedAt: string | null; prev?: Annotation };

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
    /** Its account's held ink was cleared (sign-out, here or in another tab): forget what it drew of it. */
    accountInkCleared(): void;
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
     * The newest held version of marks a newer version overtook before they
     * could be written (see overtakes): never written over it, so out of
     * Retry, but this account's own edit all the same — Export keeps it.
     */
    conflicts: Map<string, Annotation>;
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
    /**
     * Edits not made because holding them would pass MAX_HELD_SCORES or
     * MAX_HELD_OPS (see admits): undone on screen, and said so, never held
     * by dropping something older.
     */
    overflow: number;
    /** Writes of this entry's ops run one at a time, so a held op is never in two writes at once. */
    chain: Promise<void>;
}

/** Ops per mirror + outbox transaction: one per row is too slow, one per 30k-op import starves readers. */
export const PERSIST_CHUNK = 4000;

/**
 * Scores with held ink (or a refused edit) kept at once, open ones included.
 * Past it a new score's failed edits are not held but undone, with the
 * banner and Export (see admits): nothing already held is ever dropped to
 * make room, since memory is its only copy.
 */
export const MAX_HELD_SCORES = 20;

/**
 * Held marks across every score — ops, owed starting points and conflicts
 * alike — before new failed edits are undone instead of held (see MAX_HELD_SCORES).
 */
export const MAX_HELD_OPS = 100_000;

/** How long Retry waits on the server for the marks' current versions before it goes on without them. */
export const SERVER_CHECK_TIMEOUT_MS = 3000;

const entries = new Map<string, RecoveryEntry>();
const listeners = new Set<() => void>();
const openStores = new Set<OpenStore>();
/** Per account, moved on whenever its held ink is cleared (see epochOf). */
const epochs = new Map<string | null, number>();
/** Local edits applied in memory whose write has not finished (AnnotationStore.hasUnsavedEdit). */
let inFlight = 0;

const keyOf = (userId: string | null, docId: string): string => JSON.stringify([userId, docId]);

const entryFor = (userId: string | null, docId: string): RecoveryEntry | undefined => entries.get(keyOf(userId, docId));

/**
 * The account's write epoch. A write captures it when it starts, and writes
 * nothing once it has moved on (clearAccountInk): sign-out, here or in
 * another tab, ends every write of that account's still on its way.
 */
const epochOf = (userId: string | null): number => {
    if (!epochs.has(userId)) {
        epochs.set(userId, 0);
    }
    return epochs.get(userId) ?? 0;
};

/**
 * A write's guard: true while `userId`'s epoch is still the one it was
 * when this was called. A store takes it when an edit is made (persistOps).
 */
export const boundTo = (userId: string | null): (() => boolean) => {
    const epoch = epochOf(userId);
    return () => epochOf(userId) === epoch;
};

/** A write its account's sign-out overtook: it wrote nothing, and nothing of it is held. */
export class RecoveryCancelled extends Error {
    constructor() {
        super('The account signed out before this could be written');
        this.name = 'RecoveryCancelled';
    }
}

/**
 * Failed edits that could not be held either: holding them would pass the
 * registry's bounds (see admits). Nothing of them is written or held, so the
 * store undoes them on screen; the banner says so and offers Export.
 */
export class HeldInkFull extends Error {
    constructor(
        readonly ops: CommitOp[],
        readonly cause: unknown,
    ) {
        super('Too many unsaved marks on this device to keep another');
        this.name = 'HeldInkFull';
    }
}

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
            conflicts: new Map(),
            startingPoint: null,
            refused: 0,
            overflow: 0,
            chain: Promise.resolve(),
        };
        entries.set(key, entry);
    }
    entry.db = db;
    return entry;
};

/** Drop an entry with nothing left to hold or say. */
const pruneEntry = (entry: RecoveryEntry): void => {
    if (
        entry.ops.length === 0 &&
        entry.conflicts.size === 0 &&
        !entry.startingPoint &&
        entry.refused === 0 &&
        entry.overflow === 0
    ) {
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

/** Edits undone because the registry was full (see RecoveryEntry.overflow). */
export const overflowCount = (userId: string | null, docId: string): number => entryFor(userId, docId)?.overflow ?? 0;

/** Held marks a newer version overtook: Export only (see RecoveryEntry.conflicts). */
export const conflictCount = (userId: string | null, docId: string): number =>
    entryFor(userId, docId)?.conflicts.size ?? 0;

/** This account's held versions of overtaken marks on this score, tombstones included. */
export const conflictMarksFor = (userId: string | null, docId: string): Annotation[] => [
    ...(entryFor(userId, docId)?.conflicts.values() ?? []),
];

/** The user has seen the conflicts, and exported them or not: they go (the banner's Dismiss). */
export const dismissConflicts = (userId: string | null, docId: string): void => {
    const entry = entryFor(userId, docId);
    if (!entry || entry.conflicts.size === 0) {
        return;
    }
    entry.conflicts.clear();
    pruneEntry(entry);
    changed();
};

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

/** Each held mark's base (see baseOf) and newest held version: what overtakes() weighs a row against. */
export const heldChainsFor = (
    userId: string | null,
    docId: string,
): Map<string, { base: Annotation | null; latest: Annotation }> => {
    const entry = entryFor(userId, docId);
    return entry ? chainsOf(entry.ops) : new Map();
};

const chainsOf = (ops: readonly AuthoredOp[]): Map<string, { base: Annotation | null; latest: Annotation }> => {
    const chains = new Map<string, { base: Annotation | null; latest: Annotation }>();
    for (const { op } of ops) {
        const chain = chains.get(op.annotation.id);
        if (chain) {
            chain.latest = op.annotation;
        } else {
            chains.set(op.annotation.id, { base: baseOf(op), latest: op.annotation });
        }
    }
    return chains;
};

/**
 * Marks with held ops (or held conflicts) on scores of this account, for the
 * sign-out warning. Device-only scores (no account) are left out: sign-out
 * does not clear them.
 */
export const unsavedMarkCount = (userId?: string | null): number => {
    let count = 0;
    for (const entry of entries.values()) {
        if (entry.userId !== null && (userId === undefined || entry.userId === userId)) {
            count += entry.marks.size + entry.conflicts.size;
        }
    }
    return count;
};

/** Scores of this account's with held ink (or held conflicts), for the ended-sign-in prompt. */
export const heldDocIds = (userId: string): string[] =>
    [...entries.values()]
        .filter((entry) => entry.userId === userId && entry.marks.size + entry.conflicts.size > 0)
        .map((entry) => entry.docId);

/**
 * The version a mark's first held op was made on — what writing it would
 * replace — or null for a mark the held ops create.
 */
export const baseOf = (op: CommitOp): Annotation | null => {
    switch (op.type) {
        case 'create':
            return null;
        case 'update':
            return op.prev;
        case 'delete':
            return op.prev ?? { ...op.annotation, deletedAt: null };
        case 'restore':
            return op.prev ?? { ...op.annotation, deletedAt: op.baseDeletedAt };
        default: {
            const _exhaustive: never = op;
            return _exhaustive;
        }
    }
};

/**
 * JSON with object keys in one order: jsonb does not keep the order a
 * payload was sent in (as syncEngine's canonicalJson).
 */
const canonicalJson = (value: unknown): string =>
    JSON.stringify(value, (_key, v: unknown) =>
        v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
            : v,
    );

/** What a version of a mark shows: where, what, and whether it is erased. */
const contentOf = (a: Annotation): string => canonicalJson([a.page, a.kind, a.color, a.payload, !!a.deletedAt]);

/**
 * Whether `row` — the mirror's or the server's copy of a held mark — is a
 * version made since the held edits' `base` that is newer than them, so the
 * held ones must not be written over it (or, for an erase, hide it).
 *
 * The same content as the base (nothing changed since; an echo of this
 * device's own earlier write) or as the held version (already there) is
 * not. A row the server has numbered past the base (seq) is: a collaborator's
 * edit, or another tab's that has uploaded. A row on the same seq with other
 * content is another tab's local edit on the same server version, ordered by
 * this device's own clock. A row numbered below the base is an older copy.
 * A held create has no base: no other version of a new mark can exist.
 */
export const overtakes = (row: Annotation | undefined, base: Annotation | null, latest: Annotation): boolean => {
    if (!row || !base) {
        return false;
    }
    const content = contentOf(row);
    if (content === contentOf(base) || content === contentOf(latest)) {
        return false;
    }
    if (row.seq !== base.seq) {
        return row.seq > base.seq;
    }
    return row.updatedAt > latest.updatedAt;
};

/**
 * These rows (the mirror's, or the server's) overtook some of the account's
 * held marks: those leave Retry for Export (RecoveryEntry.conflicts), and
 * their ids are returned for the store to draw the newer version.
 */
export const settleOvertaken = (
    userId: string | null,
    docId: string,
    rows: ReadonlyMap<string, Annotation | undefined>,
): string[] => {
    const entry = entryFor(userId, docId);
    if (!entry) {
        return [];
    }
    const overtaken = [...chainsOf(entry.ops)]
        .filter(([id, { base, latest }]) => overtakes(rows.get(id), base, latest))
        .map(([id]) => id);
    moveToConflicts(entry, overtaken);
    return overtaken;
};

const moveToConflicts = (entry: RecoveryEntry, ids: Iterable<string>): void => {
    const gone = new Set([...ids].filter((id) => entry.marks.has(id)));
    if (gone.size === 0) {
        return;
    }
    const kept: AuthoredOp[] = [];
    for (const held of entry.ops) {
        if (gone.has(held.op.annotation.id)) {
            entry.conflicts.set(held.op.annotation.id, held.op.annotation);
        } else {
            kept.push(held);
        }
    }
    entry.ops = kept;
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

/** Everything held across every score, by the measure of MAX_HELD_OPS. */
const heldWeight = (): number => {
    let total = 0;
    for (const entry of entries.values()) {
        total += entry.ops.length + entry.conflicts.size + (entry.startingPoint?.live.length ?? 0);
    }
    return total;
};

/** Scores holding anything, by the measure of MAX_HELD_SCORES (an entry with only `overflow` holds nothing). */
const heldScores = (): number =>
    [...entries.values()].filter(
        (entry) => entry.ops.length + entry.conflicts.size > 0 || entry.startingPoint || entry.refused > 0,
    ).length;

/**
 * Whether `adding` more held marks fit for this account's score: the bounds
 * apply to every score, open or not, refused-only or not. Nothing already
 * held is ever dropped to make room.
 */
const admits = (userId: string | null, docId: string, adding: number): boolean => {
    const entry = entryFor(userId, docId);
    const holding = !!entry && (entry.ops.length + entry.conflicts.size > 0 || !!entry.startingPoint || entry.refused > 0);
    if (!holding && heldScores() >= MAX_HELD_SCORES) {
        return false;
    }
    return heldWeight() + adding <= MAX_HELD_OPS;
};

/**
 * Hold ops whose write failed. `startingPoint`: the day snapshot that failed
 * with them, when one did. Returns the ops it could not hold (see admits):
 * the caller undoes them on screen; their score's banner says so.
 */
export const holdOps = (
    db: ScribblerDb,
    docId: string,
    ops: AuthoredOp[],
    startingPoint: Annotation[] | null = null,
): AuthoredOp[] => {
    if (ops.length === 0) {
        return [];
    }
    const byAuthor = new Map<string | null, AuthoredOp[]>();
    for (const held of ops) {
        const authored = byAuthor.get(held.author);
        if (authored) {
            authored.push(held);
        } else {
            byAuthor.set(held.author, [held]);
        }
    }
    const refused: AuthoredOp[] = [];
    for (const [author, authored] of byAuthor) {
        const owes = startingPoint && !entryFor(author, docId)?.startingPoint ? startingPoint : null;
        if (!admits(author, docId, authored.length + (owes?.length ?? 0))) {
            ensureEntry(db, author, docId).overflow += new Set(authored.map((held) => held.op.annotation.id)).size;
            refused.push(...authored);
            continue;
        }
        const entry = ensureEntry(db, author, docId);
        for (const held of authored) {
            appendHeld(entry, held);
        }
        if (owes) {
            entry.startingPoint = { live: owes, day: localDateString() };
        }
    }
    if (refused.length > 0) {
        console.warn(`Too many unsaved marks on this device: ${refused.length} new edits were not kept`);
    }
    changed();
    return refused;
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
    // A newer edit of a mark held as a conflict is the user's latest word on it.
    entry.conflicts.delete(id);
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
    if (kept.length === 0) {
        // Room again: new failed edits can be held.
        entry.overflow = 0;
    }
};

/**
 * A day snapshot that failed for an edit of an existing mark, which was
 * refused (see RecoveryEntry.refused). Its starting point is kept only when
 * it fits (see admits); the edit was refused either way.
 */
export const noteRefusedEdit = (
    db: ScribblerDb,
    userId: string | null,
    docId: string,
    startingPoint: Annotation[],
): void => {
    const fits = admits(userId, docId, entryFor(userId, docId)?.startingPoint ? 0 : startingPoint.length);
    const entry = ensureEntry(db, userId, docId);
    entry.refused += 1;
    if (fits) {
        entry.startingPoint ??= { live: startingPoint, day: localDateString() };
    }
    changed();
};

/**
 * One atomic mirror + outbox write, each op stamped with its own author.
 * `live` is checked inside the transaction, before and between its writes:
 * once the account's epoch has moved on (sign-out), it throws and the whole
 * transaction rolls back. `check`, given the chunk's current mirror rows,
 * names marks a newer version has overtaken (see overtakes): their ops are
 * left out. Returns what it wrote and what it left out.
 */
const writeOps = async (
    db: ScribblerDb,
    docId: string,
    slice: readonly AuthoredOp[],
    live: () => boolean,
    check?: (rows: ReadonlyMap<string, LocalAnnotation | undefined>) => Set<string>,
): Promise<{ written: AuthoredOp[]; overtaken: Set<string> }> =>
    db.transaction('rw', db.annotations, db.ops, async () => {
        if (!live()) {
            throw new RecoveryCancelled();
        }
        let overtaken = new Set<string>();
        if (check) {
            const ids = [...new Set(slice.map((held) => held.op.annotation.id))];
            const found = await db.annotations.bulkGet(ids);
            overtaken = check(new Map(ids.map((id, i) => [id, found[i]])));
        }
        const written = slice.filter((held) => !overtaken.has(held.op.annotation.id));
        const rows: LocalAnnotation[] = written.map(({ op }) => ({ ...op.annotation, pending: 1 }));
        const queuedAt = new Date().toISOString();
        const opRows = written.map(({ op, author }): PendingOp => ({
            docId,
            type: op.type,
            annotationId: op.annotation.id,
            annotation: op.annotation,
            queuedAt,
            ...(op.type === 'restore' ? { baseDeletedAt: op.baseDeletedAt } : {}),
            ...(author ? { userId: author } : {}),
        }));
        await db.annotations.bulkPut(rows);
        if (!live()) {
            throw new RecoveryCancelled();
        }
        await db.ops.bulkAdd(opRows);
        return { written, overtaken };
    });

/**
 * Write a store's edits, made by `author`: the durable mirror + outbox,
 * atomically per chunk. An edit of a mark with held ops goes out behind
 * them, in the same write, so the outbox never has a mark's newer op without
 * the older one it builds on, and once it lands nothing older is held to
 * override it. What could not be written is held, and the error rethrown —
 * or, past the registry's bounds, HeldInkFull names what was not held.
 * Bound to the author's epoch as it was when the edit was made (`live`,
 * from boundTo; else from the call): a sign-out before it runs, or between
 * its chunks, ends it with RecoveryCancelled, writing and holding nothing
 * more.
 */
export const persistOps = (
    db: ScribblerDb,
    author: string | null,
    docId: string,
    ops: CommitOp[],
    live: () => boolean = boundTo(author),
): Promise<void> => {
    const fresh = ops.map((op): AuthoredOp => ({ op, author }));
    const entry = entryFor(author, docId);
    if (!entry) {
        return writeQueue(db, author, docId, [], fresh, live);
    }
    const run = entry.chain.then(() => {
        const ids = new Set(ops.map((op) => op.annotation.id));
        const current = entryFor(author, docId);
        const carried = current ? current.ops.filter((held) => ids.has(held.op.annotation.id)) : [];
        return writeQueue(db, author, docId, carried, fresh, live);
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
    live: () => boolean,
): Promise<void> => {
    const queue = [...carried, ...fresh];
    let written = 0;
    try {
        if (!live()) {
            throw new RecoveryCancelled();
        }
        for (; written < queue.length; written += PERSIST_CHUNK) {
            const chunk = queue.slice(written, written + PERSIST_CHUNK);
            await writeOps(db, docId, chunk, live);
            const entry = entryFor(author, docId);
            if (entry && carried.length > 0) {
                releaseHeld(entry, chunk);
                pruneEntry(entry);
                changed();
            }
        }
    } catch (err) {
        if (!live()) {
            // Signed out meanwhile: what it was writing went with the account.
            throw err instanceof RecoveryCancelled ? err : new RecoveryCancelled();
        }
        // Chunks before this one committed; this one rolled back whole. The
        // carried ops it had are still held; the fresh ones join them, if
        // they fit.
        const carriedSet = new Set(carried);
        const refused = holdOps(
            db,
            docId,
            queue.slice(written).filter((held) => !carriedSet.has(held)),
        );
        if (refused.length > 0) {
            throw new HeldInkFull(
                refused.map((held) => held.op),
                err,
            );
        }
        throw err;
    }
};

export interface RetryResult {
    /** Every held op, and any owed day snapshot, is written (or left for Export, overtaken). */
    ok: boolean;
    /** Marks whose held ops this retry wrote. */
    wrote: string[];
    /** Marks a newer version had overtaken: left for Export, and drawn as that version (see overtakes). */
    overtaken: string[];
}

export interface RetryOptions {
    /**
     * The server's current versions of these marks, or null when it cannot
     * say (offline, an error): a version it has numbered past a held edit's
     * base overtakes it (see overtakes). Without it, the mirror alone decides.
     */
    serverRows?: (ids: string[]) => Promise<Annotation[] | null>;
}

/**
 * Write this account's held ops on this score again, oldest first, after the
 * day snapshot they owe. Each op goes out under the account that made it.
 * A held edit or erase a newer version has overtaken — on the server, or in
 * this device's mirror, checked in the same transaction as the write — is
 * not replayed over it, but kept for Export (RecoveryEntry.conflicts).
 * `ok` false: a write failed again, and what was not written is still held.
 * Bound to the account's epoch at the call (see persistOps).
 */
export const retryHeld = (userId: string | null, docId: string, options: RetryOptions = {}): Promise<RetryResult> => {
    const entry = entryFor(userId, docId);
    if (!entry) {
        return Promise.resolve({ ok: true, wrote: [], overtaken: [] });
    }
    const live = boundTo(userId);
    const run = entry.chain.then(() => writeHeld(entry, live, options));
    entry.chain = run.then(() => undefined);
    return run;
};

/** The server's versions of `ids`, or nothing once it has taken SERVER_CHECK_TIMEOUT_MS. */
const askServer = async (
    serverRows: NonNullable<RetryOptions['serverRows']>,
    ids: string[],
): Promise<Map<string, Annotation>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const rows = await Promise.race([
            serverRows(ids).catch(() => null),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), SERVER_CHECK_TIMEOUT_MS);
            }),
        ]);
        return new Map((rows ?? []).map((row) => [row.id, row]));
    } finally {
        clearTimeout(timer);
    }
};

const writeHeld = async (entry: RecoveryEntry, live: () => boolean, options: RetryOptions): Promise<RetryResult> => {
    if (!live()) {
        // Signed out while it waited: nothing of it may be written now.
        return { ok: false, wrote: [], overtaken: [] };
    }
    if (entries.get(keyOf(entry.userId, entry.docId)) !== entry) {
        // Let go while it waited (the score closed for good): nothing left to write.
        return { ok: true, wrote: [], overtaken: [] };
    }
    const wrote: string[] = [];
    const overtaken: string[] = [];
    let ok = true;
    try {
        if (options.serverRows) {
            const edited = [...chainsOf(entry.ops)].filter(([, { base }]) => base).map(([id]) => id);
            if (edited.length > 0) {
                const server = await askServer(options.serverRows, edited);
                if (!live()) {
                    throw new RecoveryCancelled();
                }
                overtaken.push(...settleOvertaken(entry.userId, entry.docId, server));
            }
        }
        const owed = owedStartingPoint(entry.userId, entry.docId);
        if (owed) {
            await ensureDayStartingSnapshot(entry.db, entry.docId, owed, null, live);
        }
        if (!live()) {
            throw new RecoveryCancelled();
        }
        entry.startingPoint = null;
        entry.refused = 0;
        // Ops held meanwhile only ever join at the end.
        while (entry.ops.length > 0) {
            const chunk = entry.ops.slice(0, PERSIST_CHUNK).filter((held) => held.author === entry.userId);
            if (chunk.length === 0) {
                break;
            }
            const chains = chainsOf(entry.ops);
            const result = await writeOps(entry.db, entry.docId, chunk, live, (rows) => {
                const out = new Set<string>();
                for (const [id, row] of rows) {
                    const chain = chains.get(id);
                    if (chain && overtakes(row, chain.base, chain.latest)) {
                        out.add(id);
                    }
                }
                return out;
            });
            releaseHeld(entry, result.written);
            moveToConflicts(entry, result.overtaken);
            wrote.push(...result.written.map((held) => held.op.annotation.id));
            overtaken.push(...result.overtaken);
        }
    } catch (err) {
        if (err instanceof RecoveryCancelled || !live()) {
            // Signed out meanwhile: the entry went with the account.
            return { ok: false, wrote: [...new Set(wrote)], overtaken };
        }
        console.warn('Retrying the unsaved marks failed', err);
        ok = false;
    }
    if (ok) {
        entry.overflow = 0;
    }
    pruneEntry(entry);
    changed();
    return { ok, wrote: [...new Set(wrote)], overtaken: [...new Set(overtaken)] };
};

/**
 * Write every held op of this account's, on every score (retryHeld), before
 * a sign-out that keeps the account's queued changes for its next sign-in
 * (signOutKeepingChanges): written, they are kept with the rest. Never
 * throws. The caller bounds the wait: a stalled database never settles it,
 * and the sign-out's clearAccountInk then cancels what is still on its way.
 */
export const retryAccountInk = async (userId: string): Promise<void> => {
    const docs = [...entries.values()].filter((entry) => entry.userId === userId).map((entry) => entry.docId);
    for (const docId of docs) {
        await retryHeld(userId, docId).catch(() => undefined);
    }
};

/**
 * Sign-out: forget the signed-out account's held ink, conflicts and refused
 * edits (after its warning), end every write of its still on its way (its
 * epoch moves on), and have each open viewer drawing for it forget what it
 * drew. Another account's held ink in this tab stays for that account. Told
 * to the other tabs of this browser too, which share the sign-out (see
 * listenToOtherTabs). `userId` undefined: the sign-out could not tell whose
 * session it ended, so every account's goes. Device-only scores' entries
 * stay, as their marks do.
 */
export const clearAccountInk = (userId?: string | null): void => {
    if (userId === null) {
        return;
    }
    dropAccountInk(userId);
    tellOtherTabs(userId);
};

const dropAccountInk = (userId: string | undefined): void => {
    const matches = (who: string | null) => who !== null && (userId === undefined || who === userId);
    let any = false;
    for (const [key, entry] of entries) {
        if (matches(entry.userId)) {
            entries.delete(key);
            any = true;
        }
    }
    if (userId !== undefined) {
        epochs.set(userId, epochOf(userId) + 1);
    }
    for (const who of [...epochs.keys()]) {
        if (userId === undefined && matches(who)) {
            epochs.set(who, epochOf(who) + 1);
        }
    }
    for (const store of [...openStores]) {
        if (matches(store.authorId)) {
            store.accountInkCleared();
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

const CHANNEL_NAME = 'cleffy:ink-recovery';
/** The storage-event fallback for a browser without BroadcastChannel. */
export const SIGNED_OUT_STORAGE_KEY = 'cleffy:ink-recovery:signed-out';

interface SignedOutMessage {
    type: 'account-ink-cleared';
    /** Absent: whose session ended was not known — every account's. */
    userId?: string;
}

const isSignedOutMessage = (value: unknown): value is SignedOutMessage =>
    !!value &&
    typeof value === 'object' &&
    (value as SignedOutMessage).type === 'account-ink-cleared' &&
    ((value as SignedOutMessage).userId === undefined || typeof (value as SignedOutMessage).userId === 'string');

let channel: BroadcastChannel | null = null;

/** Another tab signed this account out: its held ink here goes too, and its writes here stop. */
const onOtherTabSignedOut = (value: unknown): void => {
    if (isSignedOutMessage(value)) {
        dropAccountInk(value.userId);
    }
};

/**
 * Sign-out is the browser's, not the tab's: every other tab of this app
 * hears of it, by BroadcastChannel, or by a storage event where there is
 * none. Never throws.
 */
const tellOtherTabs = (userId: string | undefined): void => {
    const message: SignedOutMessage = { type: 'account-ink-cleared', ...(userId ? { userId } : {}) };
    try {
        if (channel) {
            channel.postMessage(message);
            return;
        }
        if (typeof localStorage !== 'undefined') {
            // A storage event fires in the other tabs only when the value changes.
            localStorage.setItem(SIGNED_OUT_STORAGE_KEY, JSON.stringify({ ...message, at: crypto.randomUUID() }));
            localStorage.removeItem(SIGNED_OUT_STORAGE_KEY);
        }
    } catch {
        // No way to reach the other tabs: their own auth state still signs them out.
    }
};

const listenToOtherTabs = (): void => {
    if (typeof window === 'undefined') {
        return;
    }
    window.addEventListener('storage', (event: StorageEvent) => {
        if (event.key !== SIGNED_OUT_STORAGE_KEY || !event.newValue) {
            return;
        }
        try {
            onOtherTabSignedOut(JSON.parse(event.newValue));
        } catch {
            // Not ours.
        }
    });
    if (typeof BroadcastChannel !== 'function') {
        return;
    }
    try {
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = (event: MessageEvent) => onOtherTabSignedOut(event.data);
        // Node (the tests) would otherwise keep running for it.
        (channel as BroadcastChannel & { unref?: () => void }).unref?.();
    } catch {
        channel = null;
    }
};

listenToOtherTabs();

/**
 * An open viewer's store: export reads its memory when the database cannot
 * be read (see openMarksFor), and a sign-out clearing its account's ink
 * has it forget what it drew (OpenStore.accountInkCleared). Returns the
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

/** Ink a reload or closing the tab would lose: a write still on its way, held, or held for Export. */
export const hasUnsavedInk = (): boolean =>
    inFlight > 0 || [...entries.values()].some((e) => e.ops.length > 0 || e.conflicts.size > 0);

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
    epochs.clear();
    inFlight = 0;
    changed();
};

const EMPTY_IDS: ReadonlySet<string> = new Set();
