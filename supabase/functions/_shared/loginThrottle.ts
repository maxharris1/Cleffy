/**
 * Per-ACCOUNT failed-sign-in throttling for endpoints that check a password on
 * someone's behalf (student-login).
 *
 * NO imports, like stripeSignature.ts: Deno loads it with the `.ts` extension
 * and vitest without, so the policy the function runs is the one the tests
 * pin. The client is anything with supabase-js's `rpc` shape.
 *
 * Why the per-IP limit is not enough. student-login's rateLimit bucket is per
 * caller IP, which stops one machine from hammering — but GoTrue, the thing
 * actually checking the password, only ever sees THIS function's egress IP, so
 * its own per-IP throttling covers every student at once and protects no
 * single account. An attacker with a few hundred addresses could otherwise try
 * 60 passwords a minute per address against one child's username. This limiter
 * keys on the account instead: a handful of tries, then an exponentially
 * growing lockout.
 *
 * The state lives in Postgres (edge_login_attempts via begin_login_attempt /
 * clear_login_attempts, migration 20261007120501), so it holds across isolates
 * and cold starts, and the counting is atomic: every attempt is counted BEFORE
 * the password is checked, under a row lock, so a burst of parallel requests
 * cannot all slip in ahead of the count. A successful sign-in clears it.
 *
 * It fails CLOSED: if the RPC errors, the attempt is refused (as a 429, the
 * same answer the per-IP limiter gives when it cannot count), because an
 * outage of the limiter must not become an unthrottled password oracle.
 *
 * It does not leak whether an account exists: the key is derived from the
 * username as TYPED (normalized), whether or not any row has it, so a
 * made-up username locks out exactly like a real one. Keys are SHA-256 of the
 * username, so the table never holds a list of names people have tried.
 */

export interface LoginThrottlePolicy {
    /** Attempts allowed before the first lockout (the last of these sets it). */
    freeAttempts: number;
    /** First lockout; each further attempt after a lockout doubles it. */
    baseLockMs: number;
    /** Ceiling on a single lockout. */
    maxLockMs: number;
    /** A quiet period this long forgets the count. */
    decayMs: number;
}

/**
 * Student sign-in. Five tries is room for a child's typos; then 30 s, 1 min,
 * 2, 4, 8, and 15 min per attempt after that — ~100 guesses a day against one
 * account, against a password that must be 8+ characters with a letter and a
 * digit. An hour without attempts resets the count.
 *
 * The cost of an account limiter is that someone who knows a username can keep
 * that student locked out. The ceiling is kept at 15 minutes for that reason,
 * and the way back in does not go through this limiter: a teacher can issue a
 * fresh setup card, and student-claim hands the student a session directly.
 */
export const STUDENT_LOGIN_THROTTLE: LoginThrottlePolicy = {
    freeAttempts: 5,
    baseLockMs: 30_000,
    maxLockMs: 15 * 60_000,
    decayMs: 60 * 60_000,
};

export type LoginAttemptGate = { ok: true } | { ok: false; retryAfterSec: number };

/** What fail-closed answers with: try again shortly, like the per-IP limiter. */
const FAIL_CLOSED: LoginAttemptGate = { ok: false, retryAfterSec: 5 };

export interface RpcClient {
    rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** `<scope>:<sha256(account)>` — stable per account, never the name itself. */
export const accountThrottleKey = async (scope: string, account: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account));
    return `${scope}:${toHex(new Uint8Array(digest))}`;
};

/**
 * Count an attempt against `key`, or refuse it while the account is locked.
 * Call BEFORE checking the password; call clearLoginAttempts after a success.
 */
export const beginLoginAttempt = async (
    client: RpcClient,
    key: string,
    policy: LoginThrottlePolicy,
): Promise<LoginAttemptGate> => {
    try {
        const { data, error } = await client.rpc('begin_login_attempt', {
            p_key: key,
            p_free_attempts: policy.freeAttempts,
            p_base_lock_ms: policy.baseLockMs,
            p_max_lock_ms: policy.maxLockMs,
            p_decay_ms: policy.decayMs,
        });
        if (error || !data || typeof data !== 'object') {
            return FAIL_CLOSED;
        }
        const record = data as { ok?: unknown; retryAfterSec?: unknown };
        if (record.ok === true) {
            return { ok: true };
        }
        if (record.ok === false) {
            const retry = typeof record.retryAfterSec === 'number' ? Math.ceil(record.retryAfterSec) : 0;
            return { ok: false, retryAfterSec: Math.max(1, retry) };
        }
    } catch {
        // fall through to fail closed
    }
    return FAIL_CLOSED;
};

/**
 * Forget the count after a successful sign-in. Best effort: if it fails, the
 * student is already signed in, and the count decays on its own — at worst
 * their next few typos lock a little sooner.
 */
export const clearLoginAttempts = async (client: RpcClient, key: string): Promise<void> => {
    try {
        const { error } = await client.rpc('clear_login_attempts', { p_key: key });
        if (error) {
            console.error('clear_login_attempts failed');
        }
    } catch {
        console.error('clear_login_attempts failed');
    }
};

/** How a lockout is worded: the same for every username, real or not. */
export const tooManyAttemptsMessage = (retryAfterSec: number): string => {
    if (retryAfterSec < 60) {
        const seconds = Math.max(1, Math.ceil(retryAfterSec));
        return `Too many sign-in attempts. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
    }
    const minutes = Math.ceil(retryAfterSec / 60);
    return `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
};

/**
 * Every rejection takes at least this long from the start of the request.
 *
 * A refusal for a username nobody has is a single indexed lookup; a refusal for
 * a real one also reads the auth user and round-trips a bcrypt check through
 * GoTrue. Answering both at once would let the response TIME say which
 * usernames exist even though the body never does. Padding every rejection to
 * a floor well above GoTrue's usual latency removes that signal; a successful
 * sign-in is never delayed.
 */
export const REJECTION_FLOOR_MS = 1_000;

/** Resolves once `floorMs` has passed since `startedAt` (immediately if it has). */
export const waitForFloor = async (
    startedAt: number,
    floorMs: number = REJECTION_FLOOR_MS,
    now: () => number = Date.now,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> => {
    const remaining = startedAt + floorMs - now();
    if (remaining > 0) {
        await sleep(remaining);
    }
};
