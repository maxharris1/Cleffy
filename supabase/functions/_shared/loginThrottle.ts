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
 * 60 passwords a minute per address against one child's username.
 *
 * Two limits, because one would be a lockout service. A steep per-account
 * backoff alone lets anyone who knows a username (a classmate) keep that
 * student locked out with one request per lock period. So:
 *
 *  * SOURCE: the steep backoff — a handful of tries, then an exponentially
 *    growing lock — applies per (username, client address). Whoever hammers a
 *    username locks out only their own address; the student signing in from
 *    home, or from a phone on mobile data, is not touched.
 *  * ACCOUNT: a loose fixed-window ceiling per username across all addresses,
 *    there only to cap many-address guessing. It sits far above what any real
 *    student does, so tripping it takes a sustained distributed effort rather
 *    than a stray request every fifteen minutes, and it lifts on its own when
 *    the window ends.
 *
 * And a way back that does not wait: a teacher's 'reset' (student-provision)
 * and the student's own successful claim (student-claim) clear every row for
 * the username through clear_login_account.
 *
 * The state lives in Postgres (edge_login_attempts via begin_login_attempt /
 * clear_login_attempts / clear_login_account, migration 20261007120501), so it
 * holds across isolates and cold starts, and the counting is atomic: every
 * attempt is counted BEFORE the password is checked, under row locks, so a
 * burst of parallel requests cannot all slip in ahead of the count. A
 * successful sign-in clears that source's backoff.
 *
 * It fails CLOSED: if the RPC errors, the attempt is refused (as a 429, the
 * same answer the per-IP limiter gives when it cannot count), because an
 * outage of the limiter must not become an unthrottled password oracle.
 *
 * It does not leak whether an account exists: the keys are derived from the
 * username as TYPED (normalized), whether or not any row has it, so a made-up
 * username locks out exactly like a real one.
 *
 * Keys are HMAC-SHA-256 under a server-side secret, not plain hashes: a
 * username is short and low-entropy, so an unkeyed SHA-256 of it is reversible
 * by enumerating the username space, and the same goes doubly for an IPv4
 * address. With the secret, the table (and its backups) holds neither the
 * names people tried nor where they tried from.
 */

export interface LoginThrottlePolicy {
    /** Attempts one source gets before its first lock (the last of these sets it). */
    freeAttempts: number;
    /** A source's first lock; each further attempt after a lock doubles it. */
    baseLockMs: number;
    /** Ceiling on a single source lock. */
    maxLockMs: number;
    /** A source quiet this long starts over. */
    decayMs: number;
    /** Attempts one account takes per window, from every source together. */
    accountLimit: number;
    /** The account window. */
    accountWindowMs: number;
}

/**
 * Student sign-in. Per address: five tries is room for a child's typos; then
 * 30 s, 1 min, 2, 4, 8, and 15 min per attempt after that, and an hour without
 * attempts resets the count. Per username, from everywhere: 30 attempts an
 * hour — no child gets near it, and it holds many-address guessing to ~720 a
 * day against a password that must be 8+ characters with a letter and a digit.
 * Holding a student out through that ceiling means landing 30 attempts every
 * hour, which the per-address backoff makes cost eight or more addresses kept
 * busy around the clock.
 */
export const STUDENT_LOGIN_THROTTLE: LoginThrottlePolicy = {
    freeAttempts: 5,
    baseLockMs: 30_000,
    maxLockMs: 15 * 60_000,
    decayMs: 60 * 60_000,
    accountLimit: 30,
    accountWindowMs: 60 * 60_000,
};

/** The scope student-login's keys live under. */
export const STUDENT_LOGIN_SCOPE = 'student-login';

export type LoginAttemptGate = { ok: true } | { ok: false; retryAfterSec: number };

/** What fail-closed answers with: try again shortly, like the per-IP limiter. */
const FAIL_CLOSED: LoginAttemptGate = { ok: false, retryAfterSec: 5 };

export interface RpcClient {
    rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const hmacHex = async (secret: string, message: string): Promise<string> => {
    if (!secret) {
        // An empty key would make the keys plain, enumerable hashes again.
        throw new Error('login throttle secret is missing');
    }
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
    ]);
    return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
};

/**
 * `<scope>:<hmac(account)>` — one account's ceiling, and the prefix every one
 * of its source keys starts with (which is what lets clear_login_account reach
 * them all). The NUL separators keep a scope, an account and an address from
 * ever running together into somebody else's message.
 */
export const accountThrottleKey = async (secret: string, scope: string, account: string): Promise<string> =>
    `${scope}:${await hmacHex(secret, `account\u0000${scope}\u0000${account}`)}`;

export interface LoginThrottleKeys {
    account: string;
    source: string;
}

/** Both keys for one attempt: the account's, and `<account key>:<hmac(client)>`. */
export const loginThrottleKeys = async (
    secret: string,
    scope: string,
    account: string,
    client: string,
): Promise<LoginThrottleKeys> => {
    const accountKey = await accountThrottleKey(secret, scope, account);
    const clientDigest = await hmacHex(secret, `client\u0000${scope}\u0000${client}`);
    return { account: accountKey, source: `${accountKey}:${clientDigest}` };
};

/**
 * Count an attempt, or refuse it while this source is locked or the account is
 * at its ceiling. Call BEFORE checking the password; call clearLoginAttempts
 * with `keys.source` after a success.
 */
export const beginLoginAttempt = async (
    client: RpcClient,
    keys: LoginThrottleKeys,
    policy: LoginThrottlePolicy,
): Promise<LoginAttemptGate> => {
    try {
        const { data, error } = await client.rpc('begin_login_attempt', {
            p_account_key: keys.account,
            p_source_key: keys.source,
            p_free_attempts: policy.freeAttempts,
            p_base_lock_ms: policy.baseLockMs,
            p_max_lock_ms: policy.maxLockMs,
            p_decay_ms: policy.decayMs,
            p_account_limit: policy.accountLimit,
            p_account_window_ms: policy.accountWindowMs,
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
 * Forget one source's backoff after a successful sign-in. Best effort: if it
 * fails, the student is already signed in, and the count decays on its own —
 * at worst their next few typos lock a little sooner.
 */
export const clearLoginAttempts = async (client: RpcClient, sourceKey: string): Promise<void> => {
    try {
        const { error } = await client.rpc('clear_login_attempts', { p_key: sourceKey });
        if (error) {
            console.error('clear_login_attempts failed');
        }
    } catch {
        console.error('clear_login_attempts failed');
    }
};

/**
 * Forget everything about one account — its ceiling and every source's
 * backoff. For the recovery paths (a teacher's reset, a successful claim), and
 * best effort there too: the reset or claim it follows has already happened,
 * and failing it now would only hide that. Resolves to whether it worked.
 */
export const clearLoginAccount = async (client: RpcClient, accountKey: string): Promise<boolean> => {
    try {
        const { error } = await client.rpc('clear_login_account', { p_account_key: accountKey });
        if (!error) {
            return true;
        }
    } catch {
        // reported below
    }
    console.error('clear_login_account failed');
    return false;
};

/**
 * clearLoginAccount for a username rather than a key, for the recovery paths.
 * A secret that is missing, or a key that cannot be derived, is reported and
 * resolves false like any other failure — never a throw into a reset or claim
 * that has already happened.
 */
export const forgetLoginAccount = async (
    client: RpcClient,
    secret: string | null,
    scope: string,
    account: string,
): Promise<boolean> => {
    let accountKey: string;
    try {
        accountKey = await accountThrottleKey(secret ?? '', scope, account);
    } catch {
        console.error('clear_login_account skipped: no throttle key');
        return false;
    }
    return clearLoginAccount(client, accountKey);
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
