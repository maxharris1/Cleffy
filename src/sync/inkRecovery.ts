import { ensureDayStartingSnapshot } from '@/features/viewer/history/snapshotService';
import { localDateString } from '@/features/viewer/history/snapshotTypes';
import { anyCutOffWrites, cutOffWrites, isCutOffWrite, resetCutOffWritesForTests } from '@/sync/cutOffWrites';
import type { LocalAnnotation, PendingOp, ScribblerDb } from '@/sync/db';
import { onAccountSignedIn, setSignedOutInk } from '@/sync/inkRecoverySignal';
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
 * database — then writes nothing, checked inside its own transaction and
 * again once it is seen done (see writeOps). One whose transaction commits
 * all the same is cut off (cutOffWrites): its rows are swept, and its ink is
 * still held here.
 *
 * Sign-out never destroys held ink (retireAccountInk): it cuts off the
 * account's writes, and the ink stays in this tab, out of every viewer and
 * of Retry, for Export or an explicit Discard (SignedOutInkNotice). It goes
 * only on that Discard, when the tab closes (the unload guard asks first),
 * or when another account signs in here (accountSignedIn); the same
 * account signing in again gets it back.
 *
 * Losing a score never destroys its held ink either (decision 65(1)):
 * removed from a share, the score deleted by someone else, access taken
 * back (closeDocInk). The ink is closed — out of every viewer and of Retry,
 * as signed-out ink is — and kept for the same Export or Discard
 * (lostAccessInk, SignedOutInkNotice). Only the user deleting the score
 * themselves lets it go at once (forgetDocInk): that is their choice.
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
    /**
     * When its edit began (InkWriteGuard.order): what keeps a mark's held ops
     * oldest first, however late one of them comes to be held (see appendHeld).
     */
    order?: number;
}

/** What export reads from an open viewer when the database cannot be read (see registerOpenStore). */
export interface OpenStore {
    readonly docId: string;
    readonly authorId: string | null;
    liveAnnotations(): Annotation[];
    /** Its account signed out (here or in another tab): forget what it drew for it. */
    accountSignedOut(): void;
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
    /** When the edit of each conflict began (AuthoredOp.order), where known. */
    conflictOrders: Map<string, number>;
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
     * The user hid the conflict notice (its Dismiss): the conflicts stay for
     * Export all the same. A newly overtaken mark shows it again.
     */
    conflictNoticeHidden: boolean;
    /** Writes of this entry's ops run one at a time, so a held op is never in two writes at once. */
    chain: Promise<void>;
    /**
     * The score was lost to this device (closeDocInk): kept under a key of its
     * own (closedKeyOf), so no viewer, Retry or new edit finds it — Export or
     * Discard only.
     */
    closed: boolean;
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
/**
 * Edits not made because holding them would pass MAX_HELD_SCORES or
 * MAX_HELD_OPS (see admits), by entry key: undone on screen, and said so,
 * never held by dropping something older. Counters only, apart from the
 * entries, so a refusal neither makes an entry nor counts toward the bounds.
 */
const overflowNotes = new Map<string, number>();
/**
 * Accounts signed out in this tab or another (retireAccountInk), and how
 * this tab heard of it. Their entries stay — the only copy of their ink —
 * but no viewer draws them and nothing writes them: Export or Discard only.
 */
export type SignedOutReason = 'here' | 'other-tab';
const retired = new Map<string, SignedOutReason>();
/** The account last seen signed in in this tab (accountSignedIn), null once it signs out. */
let signedIn: string | null = null;
/** Each score's PDF and title from its open viewer, kept while its ink is held: what Export draws on after sign-out. */
const sources = new Map<string, { title: string; bytes?: ArrayBuffer; viewers: number }>();
/** Ink writes on their way, by write id (see writeOps): what a sign-out cuts off. */
const inFlightWrites = new Map<string, string | null>();
const listeners = new Set<() => void>();
const openStores = new Set<OpenStore>();
/** Per account, moved on whenever its held ink is cleared (see epochOf). */
const epochs = new Map<string | null, number>();
/** Per score, moved on whenever it is lost to this device or deleted here (see editBoundTo). */
const docEpochs = new Map<string, number>();
/** Per score, the epoch its last delete here (forgetDocInk) moved it to: its ink went with it. */
const forgottenAt = new Map<string, number>();
/** Local edits applied in memory whose write has not finished (AnnotationStore.hasUnsavedEdit). */
let inFlight = 0;
/** The last InkWriteGuard.order handed out: edits are numbered in the order they began. */
let lastEditOrder = 0;

const keyOf = (userId: string | null, docId: string): string => JSON.stringify([userId, docId]);
/** Where a closed entry is kept (see RecoveryEntry.closed): never a key a viewer or a write looks up. */
const closedKeyOf = (userId: string | null, docId: string): string => JSON.stringify(['closed', userId, docId]);
const entryKey = (entry: RecoveryEntry): string =>
    entry.closed ? closedKeyOf(entry.userId, entry.docId) : keyOf(entry.userId, entry.docId);

const isRetired = (userId: string | null): boolean => userId !== null && retired.has(userId);

/** The entry a viewer, Retry or a write uses: none for a signed-out account (see retired). */
const entryFor = (userId: string | null, docId: string): RecoveryEntry | undefined =>
    isRetired(userId) ? undefined : entries.get(keyOf(userId, docId));

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
    if (isRetired(userId)) {
        // Signed out: nothing more of its is written until it signs in again.
        return () => false;
    }
    const epoch = epochOf(userId);
    return () => epochOf(userId) === epoch;
};

const closeDocEpoch = (docId: string): number => {
    const epoch = (docEpochs.get(docId) ?? 0) + 1;
    docEpochs.set(docId, epoch);
    return epoch;
};

/**
 * An edit's guard: its account's epoch (boundTo) and its score's
 * (openDocBoundTo), both as they were when the edit began. Taken there and
 * carried through its day-snapshot wait and every write of it, so a
 * sign-out, or the score lost to this device (closeDocInk, as purged by
 * purgeLocalDocument), cuts it off wherever it then is — queued behind a
 * Retry, waiting on storage, or inside its transaction — and nothing of it
 * lands in a purged score's mirror or outbox.
 */
export interface InkWriteGuard {
    (): boolean;
    /**
     * What the score's loss since the edit began left of it: 'closed' (kept
     * for Export or Discard, closeDocInk) or 'forgotten' (deleted here by the
     * user, forgetDocInk); null while the score is still open here.
     */
    readonly scoreLost: () => 'closed' | 'forgotten' | null;
    /** Where the edit falls among this tab's edits, oldest first (AuthoredOp.order). */
    readonly order: number;
}

export const editBoundTo = (userId: string | null, docId: string): InkWriteGuard => {
    const account = boundTo(userId);
    const epoch = docEpochs.get(docId) ?? 0;
    const open = () => (docEpochs.get(docId) ?? 0) === epoch;
    return Object.assign(() => account() && open(), {
        scoreLost: () => (open() ? null : (forgottenAt.get(docId) ?? 0) > epoch ? 'forgotten' : 'closed'),
        order: ++lastEditOrder,
    });
};

/** Whether edit order `a` began before `b`; unknown either way (an op made without one), not. */
const isOlder = (a: number | undefined, b: number | undefined): boolean => a !== undefined && b !== undefined && a < b;

/** A write its account's sign-out, or its score's loss here, overtook: it wrote nothing. */
export class RecoveryCancelled extends Error {
    constructor(message = 'The account signed out before this could be written') {
        super(message);
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

/** `closed`: the score's closed entry (RecoveryEntry.closed), for ink kept after its loss. */
const ensureEntry = (db: ScribblerDb, userId: string | null, docId: string, closed = false): RecoveryEntry => {
    const key = closed ? closedKeyOf(userId, docId) : keyOf(userId, docId);
    let entry = entries.get(key);
    if (!entry) {
        entry = {
            userId,
            docId,
            db,
            ops: [],
            marks: new Map(),
            conflicts: new Map(),
            conflictOrders: new Map(),
            startingPoint: null,
            refused: 0,
            conflictNoticeHidden: false,
            chain: Promise.resolve(),
            closed,
        };
        entries.set(key, entry);
    }
    entry.db = db;
    return entry;
};

/** Drop an entry with nothing left to hold or say. */
const pruneEntry = (entry: RecoveryEntry): void => {
    if (entry.ops.length === 0 && entry.conflicts.size === 0 && !entry.startingPoint && entry.refused === 0) {
        if (entries.get(entryKey(entry)) === entry) {
            entries.delete(entryKey(entry));
            pruneSource(entry.docId);
        }
    }
};

/** Let a score's PDF go once no viewer has it open and no ink of it is held. */
const pruneSource = (docId: string): void => {
    const source = sources.get(docId);
    if (source && source.viewers === 0 && ![...entries.values()].some((entry) => entry.docId === docId)) {
        sources.delete(docId);
    }
};

/** Drop entries (and their overflow notes) for good: Discard, another account signing in, a purge. */
const dropEntries = (drop: (entry: RecoveryEntry) => boolean): boolean => {
    let any = false;
    for (const [key, entry] of entries) {
        if (drop(entry)) {
            entries.delete(key);
            pruneSource(entry.docId);
            any = true;
        }
    }
    return any;
};

/**
 * Whether ink no viewer can draw is held here — a signed-out account's, or a
 * lost score's (closeDocInk) — for the shell's SignedOutInkNotice.
 */
const holdsInkForTheNotice = (): boolean =>
    [...entries.values()].some(
        (entry) => (entry.closed || isRetired(entry.userId)) && entry.ops.length + entry.conflicts.size > 0,
    );

const changed = (): void => {
    syncUnloadGuard();
    setSignedOutInk(holdsInkForTheNotice());
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

/** Edits undone because the registry was full (see overflowNotes). */
export const overflowCount = (userId: string | null, docId: string): number =>
    isRetired(userId) ? 0 : (overflowNotes.get(keyOf(userId, docId)) ?? 0);

const noteOverflow = (userId: string | null, docId: string, edits: number): void => {
    const key = keyOf(userId, docId);
    overflowNotes.set(key, (overflowNotes.get(key) ?? 0) + edits);
};

/** Held marks a newer version overtook: Export only (see RecoveryEntry.conflicts). */
export const conflictCount = (userId: string | null, docId: string): number =>
    entryFor(userId, docId)?.conflicts.size ?? 0;

/** This account's held versions of overtaken marks on this score, tombstones included. */
export const conflictMarksFor = (userId: string | null, docId: string): Annotation[] => [
    ...(entryFor(userId, docId)?.conflicts.values() ?? []),
];

/** Whether the user hid the conflict notice (see RecoveryEntry.conflictNoticeHidden). */
export const conflictNoticeHidden = (userId: string | null, docId: string): boolean =>
    entryFor(userId, docId)?.conflictNoticeHidden ?? false;

/** The banner's Dismiss: the notice goes, the conflicts stay for Export until the tab closes or Discard. */
export const hideConflictNotice = (userId: string | null, docId: string): void => {
    const entry = entryFor(userId, docId);
    if (!entry || entry.conflictNoticeHidden) {
        return;
    }
    entry.conflictNoticeHidden = true;
    changed();
};

/**
 * The banner's Discard, once the user has confirmed it (with Export offered
 * first): the held versions of overtaken marks go for good.
 */
export const discardConflicts = (userId: string | null, docId: string): void => {
    const entry = entryFor(userId, docId);
    if (!entry || entry.conflicts.size === 0) {
        return;
    }
    entry.conflicts.clear();
    entry.conflictOrders.clear();
    entry.conflictNoticeHidden = false;
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
        if (
            entry.userId !== null &&
            !entry.closed &&
            !isRetired(entry.userId) &&
            (userId === undefined || entry.userId === userId)
        ) {
            count += entry.marks.size + entry.conflicts.size;
        }
    }
    return count;
};

/** Scores of this account's with held ink (or held conflicts), for the ended-sign-in prompt. */
export const heldDocIds = (userId: string): string[] =>
    [...entries.values()]
        .filter(
            (entry) =>
                entry.userId === userId &&
                !entry.closed &&
                !isRetired(userId) &&
                entry.marks.size + entry.conflicts.size > 0,
        )
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
 * edit, or another tab's that has uploaded. A mirror row on the same seq
 * with other content is another tab's local edit on the same server
 * version, ordered by this device's own clock; a server row on the same seq
 * is the version the base was made on, or older (`fromServer`). A row
 * numbered below the base is an older copy. A held create has no base: no
 * other version of a new mark can exist.
 */
export const overtakes = (
    row: Annotation | undefined,
    base: Annotation | null,
    latest: Annotation,
    fromServer = false,
): boolean => {
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
    return !fromServer && row.updatedAt > latest.updatedAt;
};

/**
 * These rows (the mirror's, or the server's: `fromServer`) overtook some of
 * the account's held marks: those leave Retry for Export
 * (RecoveryEntry.conflicts), and their ids are returned for the store to
 * draw the newer version.
 */
export const settleOvertaken = (
    userId: string | null,
    docId: string,
    rows: ReadonlyMap<string, Annotation | undefined>,
    fromServer = false,
): string[] => {
    const entry = entryFor(userId, docId);
    if (!entry) {
        return [];
    }
    const overtaken = [...chainsOf(entry.ops)]
        .filter(([id, { base, latest }]) => overtakes(rows.get(id), base, latest, fromServer))
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
            keepConflict(entry, held.op.annotation, held.order);
        } else {
            kept.push(held);
        }
    }
    entry.ops = kept;
    gone.forEach((id) => entry.marks.delete(id));
    // Newly overtaken: say so again, though the user hid the notice before.
    entry.conflictNoticeHidden = false;
    pruneEntry(entry);
    changed();
};

/** Hold `mark` as its conflict, unless the one held already is of a newer edit. */
const keepConflict = (entry: RecoveryEntry, mark: Annotation, order: number | undefined): void => {
    if (isOlder(order, entry.conflictOrders.get(mark.id))) {
        return;
    }
    entry.conflicts.set(mark.id, mark);
    if (order === undefined) {
        entry.conflictOrders.delete(mark.id);
    } else {
        entry.conflictOrders.set(mark.id, order);
    }
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
    const holding =
        !!entry && (entry.ops.length + entry.conflicts.size > 0 || !!entry.startingPoint || entry.refused > 0);
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
            noteOverflow(author, docId, new Set(authored.map((held) => held.op.annotation.id)).size);
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
 * Append one op, in the order its edit began (AuthoredOp.order): one held
 * late — cut off behind a Retry, say, after newer ink of its mark was kept
 * (keepCancelled) — goes in before every newer op, never after, so the
 * newest held version of a mark is always its newest edit. A run of updates
 * to one mark keeps only the newest (each carries the whole mark), so
 * dragging a held text note does not grow the entry by an op per frame. The
 * replacement is a new object: a write already carrying the older one
 * releases that one, and this one stays held.
 */
const appendHeld = (entry: RecoveryEntry, held: AuthoredOp): void => {
    const { id } = held.op.annotation;
    let at = entry.ops.length;
    while (at > 0 && isOlder(held.order, entry.ops[at - 1]?.order)) {
        at--;
    }
    if (held.op.type === 'update' && entry.marks.has(id)) {
        for (let i = at - 1; i >= 0; i--) {
            const prior = entry.ops[i];
            if (prior?.op.annotation.id !== id) {
                continue;
            }
            if (prior.op.type === 'update' && prior.author === held.author) {
                entry.ops[i] = { ...held, op: { ...held.op, prev: prior.op.prev } };
                return;
            }
            break;
        }
    }
    // A newer edit of a mark held as a conflict is the user's latest word on it.
    if (!isOlder(held.order, entry.conflictOrders.get(id))) {
        entry.conflicts.delete(id);
        entry.conflictOrders.delete(id);
    }
    entry.ops.splice(at, 0, held);
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
        overflowNotes.delete(keyOf(entry.userId, entry.docId));
    }
};

/**
 * Edits a sign-out cut off on their way to storage (see writeQueue): not
 * written, but the user's all the same, so held with the account's other
 * ink — signed out, so for Export or Discard. Not bounded by admits: they
 * are at most the writes that were under way. Let go only when another
 * account has signed in here meanwhile, which lets that ink go too.
 */
export const keepCutOff = (db: ScribblerDb, author: string | null, docId: string, ops: readonly AuthoredOp[]): void => {
    if (ops.length === 0 || (author !== null && !retired.has(author) && signedIn !== author)) {
        return;
    }
    const entry = ensureEntry(db, author, docId);
    for (const held of ops) {
        appendHeld(entry, held);
    }
    changed();
};

/**
 * Edits `live` (editBoundTo) cut off on their way to storage: kept as the
 * account's signed-out ink (keepCutOff) or, the score lost to this device
 * since they began, as its closed ink — out of every viewer and of Retry,
 * for Export or Discard, as closeDocInk keeps what was held then (decision
 * 65(1)). Never written into the purged score. The score deleted here by the
 * user (forgetDocInk) lets them go with it. Not bounded by admits: they are
 * at most the writes that were under way.
 */
export const keepCancelled = (
    db: ScribblerDb,
    author: string | null,
    docId: string,
    ops: readonly AuthoredOp[],
    live: InkWriteGuard,
): void => {
    const lost = live.scoreLost();
    if (!lost) {
        keepCutOff(db, author, docId, ops);
        return;
    }
    if (lost === 'forgotten' || ops.length === 0 || (author !== null && !retired.has(author) && signedIn !== author)) {
        return;
    }
    const entry = ensureEntry(db, author, docId, true);
    for (const held of ops) {
        appendHeld(entry, held);
    }
    changed();
};

/** RecoveryCancelled for a write `live` cut off, saying which it was. */
const cancelledBy = (live: InkWriteGuard): RecoveryCancelled =>
    live.scoreLost()
        ? new RecoveryCancelled('The score was closed on this device before this could be written')
        : new RecoveryCancelled();

/**
 * A day snapshot that failed for an edit of an existing mark, which was
 * refused (see RecoveryEntry.refused). Counted, with its starting point,
 * only when that fits (see admits); else said as overflow. The edit was
 * refused either way.
 */
export const noteRefusedEdit = (
    db: ScribblerDb,
    userId: string | null,
    docId: string,
    startingPoint: Annotation[],
): void => {
    if (!admits(userId, docId, entryFor(userId, docId)?.startingPoint ? 0 : startingPoint.length)) {
        // No room to keep its starting point: said as an edit not made
        // (overflow), with no entry made and nothing counted toward the bounds.
        noteOverflow(userId, docId, 1);
        changed();
        return;
    }
    const entry = ensureEntry(db, userId, docId);
    entry.refused += 1;
    entry.startingPoint ??= { live: startingPoint, day: localDateString() };
    changed();
};

/**
 * One atomic mirror + outbox write, each op stamped with its own author.
 * `live` is checked inside the transaction, before and between its writes:
 * once the account's epoch has moved on (sign-out), it throws and the whole
 * transaction rolls back. `check`, given the chunk's current mirror rows,
 * names marks a newer version has overtaken (see overtakes): their ops are
 * left out. Returns what it wrote and what it left out.
 *
 * Done only if `live` still holds once the transaction is seen to have
 * committed: a sign-out between its last check and then cut it off
 * (retireAccountInk records its id, PendingOp.inkWrite), so it throws
 * RecoveryCancelled, its ops stay held, and its rows are swept as stale
 * (sweepCutOffWrites) — the store and storage never disagree about it.
 */
const writeOps = async (
    db: ScribblerDb,
    docId: string,
    author: string | null,
    slice: readonly AuthoredOp[],
    live: () => boolean,
    check?: (rows: ReadonlyMap<string, LocalAnnotation | undefined>) => Set<string>,
): Promise<{ written: AuthoredOp[]; overtaken: Set<string> }> => {
    const writeId = crypto.randomUUID();
    inFlightWrites.set(writeId, author);
    try {
        const result = await writeOpsWithin(db, docId, slice, writeId, live, check);
        if (!live()) {
            throw new RecoveryCancelled();
        }
        return result;
    } finally {
        inFlightWrites.delete(writeId);
    }
};

const writeOpsWithin = (
    db: ScribblerDb,
    docId: string,
    slice: readonly AuthoredOp[],
    writeId: string,
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
            inkWrite: writeId,
            ...(op.type === 'restore' ? { baseDeletedAt: op.baseDeletedAt } : {}),
            ...(author ? { userId: author } : {}),
        }));
        await db.annotations.bulkPut(rows);
        if (!live()) {
            throw new RecoveryCancelled();
        }
        await db.ops.bulkAdd(opRows);
        // The last word before it commits: a sign-out while the outbox
        // write was under way rolls it all back here.
        if (!live()) {
            throw new RecoveryCancelled();
        }
        return { written, overtaken };
    });

/**
 * Write a store's edits, made by `author`: the durable mirror + outbox,
 * atomically per chunk. An edit of a mark with held ops goes out behind
 * them, in the same write, so the outbox never has a mark's newer op without
 * the older one it builds on, and once it lands nothing older is held to
 * override it. What could not be written is held, and the error rethrown —
 * or, past the registry's bounds, HeldInkFull names what was not held.
 * Bound to the author's epoch and the score's as they were when the edit was
 * made (`live`, from editBoundTo; else from the call): a sign-out, or the
 * score's loss to this device, before it runs (queued behind a Retry, say),
 * between its chunks or during one ends it with RecoveryCancelled, writing
 * nothing more; what it had not written is held as the signed-out account's
 * or as the lost score's closed ink (keepCancelled).
 */
export const persistOps = (
    db: ScribblerDb,
    author: string | null,
    docId: string,
    ops: CommitOp[],
    live: InkWriteGuard = editBoundTo(author, docId),
): Promise<void> => {
    const fresh = ops.map((op): AuthoredOp => ({ op, author, order: live.order }));
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
    live: InkWriteGuard,
): Promise<void> => {
    const queue = [...carried, ...fresh];
    let written = 0;
    try {
        if (!live()) {
            throw new RecoveryCancelled();
        }
        for (; written < queue.length; written += PERSIST_CHUNK) {
            const chunk = queue.slice(written, written + PERSIST_CHUNK);
            await writeOps(db, docId, author, chunk, live);
            const entry = entryFor(author, docId);
            if (entry && carried.length > 0) {
                releaseHeld(entry, chunk);
                pruneEntry(entry);
                changed();
            }
        }
    } catch (err) {
        const carriedSet = new Set(carried);
        if (!live()) {
            // Signed out, or the score lost, meanwhile: cut off, and not
            // written — still the user's, so held for Export or Discard. The
            // carried ops already are.
            keepCancelled(
                db,
                author,
                docId,
                queue.slice(written).filter((held) => !carriedSet.has(held)),
                live,
            );
            throw cancelledBy(live);
        }
        // Chunks before this one committed; this one rolled back whole. The
        // carried ops it had are still held; the fresh ones join them, if
        // they fit.
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
 * Bound to the account's epoch at the call (see persistOps), and to the
 * score staying on this device (editBoundTo): closed meanwhile, it writes
 * nothing more and its closed ink is kept as it was.
 */
export const retryHeld = (userId: string | null, docId: string, options: RetryOptions = {}): Promise<RetryResult> => {
    const entry = entryFor(userId, docId);
    if (!entry) {
        // Nothing held: an overflow notice alone goes, there being room again.
        if (!isRetired(userId) && overflowNotes.delete(keyOf(userId, docId))) {
            changed();
        }
        return Promise.resolve({ ok: true, wrote: [], overtaken: [] });
    }
    // Cut off by the account's sign-out, or by the score's loss to this device.
    const live = editBoundTo(userId, docId);
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
        // Signed out, or the score lost, while it waited: nothing of it may be written now.
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
                overtaken.push(...settleOvertaken(entry.userId, entry.docId, server, true));
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
        // Ops held meanwhile join the entry too, and are written in turn.
        while (entry.ops.length > 0) {
            const chunk = entry.ops.slice(0, PERSIST_CHUNK).filter((held) => held.author === entry.userId);
            if (chunk.length === 0) {
                break;
            }
            const chains = chainsOf(entry.ops);
            const result = await writeOps(entry.db, entry.docId, entry.userId, chunk, live, (rows) => {
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
            // Signed out, or the score lost, meanwhile: what is not written
            // stays held, signed out or closed (never pruned from here).
            changed();
            return { ok: false, wrote: [...new Set(wrote)], overtaken };
        }
        console.warn('Retrying the unsaved marks failed', err);
        ok = false;
    }
    if (ok) {
        overflowNotes.delete(keyOf(entry.userId, entry.docId));
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
 * and the sign-out's retireAccountInk then cuts off what is still on its
 * way — what it had not written stays held, signed out.
 */
export const retryAccountInk = async (userId: string): Promise<void> => {
    const docs = [...entries.values()]
        .filter((entry) => entry.userId === userId && !entry.closed)
        .map((entry) => entry.docId);
    for (const docId of docs) {
        await retryHeld(userId, docId).catch(() => undefined);
    }
};

/**
 * Sign-out, here (`here`) or in another tab of this browser (`other-tab`):
 * cut off every write of the account's at once — its epoch moves on, so
 * nothing more of it is written, and writes still on their way are cut off
 * (cutOffWrites) — and have each open viewer drawing for it forget what it
 * drew. Its held ink, conflicts included, is NOT dropped: memory is its only
 * copy. It stays in this tab, out of every viewer and of Retry, for Export
 * or an explicit Discard (signedOutInk, SignedOutInkNotice), until the tab
 * closes or another account signs in here (accountSignedIn). A sign-out here
 * tells the other tabs too. `userId` undefined: the sign-out could not tell
 * whose session it ended, so every account's is. Device-only scores belong
 * to no account and are untouched.
 */
export const retireAccountInk = (userId?: string | null, reason: SignedOutReason = 'here'): void => {
    if (userId === null) {
        return;
    }
    retire(userId, reason);
    if (reason === 'here') {
        tellOtherTabs(userId);
    }
};

const retire = (userId: string | undefined, reason: SignedOutReason): void => {
    const accounts = new Set<string>();
    if (userId !== undefined) {
        accounts.add(userId);
    } else {
        for (const who of [
            ...epochs.keys(),
            ...inFlightWrites.values(),
            ...[...entries.values()].map((e) => e.userId),
        ]) {
            if (who !== null) {
                accounts.add(who);
            }
        }
    }
    const cut: string[] = [];
    for (const who of accounts) {
        epochs.set(who, epochOf(who) + 1);
        if (!retired.has(who)) {
            retired.set(who, reason);
        }
        if (signedIn === who) {
            signedIn = null;
        }
        for (const [writeId, author] of inFlightWrites) {
            if (author === who) {
                cut.push(writeId);
            }
        }
        for (const key of [...overflowNotes.keys()]) {
            if ((JSON.parse(key) as [string | null, string])[0] === who) {
                overflowNotes.delete(key);
            }
        }
    }
    cutOffWrites(cut);
    for (const store of [...openStores]) {
        if (store.authorId !== null && accounts.has(store.authorId)) {
            store.accountSignedOut();
        }
    }
    changed();
};

/**
 * An account is signed in in this tab (session.ts, by inkRecoverySignal).
 * Its own signed-out ink is its again: drawn, and retried, as before. Any
 * other signed-out account's goes for good: the tab is someone else's now.
 */
export const accountSignedIn = (userId: string): void => {
    signedIn = userId;
    if (retired.size === 0) {
        return;
    }
    for (const who of [...retired.keys()]) {
        if (who !== userId) {
            dropEntries((entry) => entry.userId === who);
        }
        retired.delete(who);
    }
    changed();
};

onAccountSignedIn(accountSignedIn);

/** A score of a signed-out account's with ink held here (SignedOutInkNotice). */
export interface SignedOutScore {
    docId: string;
    /** Held marks and conflicts on it. */
    marks: number;
    /** From its viewer, while it was open (rememberScoreSource). */
    title?: string;
    bytes?: ArrayBuffer;
}

/** Ink of signed-out accounts this tab still holds, by account, for Export or Discard. */
export const signedOutInk = (): Array<{ userId: string; reason: SignedOutReason; scores: SignedOutScore[] }> => {
    const out: Array<{ userId: string; reason: SignedOutReason; scores: SignedOutScore[] }> = [];
    for (const [userId, reason] of retired) {
        const scores = [...entries.values()]
            .filter((entry) => entry.userId === userId && !entry.closed && entry.marks.size + entry.conflicts.size > 0)
            .map(heldScoreOf);
        if (scores.length > 0) {
            out.push({ userId, reason, scores });
        }
    }
    return out;
};

/**
 * The notice's Discard, once the user has confirmed it with Export offered
 * first: a signed-out account's held ink here goes for good (every signed-out
 * account's when `userId` is undefined).
 */
export const discardSignedOutInk = (userId?: string): void => {
    const any = dropEntries(
        (entry) => !entry.closed && isRetired(entry.userId) && (userId === undefined || entry.userId === userId),
    );
    if (any) {
        changed();
    }
};

/** A held entry as the notice lists it: the score, its mark count, and the PDF and title its viewer left. */
const heldScoreOf = (entry: RecoveryEntry): SignedOutScore => {
    const source = sources.get(entry.docId);
    return {
        docId: entry.docId,
        marks: entry.marks.size + entry.conflicts.size,
        ...(source ? { title: source.title, ...(source.bytes ? { bytes: source.bytes } : {}) } : {}),
    };
};

/**
 * The score is lost to this device — the account was removed from it, it
 * was deleted by someone else, access was taken back — and purged here
 * (documentsService.purgeLocalDocument). Its held ink is NOT dropped
 * (decision 65(1)): memory is its only copy. Each account's is closed, out
 * of every viewer and of Retry, and kept for Export or an explicit Discard
 * (lostAccessInk, SignedOutInkNotice) until the tab closes or another
 * account signs in here, as signed-out ink is. An entry with nothing to keep
 * (only a refused edit, or an owed starting point) just goes.
 */
export const closeDocInk = (docId: string): void => {
    // A Retry or an edit still on its way writes nothing more, and what it
    // had not written joins the closed ink (editBoundTo, keepCancelled).
    closeDocEpoch(docId);
    let any = false;
    for (const key of [...overflowNotes.keys()]) {
        if ((JSON.parse(key) as [string | null, string])[1] === docId) {
            any = overflowNotes.delete(key) || any;
        }
    }
    for (const [key, entry] of [...entries]) {
        if (entry.docId !== docId || entry.closed) {
            continue;
        }
        entries.delete(key);
        any = true;
        if (entry.ops.length + entry.conflicts.size === 0) {
            continue;
        }
        entry.startingPoint = null;
        entry.refused = 0;
        entry.closed = true;
        const earlier = entries.get(entryKey(entry));
        if (earlier) {
            // Lost before and held again since: one closed entry, oldest ops first.
            for (const held of entry.ops) {
                appendHeld(earlier, held);
            }
            for (const [id, mark] of entry.conflicts) {
                keepConflict(earlier, mark, entry.conflictOrders.get(id));
            }
        } else {
            entries.set(entryKey(entry), entry);
        }
    }
    pruneSource(docId);
    if (any) {
        changed();
    }
};

/** Ink of scores lost to this device (closeDocInk), by account and score, for Export or Discard. */
export const lostAccessInk = (): Array<SignedOutScore & { userId: string | null }> =>
    [...entries.values()]
        .filter((entry) => entry.closed && entry.marks.size + entry.conflicts.size > 0)
        .map((entry) => ({ ...heldScoreOf(entry), userId: entry.userId }));

/**
 * The notice's Discard for lost scores, once the user has confirmed it with
 * Export offered first: their held ink goes for good.
 */
export const discardLostAccessInk = (): void => {
    if (dropEntries((entry) => entry.closed)) {
        changed();
    }
};

/**
 * What an export bakes in of `userId`'s held ink on this score, signed out
 * or not: the newest held version of each mark (tombstones included), the
 * held versions of overtaken marks, and each held mark's chain (for
 * overtakes). `signedOut`: the account has signed out, so only this ink is
 * its own to export here, not the device's saved marks.
 */
export const heldInkForExport = (
    userId: string | null,
    docId: string,
    /** The score was lost to this device: its closed ink (closeDocInk). */
    lost = false,
): {
    held: Annotation[];
    conflicts: Annotation[];
    chains: Map<string, { base: Annotation | null; latest: Annotation }>;
    signedOut: boolean;
} => {
    const entry = entries.get(lost ? closedKeyOf(userId, docId) : keyOf(userId, docId));
    const latest = new Map<string, Annotation>();
    for (const { op } of entry?.ops ?? []) {
        latest.set(op.annotation.id, op.annotation);
    }
    return {
        held: [...latest.values()],
        conflicts: [...(entry?.conflicts.values() ?? [])],
        chains: entry ? chainsOf(entry.ops) : new Map(),
        signedOut: isRetired(userId),
    };
};

/**
 * The user deleted the score themselves: its held ink, closed or not, goes
 * with it (decision 65(1): their explicit choice). Every other way of
 * losing a score keeps it for Export or Discard (closeDocInk).
 */
export const forgetDocInk = (docId: string): void => {
    // A write still on its way writes nothing, and is not kept (keepCancelled).
    forgottenAt.set(docId, closeDocEpoch(docId));
    for (const key of [...overflowNotes.keys()]) {
        if ((JSON.parse(key) as [string | null, string])[1] === docId) {
            overflowNotes.delete(key);
        }
    }
    if (dropEntries((entry) => entry.docId === docId)) {
        changed();
    }
};

/**
 * Sweep this score's stale ink rows: outbox rows of writes a sign-out cut
 * off (cutOffWrites) whose transaction committed all the same. Every reader
 * already ignores them (opOwnerFor counts them nobody's); this deletes them,
 * with the mirror row each wrote when nothing newer has replaced it, and
 * then the score's pull watermark, so the next pull brings back the server's
 * version of those marks. Called on every load and attach of a store.
 * Returns the marks they were on (empty when none), whether or not the
 * delete itself worked. Never throws.
 */
export const sweepCutOffWrites = async (db: ScribblerDb, docId: string): Promise<Set<string>> => {
    if (!anyCutOffWrites()) {
        return new Set();
    }
    try {
        const stale = (await db.ops.where('docId').equals(docId).toArray()).filter(isCutOffWrite);
        if (stale.length === 0) {
            return new Set();
        }
        const marks = new Set(stale.map((op) => op.annotationId));
        await db
            .transaction('rw', db.annotations, db.ops, db.syncState, async () => {
                const queued = await db.ops.where('docId').equals(docId).toArray();
                const gone = queued.filter(isCutOffWrite);
                const kept = new Set(queued.filter((op) => !isCutOffWrite(op)).map((op) => op.annotationId));
                const written = new Set(gone.map((op) => `${op.annotationId}\u0000${op.annotation.updatedAt}`));
                await db.ops.bulkDelete(gone.flatMap((op) => (op.opId === undefined ? [] : [op.opId])));
                const ids = [...new Set(gone.map((op) => op.annotationId))].filter((id) => !kept.has(id));
                const rows = await db.annotations.bulkGet(ids);
                const drop = rows.flatMap((row) =>
                    row && written.has(`${row.id}\u0000${row.updatedAt}`) ? [row.id] : [],
                );
                if (drop.length > 0) {
                    await db.annotations.bulkDelete(drop);
                    await db.syncState.delete(docId);
                }
            })
            .catch((err: unknown) => console.warn('Could not sweep ink writes cut off by a sign-out', err));
        return marks;
    } catch (err) {
        console.warn('Could not look for ink writes cut off by a sign-out', err);
        return new Set();
    }
};

const CHANNEL_NAME = 'cleffy:ink-recovery';
/** The storage-event fallback for a browser without BroadcastChannel. */
export const SIGNED_OUT_STORAGE_KEY = 'cleffy:ink-recovery:signed-out';

interface SignedOutMessage {
    type: 'account-signed-out';
    /** Absent: whose session ended was not known — every account's. */
    userId?: string;
}

const isSignedOutMessage = (value: unknown): value is SignedOutMessage =>
    !!value &&
    typeof value === 'object' &&
    (value as SignedOutMessage).type === 'account-signed-out' &&
    ((value as SignedOutMessage).userId === undefined || typeof (value as SignedOutMessage).userId === 'string');

let channel: BroadcastChannel | null = null;

/** Another tab signed this account out: its writes here stop too, and its held ink here stays, signed out. */
const onOtherTabSignedOut = (value: unknown): void => {
    if (isSignedOutMessage(value)) {
        retire(value.userId, 'other-tab');
    }
};

/**
 * Sign-out is the browser's, not the tab's: every other tab of this app
 * hears of it, by BroadcastChannel, or by a storage event where there is
 * none. Never throws.
 */
const tellOtherTabs = (userId: string | undefined): void => {
    const message: SignedOutMessage = { type: 'account-signed-out', ...(userId ? { userId } : {}) };
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
 * be read (see openMarksFor), and its account's sign-out has it forget
 * what it drew (OpenStore.accountSignedOut). Returns the unregister, for
 * the viewer's unmount.
 */
export const registerOpenStore = (store: OpenStore): (() => void) => {
    openStores.add(store);
    return () => {
        openStores.delete(store);
    };
};

/**
 * An open viewer's PDF and title for its score: kept while the score has
 * held ink, even after the viewer closes, so a signed-out account's Export
 * (SignedOutInkNotice) has the score to draw on once sign-out has cleared
 * the device's copy. Returns the unregister, for the viewer's unmount.
 */
export const rememberScoreSource = (docId: string, title: string, bytes?: ArrayBuffer): (() => void) => {
    const source = sources.get(docId);
    if (source) {
        source.title = title;
        source.bytes = bytes ?? source.bytes;
        source.viewers += 1;
    } else {
        sources.set(docId, { title, ...(bytes ? { bytes } : {}), viewers: 1 });
    }
    let done = false;
    return () => {
        const current = sources.get(docId);
        if (done || !current) {
            return;
        }
        done = true;
        current.viewers = Math.max(0, current.viewers - 1);
        pruneSource(docId);
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
    docEpochs.clear();
    forgottenAt.clear();
    overflowNotes.clear();
    retired.clear();
    sources.clear();
    inFlightWrites.clear();
    signedIn = null;
    resetCutOffWritesForTests();
    inFlight = 0;
    changed();
};

const EMPTY_IDS: ReadonlySet<string> = new Set();
