import { getDb } from '@/sync/db';

/**
 * Monotonic counter over library-affecting mutations (upload, rename, delete,
 * favorite, tag changes, sign-out). A library_bootstrap payload is a snapshot
 * of the server taken when the request executed, so a response whose request
 * left before a mutation landed describes a library that no longer exists:
 * callers capture the epoch before fetching and stand down — neither applying
 * nor persisting the payload — if it moved while the request was in flight.
 */
let epoch = 0;

export const libraryMutationEpoch = (): number => epoch;

/**
 * Record a library-affecting mutation. Called at the top of every service
 * mutation (before the server write, so a response racing the write is already
 * outranked) and from signOut. Also drops the Dexie snapshot: it predates the
 * mutation, and the next mount must not resurrect a deleted score or hide a
 * new one. The next successful bootstrap rebuilds it.
 */
export const noteLibraryMutation = (): void => {
    epoch += 1;
    try {
        void getDb()
            .libraryList.clear()
            .catch(() => undefined);
    } catch {
        // No IndexedDB (private mode) means no snapshot to drop.
    }
};
