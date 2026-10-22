/**
 * Ink writes a sign-out cut off (inkRecovery.retireAccountInk): each mirror +
 * outbox write of a local edit stamps its outbox rows with an id of its own
 * (PendingOp.inkWrite), and when the account's epoch moves on, the ids of
 * its writes still on their way are recorded here. Such a write counts as
 * not done: its ink stays held in its tab, for Export or Discard. If its
 * transaction commits all the same (one already running cannot be stopped),
 * its rows are stale: nobody's to draw, upload or keep (opOwnerFor), and
 * swept on the next load or attach (inkRecovery.sweepCutOffWrites).
 *
 * Kept in localStorage, so the other tabs and a reload see them too: random
 * ids only, nothing about the account. Bounded, oldest first out: a write
 * stalled past MAX_CUT_OFF later sign-outs is long gone.
 */

const STORAGE_KEY = 'cleffy:ink-cut-off-writes';
const MAX_CUT_OFF = 500;

let ids: string[] = [];
let known = new Set<string>();

const read = (): string[] => {
    try {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
        return [];
    }
};

const adopt = (next: string[]): void => {
    ids = next.slice(-MAX_CUT_OFF);
    known = new Set(ids);
};

adopt(read());

if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event: StorageEvent) => {
        if (event.key === STORAGE_KEY) {
            adopt([...new Set([...ids, ...read()])]);
        }
    });
}

/** Record these writes as cut off, here and for the other tabs. */
export const cutOffWrites = (writeIds: Iterable<string>): void => {
    const fresh = [...writeIds].filter((id) => !known.has(id));
    if (fresh.length === 0) {
        return;
    }
    adopt([...new Set([...read(), ...ids, ...fresh])]);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    } catch {
        // This tab still knows them; another tab learns of its own at its sign-out.
    }
};

/** Whether this outbox row is one a sign-out cut off (see above). */
export const isCutOffWrite = (op: { inkWrite?: string }): boolean =>
    op.inkWrite !== undefined && known.has(op.inkWrite);

/** Whether any write has been cut off at all (the sweep's fast path). */
export const anyCutOffWrites = (): boolean => known.size > 0;

/** Tests: forget every cut-off write. */
export const resetCutOffWritesForTests = (): void => {
    adopt([]);
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // Nothing stored.
    }
};
