import { describe, expect, it, vi } from 'vitest';

import { passwordProblem, passwordProblemMessage } from '../../supabase/functions/_shared/passwordPolicy';
import { PAYLOAD_TOO_LARGE, readCappedJson } from '../../supabase/functions/_shared/readCappedJson';
import {
    hashLoginCode,
    isPlausibleLoginCode,
    isValidUsername,
    normalizeLoginCode,
    normalizeUsername,
    USERNAME_MAX,
    USERNAME_MIN,
} from '../../supabase/functions/_shared/studentCodes';
import {
    BODY_MAX_BYTES,
    CAPTCHA_FAILED,
    CLAIM_IN_PROGRESS,
    type ClaimReservation,
    handleStudentClaim,
    REJECTED,
    type StudentClaimBackend,
    type StudentClaimDeps,
    USERNAME_TAKEN,
} from '../../supabase/functions/student-claim/handler';
import { chunkedJson } from './chunkedBody';

/**
 * student-claim against an in-memory roster that behaves like
 * 20261022110000_student_claim_reservation.sql (tests/sql/
 * student_claim_reservation.sql proves the SQL itself). Every backend step can
 * be paused, so two requests — or a request and a teacher's reset — can be
 * interleaved at exactly the point that used to go wrong.
 */

const TTL_MS = 600_000;
const CODE_A = 'ABCD-EFGH-JKMN';
const CODE_B = 'PQRS-TUVW-XYZ2';

interface Row {
    id: string;
    userId: string;
    hash: string | null;
    archived: boolean;
    claimed: boolean;
    username: string | null;
}

interface Held {
    reservation: string;
    kind: 'claim' | 'reset';
    hash: string | null;
    until: number;
}

type Step = keyof StudentClaimBackend;

class Roster {
    rows = new Map<string, Row>();
    held = new Map<string, Held>();
    passwords = new Map<string, string>();
    sessions = new Set<string>();
    now = 1_000_000;
    private ids = 0;
    private gates = new Map<Step, Array<{ arrived: () => void; go: Promise<void> }>>();

    add(id: string, hash: string): void {
        this.rows.set(id, { id, userId: `user-${id}`, hash, archived: false, claimed: false, username: null });
    }

    /** The next call to `step` waits at its start until `resume()`; `arrived` resolves when it gets there. */
    pause(step: Step): { arrived: Promise<void>; resume: () => void } {
        let resume = () => undefined as void;
        let arrived = () => undefined as void;
        const arrivedP = new Promise<void>((r) => (arrived = r));
        const go = new Promise<void>((r) => (resume = r));
        const list = this.gates.get(step) ?? [];
        list.push({ arrived, go });
        this.gates.set(step, list);
        return { arrived: arrivedP, resume };
    }

    private async gate(step: Step): Promise<void> {
        const next = this.gates.get(step)?.shift();
        if (next) {
            next.arrived();
            await next.go;
        }
    }

    private live(h: Held | undefined): h is Held {
        return Boolean(h && h.until > this.now);
    }

    reserve(hash: string): ClaimReservation {
        const matches = [...this.rows.values()].filter((r) => r.hash === hash && !r.archived && !r.claimed);
        const row = matches.length === 1 ? matches[0] : undefined;
        if (!row) {
            return { status: 'not_found' };
        }
        const held = this.held.get(row.id);
        if (this.live(held)) {
            return { status: 'busy', retryAfterSec: Math.ceil((held.until - this.now) / 1000) };
        }
        const reservation = `res-${++this.ids}`;
        this.held.set(row.id, { reservation, kind: 'claim', hash, until: this.now + TTL_MS });
        return { status: 'reserved', reservation, studentId: row.id, studentUserId: row.userId, displayName: 'Ada' };
    }

    complete(id: string, reservation: string, hash: string, username: string): 'claimed' | 'lost' | 'username_taken' {
        const held = this.held.get(id);
        const row = this.rows.get(id);
        if (!held || held.reservation !== reservation || held.kind !== 'claim' || held.hash !== hash || !row) {
            return 'lost';
        }
        if (row.hash !== hash || row.archived || row.claimed) {
            return 'lost';
        }
        if ([...this.rows.values()].some((r) => r.id !== id && r.username === username)) {
            return 'username_taken';
        }
        Object.assign(row, { username, claimed: true, hash: null });
        this.held.delete(id);
        return 'claimed';
    }

    release(id: string, reservation: string): void {
        if (this.held.get(id)?.reservation === reservation) {
            this.held.delete(id);
        }
    }

    /** student-provision's reset: begin_student_code_reset, then the scramble, then the new hash. */
    beginReset(id: string): 'reserved' | 'busy' {
        const held = this.held.get(id);
        if (this.live(held) && held.kind === 'claim') {
            return 'busy';
        }
        this.held.set(id, {
            reservation: `res-${++this.ids}`,
            kind: 'reset',
            hash: this.rows.get(id)?.hash ?? null,
            until: this.now + TTL_MS,
        });
        return 'reserved';
    }

    /** The guard trigger on a hash change that is not the claim's own commit. */
    writeNewHash(id: string, hash: string): void {
        const held = this.held.get(id);
        if (this.live(held) && held.kind === 'claim') {
            throw new Error('student_claim_in_progress');
        }
        this.held.delete(id);
        Object.assign(this.rows.get(id) as Row, { hash, claimed: false });
    }

    archive(id: string): void {
        (this.rows.get(id) as Row).archived = true;
        this.held.delete(id);
    }

    backend(): StudentClaimBackend & { [K in Step]: ReturnType<typeof vi.fn> } {
        const step =
            <A extends unknown[], R>(name: Step, fn: (...args: A) => R) =>
            async (...args: A): Promise<Awaited<R>> => {
                await this.gate(name);
                return await fn(...args);
            };
        return {
            reserveClaim: vi.fn(step('reserveClaim', (hash: string) => this.reserve(hash))),
            readAuthUser: vi.fn(
                step('readAuthUser', (userId: string) => ({ email: `${userId}@students.test`, userType: 'student' })),
            ),
            usernameTakenByOther: vi.fn(
                step('usernameTakenByOther', (username: string, id: string) =>
                    [...this.rows.values()].some((r) => r.id !== id && r.username === username),
                ),
            ),
            setPassword: vi.fn(
                step('setPassword', (userId: string, password: string) => {
                    this.passwords.set(userId, password);
                    return null;
                }),
            ),
            signIn: vi.fn(
                step('signIn', (email: string, password: string) => {
                    const userId = email.split('@')[0] as string;
                    if (this.passwords.get(userId) !== password) {
                        return { ok: false as const, error: { message: 'Invalid login credentials' } };
                    }
                    const token = `token-${++this.ids}`;
                    this.sessions.add(token);
                    return { ok: true as const, session: { accessToken: token, refreshToken: `refresh-${this.ids}` } };
                }),
            ),
            completeClaim: vi.fn(
                step('completeClaim', (id: string, reservation: string, hash: string, username: string) =>
                    this.complete(id, reservation, hash, username),
                ),
            ),
            releaseClaim: vi.fn(
                step('releaseClaim', (id: string, reservation: string) => this.release(id, reservation)),
            ),
            signOutSession: vi.fn(step('signOutSession', (token: string) => void this.sessions.delete(token))),
            forgetLogin: vi.fn(step('forgetLogin', () => undefined)),
        };
    }
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const depsFor = (backend: StudentClaimBackend | null): StudentClaimDeps => ({
    json,
    options: () => new Response('ok'),
    clientKey: () => '203.0.113.5',
    checkRateLimit: vi.fn(async () => ({ ok: true as const })),
    readJson: readCappedJson,
    codes: {
        hashLoginCode,
        isPlausibleLoginCode,
        isValidUsername,
        normalizeLoginCode,
        normalizeUsername,
        USERNAME_MAX,
        USERNAME_MIN,
    },
    password: { passwordProblem, passwordProblemMessage },
    backend,
    logError: () => undefined,
});

const claim = (code: string, username: string, password: string, extra: Record<string, unknown> = {}) =>
    new Request('https://edge.test/functions/v1/student-claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, username, password, ...extra }),
    });

const hashOf = (code: string) => hashLoginCode(normalizeLoginCode(code));

const setup = async () => {
    const roster = new Roster();
    roster.add('s1', await hashOf(CODE_A));
    const backend = roster.backend();
    return { roster, backend, deps: depsFor(backend) };
};

describe('student-claim: one claim', () => {
    it('reserves first, then sets the password, signs in, commits, and only then clears the throttle', async () => {
        const { roster, backend, deps } = await setup();
        const res = await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ displayName: 'Ada', username: 'ada_l' });
        const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder[0] ?? Infinity;
        expect(order(backend.reserveClaim)).toBeLessThan(order(backend.setPassword));
        expect(order(backend.setPassword)).toBeLessThan(order(backend.signIn));
        expect(order(backend.signIn)).toBeLessThan(order(backend.completeClaim));
        expect(order(backend.completeClaim)).toBeLessThan(order(backend.forgetLogin));
        expect(roster.rows.get('s1')).toMatchObject({ claimed: true, hash: null, username: 'ada_l' });
        expect(roster.held.size).toBe(0);
        // The spent card is REJECTED, like any other.
        const again = await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        expect(again.status).toBe(401);
        expect(await again.json()).toEqual(REJECTED);
    });

    it('a code that selects nothing, or a reservation RPC that fails, is the single REJECTED', async () => {
        const { backend, deps } = await setup();
        expect((await handleStudentClaim(claim(CODE_B, 'ada_l', 'Correct1horse'), deps)).status).toBe(401);
        backend.reserveClaim.mockResolvedValueOnce(null);
        expect(await (await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps)).json()).toEqual(
            REJECTED,
        );
        expect(backend.setPassword).not.toHaveBeenCalled();
    });

    it('answers 413 to a chunked body past the control cap, before any lookup', async () => {
        const { backend, deps } = await setup();
        const res = await handleStudentClaim(
            chunkedJson({ code: CODE_A, username: 'ada_l', password: 'Correct1horse' }, BODY_MAX_BYTES + 1),
            deps,
        );
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual(PAYLOAD_TOO_LARGE);
        expect(backend.reserveClaim).not.toHaveBeenCalled();
    });
});

describe('student-claim: two claims on one card', () => {
    it('the second is told the card is busy and never writes a password; the first commits with its own', async () => {
        const { roster, backend, deps } = await setup();
        const paused = roster.pause('signIn');
        const first = handleStudentClaim(claim(CODE_A, 'ada_first', 'FirstPass1'), deps);
        await paused.arrived;

        const second = await handleStudentClaim(claim(CODE_A, 'ada_second', 'SecondPass2'), deps);
        expect(second.status).toBe(409);
        expect(await second.json()).toMatchObject(CLAIM_IN_PROGRESS);
        expect(backend.setPassword).toHaveBeenCalledTimes(1);

        paused.resume();
        const won = await first;
        expect(won.status).toBe(200);
        // The winner's password is the one on the account — the old bug was the
        // loser overwriting it after the commit.
        expect(roster.passwords.get('user-s1')).toBe('FirstPass1');
        expect(roster.rows.get('s1')?.username).toBe('ada_first');
    });

    it('a holder that died is taken over once its reservation expires, and its late commit is lost and signed out', async () => {
        const { roster, backend, deps } = await setup();
        const paused = roster.pause('completeClaim');
        const stale = handleStudentClaim(claim(CODE_A, 'ada_stale', 'StalePass1'), deps);
        await paused.arrived;

        roster.now += TTL_MS + 1;
        const fresh = await handleStudentClaim(claim(CODE_A, 'ada_fresh', 'FreshPass2'), deps);
        expect(fresh.status).toBe(200);

        paused.resume();
        const late = await stale;
        expect(late.status).toBe(401);
        expect(backend.signOutSession).toHaveBeenCalledTimes(1);
        expect(roster.passwords.get('user-s1')).toBe('FreshPass2');
        expect(roster.rows.get('s1')?.username).toBe('ada_fresh');
        // The stale request handed nothing back: the row was not its to release.
        expect(backend.releaseClaim).not.toHaveBeenCalled();
    });
});

describe('student-claim against a teacher reset', () => {
    it('a reset during a claim waits; the claim commits; the reset then goes ahead', async () => {
        const { roster, deps } = await setup();
        const paused = roster.pause('signIn');
        const inFlight = handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        await paused.arrived;

        expect(roster.beginReset('s1')).toBe('busy');
        expect(() => roster.writeNewHash('s1', 'rotated')).toThrow('student_claim_in_progress');

        paused.resume();
        expect((await inFlight).status).toBe(200);
        expect(roster.beginReset('s1')).toBe('reserved');
        roster.writeNewHash('s1', await hashOf(CODE_B));
        expect(roster.held.size).toBe(0);
    });

    it('a claim during a reset waits without writing anything; afterwards only the new card works', async () => {
        const { roster, backend, deps } = await setup();
        expect(roster.beginReset('s1')).toBe('reserved');

        const during = await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        expect(during.status).toBe(409);
        expect(await during.json()).toMatchObject({ code: 'claim_in_progress' });
        expect(backend.setPassword).not.toHaveBeenCalled();

        roster.passwords.set('user-s1', 'scrambled');
        roster.writeNewHash('s1', await hashOf(CODE_B));

        expect((await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps)).status).toBe(401);
        expect((await handleStudentClaim(claim(CODE_B, 'ada_l', 'Correct1horse'), deps)).status).toBe(200);
    });

    it('archiving during a claim clears its reservation, so the commit is lost and the session dropped', async () => {
        const { roster, backend, deps } = await setup();
        const paused = roster.pause('completeClaim');
        const inFlight = handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        await paused.arrived;
        roster.archive('s1');
        paused.resume();
        expect((await inFlight).status).toBe(401);
        expect(backend.signOutSession).toHaveBeenCalledTimes(1);
        expect(roster.rows.get('s1')?.claimed).toBe(false);
    });
});

describe('student-claim hands the card back on every way it stops short', () => {
    const retryWorks = async (deps: StudentClaimDeps) =>
        (await handleStudentClaim(claim(CODE_A, 'ada_retry', 'Correct1horse'), deps)).status;

    it('a refused captcha: 403, released, and a retry goes straight through', async () => {
        const { backend, deps, roster } = await setup();
        backend.signIn.mockResolvedValueOnce({ ok: false, error: { code: 'captcha_failed', message: 'captcha' } });
        const res = await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse', { captchaToken: 't' }), deps);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual(CAPTCHA_FAILED);
        expect(roster.held.size).toBe(0);
        expect(await retryWorks(deps)).toBe(200);
    });

    it('a password GoTrue would not store: 502, released', async () => {
        const { backend, deps, roster } = await setup();
        backend.setPassword.mockResolvedValueOnce('weak');
        expect((await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps)).status).toBe(502);
        expect(roster.held.size).toBe(0);
        expect(await retryWorks(deps)).toBe(200);
    });

    it('a username taken at the pre-check or at the commit: 409, released, session dropped', async () => {
        const { backend, deps, roster } = await setup();
        backend.usernameTakenByOther.mockResolvedValueOnce(true);
        const pre = await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        expect(pre.status).toBe(409);
        expect(await pre.json()).toEqual(USERNAME_TAKEN);
        expect(backend.setPassword).not.toHaveBeenCalled();
        expect(roster.held.size).toBe(0);

        backend.completeClaim.mockResolvedValueOnce('username_taken');
        const atCommit = await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        expect(atCommit.status).toBe(409);
        expect(backend.signOutSession).toHaveBeenCalledTimes(1);
        expect(roster.held.size).toBe(0);
        expect(await retryWorks(deps)).toBe(200);
    });

    it('an account that is not a provisioned student: REJECTED, released, nothing written', async () => {
        const { backend, deps, roster } = await setup();
        backend.readAuthUser.mockResolvedValueOnce({ email: 'teacher@example.test', userType: undefined });
        expect((await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps)).status).toBe(401);
        expect(backend.setPassword).not.toHaveBeenCalled();
        expect(roster.held.size).toBe(0);
    });

    it('a deploy missing its configuration is 500 before anything is reserved', async () => {
        expect((await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), depsFor(null))).status).toBe(500);
    });
});
