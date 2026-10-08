import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    accountThrottleKey,
    beginLoginAttempt,
    clearLoginAttempts,
    REJECTION_FLOOR_MS,
    STUDENT_LOGIN_THROTTLE,
    tooManyAttemptsMessage,
    waitForFloor,
    type RpcClient,
} from '../../supabase/functions/_shared/loginThrottle';

/**
 * The per-account limiter student-login runs. The SQL behind the RPCs
 * (begin_login_attempt / clear_login_attempts, migration 20261007120501) was
 * exercised against the dev branch inside a rolled-back transaction: five free
 * attempts, then 30 s / 60 s / … locks capped at 15 min, refusals not counted,
 * decay after an hour, client roles without EXECUTE. These pin the edge side:
 * what it sends, how it reads the answer, and that every doubt fails closed.
 */

const rpcReturning = (result: { data: unknown; error: unknown }) => {
    const rpc = vi.fn<RpcClient['rpc']>(() => Promise.resolve(result));
    return { client: { rpc } satisfies RpcClient, rpc };
};

describe('accountThrottleKey', () => {
    it('is scoped, stable, and never contains the name itself', async () => {
        const key = await accountThrottleKey('student-login', 'cellist42');
        expect(key).toMatch(/^student-login:[0-9a-f]{64}$/);
        expect(key).not.toContain('cellist42');
        expect(await accountThrottleKey('student-login', 'cellist42')).toBe(key);
        expect(await accountThrottleKey('student-login', 'cellist43')).not.toBe(key);
        expect(await accountThrottleKey('other-scope', 'cellist42')).not.toBe(key);
    });

    it('fits the table key check (1..200 characters)', async () => {
        const key = await accountThrottleKey('student-login', 'x'.repeat(500));
        expect(key.length).toBeLessThanOrEqual(200);
    });
});

describe('beginLoginAttempt', () => {
    it('sends the key and the whole policy', async () => {
        const { client, rpc } = rpcReturning({ data: { ok: true, attempts: 1 }, error: null });
        expect(await beginLoginAttempt(client, 'student-login:abc', STUDENT_LOGIN_THROTTLE)).toEqual({ ok: true });
        expect(rpc).toHaveBeenCalledWith('begin_login_attempt', {
            p_key: 'student-login:abc',
            p_free_attempts: STUDENT_LOGIN_THROTTLE.freeAttempts,
            p_base_lock_ms: STUDENT_LOGIN_THROTTLE.baseLockMs,
            p_max_lock_ms: STUDENT_LOGIN_THROTTLE.maxLockMs,
            p_decay_ms: STUDENT_LOGIN_THROTTLE.decayMs,
        });
    });

    it('passes a lockout through, rounded up and never below one second', async () => {
        const locked = rpcReturning({ data: { ok: false, retryAfterSec: 29.2 }, error: null });
        expect(await beginLoginAttempt(locked.client, 'k', STUDENT_LOGIN_THROTTLE)).toEqual({
            ok: false,
            retryAfterSec: 30,
        });
        const zero = rpcReturning({ data: { ok: false, retryAfterSec: 0 }, error: null });
        expect(await beginLoginAttempt(zero.client, 'k', STUDENT_LOGIN_THROTTLE)).toEqual({
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
            const gate = await beginLoginAttempt(client, 'k', STUDENT_LOGIN_THROTTLE);
            expect(gate.ok).toBe(false);
            expect(gate.ok === false && gate.retryAfterSec).toBeGreaterThan(0);
        }
    });
});

describe('clearLoginAttempts', () => {
    it('clears the key, and a failure never reaches the signed-in student', async () => {
        const { client, rpc } = rpcReturning({ data: null, error: null });
        await clearLoginAttempts(client, 'student-login:abc');
        expect(rpc).toHaveBeenCalledWith('clear_login_attempts', { p_key: 'student-login:abc' });

        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        await expect(
            clearLoginAttempts(rpcReturning({ data: null, error: { message: 'x' } }).client, 'k'),
        ).resolves.toBeUndefined();
        await expect(
            clearLoginAttempts({ rpc: () => Promise.reject(new Error('down')) }, 'k'),
        ).resolves.toBeUndefined();
        quiet.mockRestore();
    });
});

describe('STUDENT_LOGIN_THROTTLE', () => {
    it('leaves room for typos but keeps a locked-out student waiting minutes, not hours', () => {
        expect(STUDENT_LOGIN_THROTTLE.freeAttempts).toBeGreaterThanOrEqual(3);
        expect(STUDENT_LOGIN_THROTTLE.freeAttempts).toBeLessThanOrEqual(10);
        expect(STUDENT_LOGIN_THROTTLE.maxLockMs).toBeLessThanOrEqual(15 * 60_000);
        expect(STUDENT_LOGIN_THROTTLE.baseLockMs).toBeLessThan(STUDENT_LOGIN_THROTTLE.maxLockMs);
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

describe('student-login wiring', () => {
    // Deno code, so not importable here; these read it for the two orderings
    // the limiter's guarantees depend on.
    const source = readFileSync(resolve(process.cwd(), 'supabase/functions/student-login/index.ts'), 'utf8');

    it('counts the attempt before anything about the account is looked up', () => {
        const gate = source.indexOf('beginLoginAttempt(admin');
        expect(gate).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(source.indexOf(".from('managed_students')"));
        expect(gate).toBeLessThan(source.indexOf('signInWithPassword('));
    });

    it('clears the count only after a successful sign-in', () => {
        expect(source.indexOf('clearLoginAttempts(admin')).toBeGreaterThan(source.indexOf('signInWithPassword('));
    });

    it('answers every credential failure through the floored rejection', () => {
        // The only un-floored 401 is the helper the floored one wraps.
        expect(source.match(/rejectNow\(\)/g)).toHaveLength(1);
        expect(source).not.toMatch(/return reject\(\);/);
    });
});
