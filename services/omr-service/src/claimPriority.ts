/**
 * Claim filter for a seed-only worker pool (plan Phase 2c).
 *
 * The corpus seed enqueues omr_jobs at priority -10; user jobs stay at 0.
 * `cleffy-omr-seed` runs the same image with CLEFFY_CLAIM_MAX_PRIORITY=-1 so
 * it only ever claims rows with `priority <= -1` — and only self-pokes while
 * such rows exist, so it scales to zero once the seed ledger is drained.
 *
 * Unset / empty → no filter: the user worker (`cleffy-omr`) keeps claiming
 * everything, and `order by priority desc` keeps user rows ahead of seed rows.
 * Anything that is not an integer is rejected (null) rather than guessed at;
 * server.ts refuses to start on a set-but-invalid value so a typo can never
 * turn the seed pool into a second user worker.
 */
export const CLAIM_MAX_PRIORITY_ENV = 'CLEFFY_CLAIM_MAX_PRIORITY';

const INT_RE = /^[+-]?\d+$/;

export const parseClaimMaxPriority = (raw: string | undefined): number | null => {
    const v = raw?.trim();
    if (v === undefined || v === '') {
        return null;
    }
    if (!INT_RE.test(v)) {
        return null;
    }
    const n = Number.parseInt(v, 10);
    return Number.isSafeInteger(n) ? n : null;
};

/** Live value for this process; read at call time so the poke loop follows the env. */
export const claimMaxPriority = (): number | null => parseClaimMaxPriority(process.env[CLAIM_MAX_PRIORITY_ENV]);

/** True when the variable is set to something that is not an integer (startup guard). */
export const claimMaxPriorityMisconfigured = (raw: string | undefined = process.env[CLAIM_MAX_PRIORITY_ENV]): boolean =>
    raw !== undefined && raw.trim() !== '' && parseClaimMaxPriority(raw) === null;
