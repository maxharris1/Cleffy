import { getDb } from '@/sync/db';

/**
 * Monotonic counter over library-affecting mutations (upload, rename, delete,
 * favorite, tag changes, sign-out). A library_bootstrap payload is a snapshot
 * of the server taken when the request executed, so a response whose request
 * left before a mutation landed describes a library that no longer exists:
 * consumers compare the epoch a payload was fetched under against the current
 * one and refetch (or stand down) instead of applying or persisting it.
 */
let epoch = 0;

export const libraryMutationEpoch = (): number => epoch;

/**
 * Record that a library-affecting mutation is being ATTEMPTED. Called at the
 * top of every service mutation — before the server write, so a response
 * racing the write is already outranked — and from signOut. Only the counter
 * moves here: the Dexie snapshot survives, because the mutation may yet fail
 * (an offline favorite tap must not cost the offline library its list).
 */
export const noteLibraryMutation = (): void => {
    epoch += 1;
};

/**
 * Drop the persisted library snapshots after a mutation SUCCEEDS. The rows
 * now describe a library that no longer exists, and an offline mount must not
 * resurrect a deleted score or hide a new one; the next successful bootstrap
 * rebuilds them. All accounts' rows go: they are only instant-paint hints,
 * and the write sites mostly don't know a user id to scope the delete by.
 */
export const dropLibraryListSnapshots = (): void => {
    try {
        void getDb()
            .libraryList.clear()
            .catch(() => undefined);
    } catch {
        // No IndexedDB (private mode) means no snapshot to drop.
    }
};
