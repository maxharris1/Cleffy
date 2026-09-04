/**
 * Monotonic counter over library-affecting mutation EDGES. Every mutation
 * (upload, rename, delete, favorite, tag changes, sign-out) bumps it twice:
 * once when the attempt starts — so a response already in flight is outranked
 * before the write can land — and once when the write commits — so a request
 * dispatched DURING the write cannot read pre-commit state and still look
 * fresh at resolve time. "Epoch unchanged since my request left" therefore
 * means: no mutation started after dispatch AND every mutation that had
 * started had already committed (or failed, which changes nothing) before
 * dispatch. Consumers compare a payload's dispatch-time epoch against the
 * current one and refetch (or stand down) instead of applying or persisting.
 */
let epoch = 0;

export const libraryMutationEpoch = (): number => epoch;

/**
 * The attempt edge. Called at the top of every service mutation, before the
 * server write. Only the counter moves: the Dexie snapshot survives, because
 * the mutation may yet fail (an offline favorite tap must not cost the
 * offline library its list).
 */
export const noteLibraryMutation = (): void => {
    epoch += 1;
};

/**
 * The commit edge. Called by every service mutation right after its server
 * write succeeds — never on failure, which changed nothing. Only the counter
 * moves: the Dexie snapshot stays so an unmounted library (favorite, then
 * open a score) still has a list to paint, and the next bootstrap corrects
 * it. In-flight bootstraps lose because their dispatch-time epoch no longer
 * matches. The mounted page writes the post-edit snapshot via persistTick.
 */
export const noteLibraryMutationCommitted = (): void => {
    epoch += 1;
};
