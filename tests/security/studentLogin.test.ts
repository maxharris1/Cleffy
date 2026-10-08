// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import * as throttle from '../../supabase/functions/_shared/loginThrottle';
import { normalizeUsername, USERNAME_RE } from '../../supabase/functions/_shared/studentCodes';
import {
    handleStudentLogin,
    REJECTED,
    type StudentLoginBackend,
    type StudentLoginDeps,
} from '../../supabase/functions/student-login/handler';

/**
 * student-login's control flow, run for real against stub clients: the
 * per-username gate is counted before anything about the account is looked
 * up, a refusal stops there, a source is cleared only after GoTrue accepts the
 * password, and every credential failure is the same floored 401. The limiter
 * module is the real one, so the keys and RPC arguments are what production
 * sends.
 */

const SECRET = 'test-throttle-secret';
const CLIENT_IP = '203.0.113.7';
const STARTED_AT = 1_000_000;

type RpcAnswer = { data: unknown; error: unknown };

interface Harness {
    deps: StudentLoginDeps;
    calls: string[];
    rpc: ReturnType<typeof vi.fn>;
    sleep: ReturnType<typeof vi.fn>;
    logError: ReturnType<typeof vi.fn>;
    checkRateLimit: ReturnType<typeof vi.fn>;
}

const harness = (
    options: {
        ipGate?: { ok: true } | { ok: false; retryAfterSec: number };
        begin?: RpcAnswer | (() => Promise<RpcAnswer>);
        student?: { id: string; studentUserId: string; displayName: string } | null;
        authUser?: { email: string | null; userType: unknown } | null;
        session?: { accessToken: string; refreshToken: string } | null;
        backend?: 'none';
        clientIp?: string;
    } = {},
): Harness => {
    const calls: string[] = [];
    const rpc = vi.fn((fn: string, args: Record<string, unknown>) => {
        calls.push(`rpc:${fn}`);
        void args;
        if (fn === 'begin_login_attempt') {
            const begin = options.begin ?? { data: { ok: true, attempts: 1, accountAttempts: 1 }, error: null };
            return typeof begin === 'function' ? begin() : Promise.resolve(begin);
        }
        return Promise.resolve({ data: null, error: null });
    });
    const backend: StudentLoginBackend = {
        rpc: { rpc },
        throttleSecret: SECRET,
        findClaimedStudent: async (username) => {
            calls.push(`find:${username}`);
            return options.student === undefined
                ? { id: 'row-1', studentUserId: 'user-1', displayName: 'Ada' }
                : options.student;
        },
        readAuthUser: async (userId) => {
            calls.push(`user:${userId}`);
            return options.authUser === undefined
                ? { email: 'st-row-1@students.cleffy.app', userType: 'student' }
                : options.authUser;
        },
        signIn: async (email, password) => {
            calls.push(`signIn:${email}:${password}`);
            return options.session === undefined ? { accessToken: 'at', refreshToken: 'rt' } : options.session;
        },
    };
    const sleep = vi.fn(() => Promise.resolve());
    const logError = vi.fn();
    const checkRateLimit = vi.fn(async (key: string) => {
        calls.push(`ip:${key}`);
        return options.ipGate ?? { ok: true as const };
    });
    const deps: StudentLoginDeps = {
        json: (body, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
        options: () => new Response('ok'),
        clientKey: () => options.clientIp ?? CLIENT_IP,
        checkRateLimit,
        codes: { normalizeUsername, USERNAME_RE },
        throttle,
        backend: () => (options.backend === 'none' ? null : backend),
        // The clock never moves, so every floored rejection sleeps the whole floor.
        now: () => STARTED_AT,
        sleep,
        logError,
    };
    return { deps, calls, rpc, sleep, logError, checkRateLimit };
};

const post = (body: unknown) =>
    new Request('https://edge.test/functions/v1/student-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });

const goodBody = { username: 'cellist42', password: 'Correct1horse' };

const expectFlooredRejection = async (h: Harness, response: Response) => {
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(REJECTED);
    expect(h.sleep).toHaveBeenCalledWith(throttle.REJECTION_FLOOR_MS);
};

describe('student-login handler', () => {
    it('signs in: per-IP gate, then the per-username count, then the account, then GoTrue, then the clear', async () => {
        const h = harness();
        const response = await handleStudentLogin(post(goodBody), h.deps);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            accessToken: 'at',
            refreshToken: 'rt',
            displayName: 'Ada',
            username: 'cellist42',
        });
        expect(h.calls).toEqual([
            `ip:student-login:${CLIENT_IP}`,
            'rpc:begin_login_attempt',
            'find:cellist42',
            'user:user-1',
            'signIn:st-row-1@students.cleffy.app:Correct1horse',
            'rpc:clear_login_attempts',
        ]);
        // A success is never delayed.
        expect(h.sleep).not.toHaveBeenCalled();
    });

    it('counts under the keys for this username and THIS address, and clears only that source', async () => {
        const h = harness();
        await handleStudentLogin(post(goodBody), h.deps);
        const keys = await throttle.loginThrottleKeys(SECRET, throttle.STUDENT_LOGIN_SCOPE, 'cellist42', CLIENT_IP);
        expect(h.rpc).toHaveBeenCalledWith(
            'begin_login_attempt',
            expect.objectContaining({ p_account_key: keys.account, p_source_key: keys.source }),
        );
        expect(h.rpc).toHaveBeenCalledWith('clear_login_attempts', { p_key: keys.source });
    });

    it('normalizes the username before keying, so a capital letter is not a fresh set of attempts', async () => {
        const h = harness();
        await handleStudentLogin(post({ ...goodBody, username: '  Cellist42 ' }), h.deps);
        const keys = await throttle.loginThrottleKeys(SECRET, throttle.STUDENT_LOGIN_SCOPE, 'cellist42', CLIENT_IP);
        expect(h.rpc).toHaveBeenCalledWith(
            'begin_login_attempt',
            expect.objectContaining({ p_account_key: keys.account, p_source_key: keys.source }),
        );
    });

    it('a locked username is refused with 429 before anything about the account is looked up', async () => {
        const h = harness({ begin: { data: { ok: false, scope: 'source', retryAfterSec: 120 }, error: null } });
        const response = await handleStudentLogin(post(goodBody), h.deps);
        expect(response.status).toBe(429);
        expect(await response.json()).toEqual({
            error: 'Too many sign-in attempts. Try again in 2 minutes.',
            code: 'too_many_attempts',
            retryAfterSec: 120,
        });
        expect(h.calls).toEqual([`ip:student-login:${CLIENT_IP}`, 'rpc:begin_login_attempt']);
    });

    it('fails closed when the limiter cannot count', async () => {
        const h = harness({ begin: { data: null, error: { message: 'function does not exist' } } });
        const response = await handleStudentLogin(post(goodBody), h.deps);
        expect(response.status).toBe(429);
        expect((await response.json()).code).toBe('too_many_attempts');
        expect(h.calls).not.toContain('find:cellist42');
        expect(h.calls.some((call) => call.startsWith('signIn:'))).toBe(false);
    });

    it('a wrong password is the floored 401, and the attempt stays counted', async () => {
        const h = harness({ session: null });
        const response = await handleStudentLogin(post(goodBody), h.deps);
        await expectFlooredRejection(h, response);
        expect(h.calls).toContain('rpc:begin_login_attempt');
        expect(h.calls).not.toContain('rpc:clear_login_attempts');
    });

    it('an unknown username is counted exactly like a real one and answers the same floored 401', async () => {
        const h = harness({ student: null });
        const response = await handleStudentLogin(post({ ...goodBody, username: 'nobody_here' }), h.deps);
        await expectFlooredRejection(h, response);
        expect(h.calls).toEqual([`ip:student-login:${CLIENT_IP}`, 'rpc:begin_login_attempt', 'find:nobody_here']);
    });

    it('an account that is not a provisioned student is refused and reported', async () => {
        const h = harness({ authUser: { email: 'teacher@example.com', userType: undefined } });
        const response = await handleStudentLogin(post(goodBody), h.deps);
        await expectFlooredRejection(h, response);
        expect(h.logError).toHaveBeenCalledWith(expect.stringContaining('not a provisioned student'));
        expect(h.calls.some((call) => call.startsWith('signIn:'))).toBe(false);
    });

    it('an unreadable auth user is refused and reported', async () => {
        const h = harness({ authUser: null });
        const response = await handleStudentLogin(post(goodBody), h.deps);
        await expectFlooredRejection(h, response);
        expect(h.logError).toHaveBeenCalledWith(expect.stringContaining('cannot be read'));
    });

    it('a malformed username or an empty password is the same floored 401, and counts against nothing', async () => {
        for (const body of [
            { username: 'no', password: 'Correct1horse' },
            { username: 'has space', password: 'Correct1horse' },
            { username: 42, password: 'Correct1horse' },
            { username: 'cellist42', password: '' },
            {},
            null,
        ]) {
            const h = harness();
            const response = await handleStudentLogin(post(body), h.deps);
            await expectFlooredRejection(h, response);
            expect(h.rpc).not.toHaveBeenCalled();
        }
    });

    it('the per-IP limit refuses before the body is even read', async () => {
        const h = harness({ ipGate: { ok: false, retryAfterSec: 12 } });
        const response = await handleStudentLogin(post('not json at all'), h.deps);
        expect(response.status).toBe(429);
        expect(await response.json()).toEqual({ error: 'Too many requests', retryAfterSec: 12 });
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('answers a body that is not JSON with 400', async () => {
        const h = harness();
        const response = await handleStudentLogin(post('{'), h.deps);
        expect(response.status).toBe(400);
        expect(h.rpc).not.toHaveBeenCalled();
    });

    it('a deploy without the service role, anon key or throttle secret is a 500, not an open door', async () => {
        const h = harness({ backend: 'none' });
        const response = await handleStudentLogin(post(goodBody), h.deps);
        expect(response.status).toBe(500);
    });

    it('answers preflight and refuses other methods', async () => {
        const h = harness();
        expect(
            await (await handleStudentLogin(new Request('https://edge.test/', { method: 'OPTIONS' }), h.deps)).text(),
        ).toBe('ok');
        expect((await handleStudentLogin(new Request('https://edge.test/', { method: 'GET' }), h.deps)).status).toBe(
            405,
        );
        expect(h.checkRateLimit).not.toHaveBeenCalled();
    });

    it('a griefer locking a username from one address does not touch the student signing in from another', async () => {
        // The SQL keeps a lock per source key; here the stub plays that table.
        const locked = new Set<string>();
        const begin = (args: Record<string, unknown>): RpcAnswer =>
            locked.has(String(args['p_source_key']))
                ? { data: { ok: false, scope: 'source', retryAfterSec: 900 }, error: null }
                : { data: { ok: true, attempts: 1, accountAttempts: 1 }, error: null };

        const griefer = harness({ clientIp: '198.51.100.66', session: null });
        griefer.rpc.mockImplementation((fn: string, args: Record<string, unknown>) =>
            Promise.resolve(fn === 'begin_login_attempt' ? begin(args) : { data: null, error: null }),
        );
        await handleStudentLogin(post(goodBody), griefer.deps);
        const grieferKey = (griefer.rpc.mock.calls[0]?.[1] as Record<string, unknown>)['p_source_key'];
        locked.add(String(grieferKey));
        expect((await handleStudentLogin(post(goodBody), griefer.deps)).status).toBe(429);

        const student = harness();
        student.rpc.mockImplementation((fn: string, args: Record<string, unknown>) =>
            Promise.resolve(fn === 'begin_login_attempt' ? begin(args) : { data: null, error: null }),
        );
        expect((await handleStudentLogin(post(goodBody), student.deps)).status).toBe(200);
    });
});
