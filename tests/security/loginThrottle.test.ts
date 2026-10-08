import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    accountThrottleKey,
    beginLoginAttempt,
    clearLoginAccount,
    clearLoginAttempts,
    forgetLoginAccount,
    loginThrottleKeys,
    REJECTION_FLOOR_MS,
    STUDENT_LOGIN_SCOPE,
    STUDENT_LOGIN_THROTTLE,
    tooManyAttemptsMessage,
    waitForFloor,
    type RpcClient,
} from '../../supabase/functions/_shared/loginThrottle';

/**
 * The per-username limiter student-login runs. The SQL behind the RPCs
 * (begin_login_attempt / clear_login_attempts / clear_login_account, migration
 * 20261007120501) was exercised against the dev branch inside a rolled-back
 * transaction: five free attempts per source, then 30 s / 60 s / … locks
 * capped at 15 min that shut out only that source; the account ceiling shared
 * by every source; refusals counted nowhere; clear_login_account reaching
 * every source row and nothing else; client roles without EXECUTE. These pin
 * the edge side: the keys, what it sends, how it reads the answer, and that
 * every doubt fails closed. tests/security/studentLogin.test.ts drives the
 * handler itself.
 */

const SECRET = 'test-throttle-secret';

const rpcReturning = (result: { data: unknown; error: unknown }) => {
    const rpc = vi.fn<RpcClient['rpc']>(() => Promise.resolve(result));
    return { client: { rpc } satisfies RpcClient, rpc };
};

const sha256Hex = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

describe('loginThrottleKeys', () => {
    it('nests the source key under the account key, and names neither the user nor the address', async () => {
        const keys = await loginThrottleKeys(SECRET, STUDENT_LOGIN_SCOPE, 'cellist42', '203.0.113.7');
        expect(keys.account).toMatch(/^student-login:[0-9a-f]{64}$/);
        expect(keys.source).toMatch(/^student-login:[0-9a-f]{64}:[0-9a-f]{64}$/);
        expect(keys.source.startsWith(`${keys.account}:`)).toBe(true);
        expect(keys.source).not.toContain('cellist42');
        expect(keys.source).not.toContain('203.0.113.7');
        expect(keys.account).toBe(await accountThrottleKey(SECRET, STUDENT_LOGIN_SCOPE, 'cellist42'));
    });

    it('is stable, and separates usernames, addresses and scopes', async () => {
        const keys = await loginThrottleKeys(SECRET, STUDENT_LOGIN_SCOPE, 'cellist42', '203.0.113.7');
        expect(await loginThrottleKeys(SECRET, STUDENT_LOGIN_SCOPE, 'cellist42', '203.0.113.7')).toEqual(keys);

        const otherAddress = await loginThrottleKeys(SECRET, STUDENT_LOGIN_SCOPE, 'cellist42', '198.51.100.1');
        expect(otherAddress.account).toBe(keys.account);
        expect(otherAddress.source).not.toBe(keys.source);

        const otherName = await loginThrottleKeys(SECRET, STUDENT_LOGIN_SCOPE, 'cellist43', '203.0.113.7');
        expect(otherName.account).not.toBe(keys.account);
        expect(await accountThrottleKey(SECRET, 'other-scope', 'cellist42')).not.toBe(keys.account);
    });

    it('is keyed by the secret — not an unsalted hash anyone could reverse over the username space', async () => {
        const keys = await loginThrottleKeys(SECRET, STUDENT_LOGIN_SCOPE, 'cellist42', '203.0.113.7');
        const otherSecret = await loginThrottleKeys('another-secret', STUDENT_LOGIN_SCOPE, 'cellist42', '203.0.113.7');
        expect(otherSecret.account).not.toBe(keys.account);
        expect(keys.account).not.toContain(await sha256Hex('cellist42'));
    });

    it('refuses to derive keys without a secret', async () => {
        await expect(loginThrottleKeys('', STUDENT_LOGIN_SCOPE, 'cellist42', 'x')).rejects.toThrow();
    });

    it('fits the table key check (1..200 characters) whatever it is given', async () => {
        const keys = await loginThrottleKeys(SECRET, STUDENT_LOGIN_SCOPE, 'x'.repeat(500), 'y'.repeat(500));
        expect(keys.source.length).toBeLessThanOrEqual(200);
    });
});

describe('beginLoginAttempt', () => {
    const keys = { account: 'student-login:aaa', source: 'student-login:aaa:bbb' };

    it('sends both keys and the whole policy', async () => {
        const { client, rpc } = rpcReturning({ data: { ok: true, attempts: 1, accountAttempts: 1 }, error: null });
        expect(await beginLoginAttempt(client, keys, STUDENT_LOGIN_THROTTLE)).toEqual({ ok: true });
        expect(rpc).toHaveBeenCalledWith('begin_login_attempt', {
            p_account_key: keys.account,
            p_source_key: keys.source,
            p_free_attempts: STUDENT_LOGIN_THROTTLE.freeAttempts,
            p_base_lock_ms: STUDENT_LOGIN_THROTTLE.baseLockMs,
            p_max_lock_ms: STUDENT_LOGIN_THROTTLE.maxLockMs,
            p_decay_ms: STUDENT_LOGIN_THROTTLE.decayMs,
            p_account_limit: STUDENT_LOGIN_THROTTLE.accountLimit,
            p_account_window_ms: STUDENT_LOGIN_THROTTLE.accountWindowMs,
        });
    });

    it('passes either lockout through, rounded up and never below one second', async () => {
        const source = rpcReturning({ data: { ok: false, scope: 'source', retryAfterSec: 29.2 }, error: null });
        expect(await beginLoginAttempt(source.client, keys, STUDENT_LOGIN_THROTTLE)).toEqual({
            ok: false,
            retryAfterSec: 30,
        });
        const account = rpcReturning({ data: { ok: false, scope: 'account', retryAfterSec: 1800 }, error: null });
        expect(await beginLoginAttempt(account.client, keys, STUDENT_LOGIN_THROTTLE)).toEqual({
            ok: false,
            retryAfterSec: 1800,
        });
        const zero = rpcReturning({ data: { ok: false, retryAfterSec: 0 }, error: null });
        expect(await beginLoginAttempt(zero.client, keys, STUDENT_LOGIN_THROTTLE)).toEqual({
            ok: false,
            retryAfterSec: 1,
        });
    });

    it('fails CLOSED on an RPC error, a throw, or an answer it cannot read', async () => {
        const answers = [
            rpcReturning({ data: null, error: { message: 'permission denied' } }).client,
            rpcReturning({ data: null, error: null }).client,
            rpcReturning({ data: 'ok', error: null }).client,
            rpcReturning({ data: { ok: 'yes' }, error: null }).client,
            { rpc: () => Promise.reject(new Error('network')) } satisfies RpcClient,
            {
                rpc: () => {
                    throw new Error('sync throw');
                },
            } satisfies RpcClient,
        ];
        for (const client of answers) {
            const gate = await beginLoginAttempt(client, keys, STUDENT_LOGIN_THROTTLE);
            expect(gate.ok).toBe(false);
            expect(gate.ok === false && gate.retryAfterSec).toBeGreaterThan(0);
        }
    });
});

describe('clearing', () => {
    it('clearLoginAttempts clears one source, and a failure never reaches the signed-in student', async () => {
        const { client, rpc } = rpcReturning({ data: null, error: null });
        await clearLoginAttempts(client, 'student-login:aaa:bbb');
        expect(rpc).toHaveBeenCalledWith('clear_login_attempts', { p_key: 'student-login:aaa:bbb' });

        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(
            clearLoginAttempts(rpcReturning({ data: null, error: { message: 'x' } }).client, 'k'),
        ).resolves.toBeUndefined();
        await expect(
            clearLoginAttempts({ rpc: () => Promise.reject(new Error('down')) }, 'k'),
        ).resolves.toBeUndefined();
        quiet.mockRestore();
    });

    it('clearLoginAccount says whether it worked and never throws', async () => {
        const { client, rpc } = rpcReturning({ data: 3, error: null });
        expect(await clearLoginAccount(client, 'student-login:aaa')).toBe(true);
        expect(rpc).toHaveBeenCalledWith('clear_login_account', { p_account_key: 'student-login:aaa' });

        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await clearLoginAccount(rpcReturning({ data: null, error: { message: 'x' } }).client, 'k')).toBe(false);
        expect(await clearLoginAccount({ rpc: () => Promise.reject(new Error('down')) }, 'k')).toBe(false);
        quiet.mockRestore();
    });

    it('forgetLoginAccount clears the same account key student-login counts under', async () => {
        const { client, rpc } = rpcReturning({ data: 2, error: null });
        expect(await forgetLoginAccount(client, SECRET, STUDENT_LOGIN_SCOPE, 'cellist42')).toBe(true);
        const keys = await loginThrottleKeys(SECRET, STUDENT_LOGIN_SCOPE, 'cellist42', '203.0.113.7');
        expect(rpc).toHaveBeenCalledWith('clear_login_account', { p_account_key: keys.account });
    });

    it('forgetLoginAccount without a secret reports and resolves false, never throws', async () => {
        const { client, rpc } = rpcReturning({ data: 2, error: null });
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await forgetLoginAccount(client, null, STUDENT_LOGIN_SCOPE, 'cellist42')).toBe(false);
        quiet.mockRestore();
        expect(rpc).not.toHaveBeenCalled();
    });
});

describe('STUDENT_LOGIN_THROTTLE', () => {
    it('leaves room for typos but keeps a locked-out address waiting minutes, not hours', () => {
        expect(STUDENT_LOGIN_THROTTLE.freeAttempts).toBeGreaterThanOrEqual(3);
        expect(STUDENT_LOGIN_THROTTLE.freeAttempts).toBeLessThanOrEqual(10);
        expect(STUDENT_LOGIN_THROTTLE.maxLockMs).toBeLessThanOrEqual(15 * 60_000);
        expect(STUDENT_LOGIN_THROTTLE.baseLockMs).toBeLessThan(STUDENT_LOGIN_THROTTLE.maxLockMs);
    });

    it('sets the shared account ceiling far above one address, but still a cap on guessing', () => {
        // What one address can spend in a window under the steep backoff: its
        // free attempts plus one per lock period as the locks double.
        let perAddress = STUDENT_LOGIN_THROTTLE.freeAttempts;
        let elapsed = 0;
        let lock = STUDENT_LOGIN_THROTTLE.baseLockMs;
        while (elapsed + lock <= STUDENT_LOGIN_THROTTLE.accountWindowMs) {
            elapsed += lock;
            perAddress += 1;
            lock = Math.min(lock * 2, STUDENT_LOGIN_THROTTLE.maxLockMs);
        }
        // One griefing address (or a whole classroom NAT) cannot reach it alone.
        expect(STUDENT_LOGIN_THROTTLE.accountLimit).toBeGreaterThan(perAddress * 2);
        // ...and it is a real ceiling: at most ~50 guesses an hour per account.
        expect(STUDENT_LOGIN_THROTTLE.accountLimit).toBeLessThanOrEqual(50);
        expect(STUDENT_LOGIN_THROTTLE.accountWindowMs).toBeLessThanOrEqual(60 * 60_000);
    });
});

describe('tooManyAttemptsMessage', () => {
    it('says how long, in the unit a person would', () => {
        expect(tooManyAttemptsMessage(1)).toBe('Too many sign-in attempts. Try again in 1 second.');
        expect(tooManyAttemptsMessage(30)).toBe('Too many sign-in attempts. Try again in 30 seconds.');
        expect(tooManyAttemptsMessage(60)).toBe('Too many sign-in attempts. Try again in 1 minute.');
        expect(tooManyAttemptsMessage(61)).toBe('Too many sign-in attempts. Try again in 2 minutes.');
        expect(tooManyAttemptsMessage(900)).toBe('Too many sign-in attempts. Try again in 15 minutes.');
    });
});

describe('waitForFloor', () => {
    it('sleeps out whatever is left of the floor', async () => {
        const sleep = vi.fn(() => Promise.resolve());
        await waitForFloor(1_000, REJECTION_FLOOR_MS, () => 1_250, sleep);
        expect(sleep).toHaveBeenCalledWith(REJECTION_FLOOR_MS - 250);
    });

    it('does not sleep once the floor has passed', async () => {
        const sleep = vi.fn(() => Promise.resolve());
        await waitForFloor(1_000, REJECTION_FLOOR_MS, () => 1_000 + REJECTION_FLOOR_MS + 5, sleep);
        expect(sleep).not.toHaveBeenCalled();
    });
});

describe('recovery paths lift the limits', () => {
    // Deno entry points, so not importable here; these read them for the one
    // ordering that matters — the clear comes only once the reset or claim has
    // actually been written.
    const read = (fn: string) => readFileSync(resolve(process.cwd(), `supabase/functions/${fn}/index.ts`), 'utf8');

    it("student-provision 'reset' clears the student's username after the new code is stored", () => {
        const source = read('student-provision');
        const reset = source.slice(source.indexOf('const resetStudentAccess'), source.indexOf('const archiveStudent'));
        const forget = reset.indexOf(
            'forgetLoginAccount(admin, loginThrottleSecret(), STUDENT_LOGIN_SCOPE, row.username)',
        );
        expect(forget).toBeGreaterThan(-1);
        expect(forget).toBeGreaterThan(reset.indexOf('.update({ login_code_hash: loginCodeHash, claimed_at: null })'));
    });

    it('student-claim clears the claimed username after the claim commits', () => {
        const source = read('student-claim');
        const forget = source.indexOf(
            'forgetLoginAccount(admin, loginThrottleSecret(), STUDENT_LOGIN_SCOPE, username)',
        );
        expect(forget).toBeGreaterThan(-1);
        expect(forget).toBeGreaterThan(source.indexOf('if (!claimed) {'));
        expect(forget).toBeLessThan(source.indexOf('signInWithPassword('));
    });
});
