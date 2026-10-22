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
    CLAIM_CHECK_UNAVAILABLE,
    CLAIM_DELETION_PENDING,
    CLAIM_IN_PROGRESS,
    type ClaimReservation,
    handleStudentClaim,
    REJECTED,
    type StudentClaimBackend,
    type StudentClaimDeps,
    USERNAME_TAKEN,
} from '../../supabase/functions/student-claim/handler';
import {
    type CodeResetPorts,
    definiteRefusal,
    type ResetLease,
    runCodeReset,
} from '../../supabase/functions/_shared/studentCodeReset';
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
const CODE_C = 'HJKM-NPQR-STUV';
const CODE_D = 'WXYZ-2345-6789';

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
    /** A reset's current worker lease (20261022110700); null once it reported back. */
    worker?: string | null;
    epoch?: number;
    inAuth?: boolean;
    /** The row's claimed flag when the reset reserved it (no claim since). */
    claimedSeen?: boolean;
}

type ResetStep = Exclude<keyof CodeResetPorts, 'log'>;
type Step = keyof StudentClaimBackend | ResetStep;

type BeginReset =
    | ({ status: 'reserved' } & ResetLease)
    | { status: 'busy'; kind: 'reset' | 'claim'; worker?: string; epoch?: number }
    | { status: 'not_found' };

class Roster {
    rows = new Map<string, Row>();
    held = new Map<string, Held>();
    passwords = new Map<string, string>();
    /** app_metadata.code_reset_worker per account: written with the scramble, in one Auth update. */
    markers = new Map<string, string>();
    sessions = new Set<string>();
    now = 1_000_000;
    private ids = 0;
    private epochs = 0;
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

    /**
     * student-provision's reset, as 20261022110700_student_code_reset_worker.sql
     * runs it: reserve_student_code_reset hands every attempt its own worker
     * lease. A live hold of either kind refuses, unless it is this reset's own
     * (its token presented) and its worker is not inside an Auth call; then the
     * new lease fences out the old worker.
     */
    beginReset(id: string, token?: string | null): BeginReset {
        const row = this.rows.get(id);
        if (!row) {
            return { status: 'not_found' };
        }
        const held = this.held.get(id);
        const worker = `worker-${++this.ids}`;
        const epoch = ++this.epochs;
        if (this.live(held)) {
            if (held.kind === 'reset' && token && held.reservation === token && !held.inAuth) {
                Object.assign(held, { worker, epoch, inAuth: false, until: this.now + TTL_MS });
                return { status: 'reserved', reservation: token, worker, epoch };
            }
            // 20261022110800: the token's holder is handed the in-flight worker's lease.
            if (held.kind === 'reset' && token && held.reservation === token && held.worker) {
                return { status: 'busy', kind: 'reset', worker: held.worker, epoch: held.epoch };
            }
            return { status: 'busy', kind: held.kind };
        }
        const reservation = `res-${++this.ids}`;
        this.held.set(id, {
            reservation,
            kind: 'reset',
            hash: row.hash,
            until: this.now + TTL_MS,
            worker,
            epoch,
            inAuth: false,
            claimedSeen: row.claimed,
        });
        return { status: 'reserved', reservation, worker, epoch };
    }

    private owns(id: string, lease: ResetLease): boolean {
        const held = this.held.get(id);
        const row = this.rows.get(id);
        return Boolean(
            held &&
            row &&
            held.kind === 'reset' &&
            held.reservation === lease.reservation &&
            held.worker === lease.worker &&
            held.epoch === lease.epoch &&
            row.hash === held.hash &&
            row.claimed === held.claimedSeen,
        );
    }

    /** fence_student_code_reset: 'ok' only for the current worker of a live hold, no claim since. */
    fenceReset(id: string, lease: ResetLease): 'ok' | 'lost' {
        const held = this.held.get(id);
        if (!this.live(held) || !this.owns(id, lease)) {
            return 'lost';
        }
        Object.assign(held, { inAuth: true, until: Math.max(held.until, this.now + TTL_MS) });
        return 'ok';
    }

    /** complete_student_code_reset: the current worker's new code, or 'lost'. */
    completeReset(id: string, lease: ResetLease, hash: string): 'reset' | 'lost' {
        if (!this.owns(id, lease)) {
            return 'lost';
        }
        this.held.delete(id);
        Object.assign(this.rows.get(id) as Row, { hash, claimed: false });
        return 'reset';
    }

    /** end_student_sessions_fenced: only the current worker of a live hold, past a fence, no claim since. */
    endResetSessions(id: string, lease: ResetLease): { ok: true } | 'lost' {
        const held = this.held.get(id);
        if (!this.live(held) || !held.inAuth || !this.owns(id, lease)) {
            return 'lost';
        }
        this.sessions.clear();
        return { ok: true };
    }

    /** The scramble GoTrue applies: a new password and this worker's marker, together. */
    applyScramble(userId: string, lease: ResetLease): void {
        this.passwords.set(userId, `scramble-${++this.ids}`);
        this.markers.set(userId, lease.worker);
    }

    /** stop_student_code_reset_worker: the hold stays; a retry may take a new lease. */
    stopResetWorker(id: string, lease: ResetLease): void {
        const held = this.held.get(id);
        if (
            held?.kind === 'reset' &&
            held.reservation === lease.reservation &&
            held.worker === lease.worker &&
            held.epoch === lease.epoch
        ) {
            Object.assign(held, { worker: null, inAuth: false });
        }
    }

    /** student-provision's code-reset ports over this roster, each step pausable. */
    resetPorts(): CodeResetPorts & { [K in ResetStep]: ReturnType<typeof vi.fn> } {
        const step =
            <A extends unknown[], R>(name: ResetStep, fn: (...args: A) => R) =>
            async (...args: A): Promise<Awaited<R>> => {
                await this.gate(name);
                return await fn(...args);
            };
        let cards = 0;
        return {
            reserveReset: vi.fn(step('reserveReset', (id: string, token: string | null) => this.beginReset(id, token))),
            deletionPending: vi.fn(step('deletionPending', () => 'clear' as const)),
            fence: vi.fn(step('fence', (id: string, lease: ResetLease) => this.fenceReset(id, lease))),
            scramblePassword: vi.fn(
                step('scramblePassword', (userId: string, lease: ResetLease) => {
                    this.applyScramble(userId, lease);
                    return { ok: true as const };
                }),
            ),
            passwordWriteLanded: vi.fn(
                step('passwordWriteLanded', (userId: string, worker: string) => this.markers.get(userId) === worker),
            ),
            endSessions: vi.fn(
                step('endSessions', (id: string, lease: ResetLease) => this.endResetSessions(id, lease)),
            ),
            mintCode: vi.fn(
                step('mintCode', async () => {
                    const code = [CODE_B, CODE_C, CODE_D][cards++] as string;
                    return { code, hash: await hashOf(code) };
                }),
            ),
            complete: vi.fn(
                step('complete', (id: string, lease: ResetLease, hash: string) => this.completeReset(id, lease, hash)),
            ),
            stopWorker: vi.fn(step('stopWorker', (id: string, lease: ResetLease) => this.stopResetWorker(id, lease))),
            log: () => undefined,
        };
    }

    /** The guard trigger on a hash change by any other path: refused under any live hold. */
    writeNewHash(id: string, hash: string): void {
        const held = this.held.get(id);
        if (this.live(held)) {
            throw new Error('student_claim_in_progress');
        }
        this.held.delete(id);
        Object.assign(this.rows.get(id) as Row, { hash, claimed: false });
    }

    /** Archiving blocks the commit; the reservation stays until its holder lets go. */
    archive(id: string): void {
        (this.rows.get(id) as Row).archived = true;
    }

    backend(): StudentClaimBackend & { [K in keyof StudentClaimBackend]: ReturnType<typeof vi.fn> } {
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
            teacherDeletionPending: vi.fn(step('teacherDeletionPending', () => 'clear' as const)),
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
        // The stale request's release cannot touch the row: it was not its own.
        expect(roster.held.size).toBe(0);
        expect(backend.releaseClaim).toHaveBeenCalledTimes(1);
    });
});

describe('student-claim against a teacher reset', () => {
    const reserved = (r: BeginReset): ResetLease => {
        if (r.status !== 'reserved') {
            throw new Error(`expected a reservation, got ${r.status}`);
        }
        return r;
    };

    it('a reset during a claim waits; the claim commits; the reset then goes ahead', async () => {
        const { roster, deps } = await setup();
        const paused = roster.pause('signIn');
        const inFlight = handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        await paused.arrived;

        expect(roster.beginReset('s1').status).toBe('busy');
        expect(() => roster.writeNewHash('s1', 'rotated')).toThrow('student_claim_in_progress');

        paused.resume();
        expect((await inFlight).status).toBe(200);
        const reset = reserved(roster.beginReset('s1'));
        expect(roster.completeReset('s1', reset, await hashOf(CODE_B))).toBe('reset');
        expect(roster.held.size).toBe(0);
    });

    it('a claim during a reset waits without writing anything; afterwards only the new card works', async () => {
        const { roster, backend, deps } = await setup();
        const reset = reserved(roster.beginReset('s1'));

        const during = await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        expect(during.status).toBe(409);
        expect(await during.json()).toMatchObject({ code: 'claim_in_progress' });
        expect(backend.setPassword).not.toHaveBeenCalled();

        roster.passwords.set('user-s1', 'scrambled');
        expect(roster.completeReset('s1', reset, await hashOf(CODE_B))).toBe('reset');

        expect((await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps)).status).toBe(401);
        expect((await handleStudentClaim(claim(CODE_B, 'ada_l', 'Correct1horse'), deps)).status).toBe(200);
    });

    it('archiving during a claim blocks its commit; a reset waits until the claim lets go', async () => {
        const { roster, backend, deps } = await setup();
        const paused = roster.pause('completeClaim');
        const inFlight = handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        await paused.arrived;
        roster.archive('s1');
        // A reset of the archived student while the stale claim still runs
        // must not scramble before that claim is done.
        expect(roster.beginReset('s1').status).toBe('busy');
        paused.resume();
        expect((await inFlight).status).toBe(401);
        expect(backend.signOutSession).toHaveBeenCalledTimes(1);
        expect(roster.rows.get('s1')?.claimed).toBe(false);
        // The lost claim released its own reservation on the way out.
        expect(roster.held.size).toBe(0);
        expect(roster.beginReset('s1').status).toBe('reserved');
    });

    it('reset, reset, claim: a paused reset cannot scramble the password the student chose from the other card', async () => {
        // Codex r1 (Part B) finding 2. Reset A reserves and pauses before its
        // scramble; reset B (another tab, no token) arrives; the student claims.
        const { roster, deps } = await setup();
        const ports = roster.resetPorts();
        const pausedA = roster.pause('fence');
        const resetA = runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: null });
        await pausedA.arrived;

        // B cannot take A's live reservation over, so it never mints a card.
        expect(await runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: null })).toEqual({
            kind: 'busy',
            holder: 'reset',
        });
        expect(roster.beginReset('s1', 'not-a-token').status).toBe('busy');
        // Nor can anything but A write a code under it.
        expect(
            roster.completeReset('s1', { reservation: 'res-forged', worker: 'w', epoch: 99 }, await hashOf(CODE_C)),
        ).toBe('lost');
        expect(() => roster.writeNewHash('s1', 'rotated')).toThrow('student_claim_in_progress');
        // The student, holding the old card meanwhile, is told to wait.
        expect((await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps)).status).toBe(409);

        // A resumes: scramble, sessions, then its new card.
        pausedA.resume();
        const done = await resetA;
        expect(done).toEqual({ kind: 'reset', code: CODE_B });
        expect(ports.scramblePassword).toHaveBeenCalledTimes(1);

        // The student claims A's card with a password of their own; nothing
        // of A's can land after it.
        expect((await handleStudentClaim(claim(CODE_B, 'ada_l', 'Correct1horse'), deps)).status).toBe(200);
        expect(roster.passwords.get('user-s1')).toBe('Correct1horse');
        expect(roster.rows.get('s1')).toMatchObject({ claimed: true, username: 'ada_l' });
    });

    it('two paused retries of one token: B completes, the student claims, A resumes and does nothing', async () => {
        // Codex r2 (Part B) MAJOR. A first try fails part-way and hands back
        // token T; two retries then present T at once.
        const { roster, deps } = await setup();
        const ports = roster.resetPorts();
        ports.scramblePassword.mockResolvedValueOnce({ ok: false, message: 'weak password', definite: true });
        const first = await runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: null });
        expect(first.kind).toBe('incomplete');
        const token = (first as { resetToken: string }).resetToken;
        // The failed try reported back: its hold stays, its worker is gone.
        expect(roster.held.get('s1')).toMatchObject({ reservation: token, worker: null, inAuth: false });

        // Retry A takes its lease and pauses right before its password write.
        const pausedA = roster.pause('fence');
        const retryA = runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: token });
        await pausedA.arrived;
        const leaseA = roster.held.get('s1')?.epoch;

        // Retry B presents the same token: a fresh lease, a newer epoch.
        const retryB = await runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: token });
        expect(retryB).toEqual({ kind: 'reset', code: CODE_B });
        expect(ports.scramblePassword).toHaveBeenCalledTimes(2); // the failed first try, then B
        expect(ports.endSessions).toHaveBeenCalledTimes(1);
        expect(ports.reserveReset.mock.results.map((r) => r.type)).toEqual(['return', 'return', 'return']);
        expect(leaseA).toBeDefined();

        // The student claims B's card, chooses a password and signs in.
        const claimed = await handleStudentClaim(claim(CODE_B, 'ada_l', 'Correct1horse'), deps);
        expect(claimed.status).toBe(200);
        expect(roster.passwords.get('user-s1')).toBe('Correct1horse');
        const studentSessions = new Set(roster.sessions);
        expect(studentSessions.size).toBe(1);

        // A resumes: its fence fails, and it touches nothing.
        pausedA.resume();
        expect(await retryA).toEqual({ kind: 'lost' });
        expect(ports.scramblePassword).toHaveBeenCalledTimes(2);
        expect(ports.endSessions).toHaveBeenCalledTimes(1);
        expect(ports.complete).toHaveBeenCalledTimes(1);
        expect(ports.stopWorker).toHaveBeenCalledTimes(1); // the first try's only
        expect(roster.passwords.get('user-s1')).toBe('Correct1horse');
        expect(roster.sessions).toEqual(studentSessions);
        expect(roster.rows.get('s1')).toMatchObject({ claimed: true, username: 'ada_l', hash: null });
    });

    it('a newer lease fences out an older worker while the hold is still live', async () => {
        const { roster } = await setup();
        const ports = roster.resetPorts();
        ports.endSessions.mockResolvedValueOnce({ ok: false, message: 'rpc down' });
        const first = await runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: null });
        const token = (first as { resetToken: string }).resetToken;

        // A pauses before its first fence; B takes a newer lease and pauses
        // inside its own password write.
        const pausedA = roster.pause('fence');
        const retryA = runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: token });
        await pausedA.arrived;
        const pausedB = roster.pause('scramblePassword');
        const retryB = runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: token });
        await pausedB.arrived;

        // A wakes while B is still working: its epoch is stale.
        pausedA.resume();
        expect(await retryA).toEqual({ kind: 'lost' });
        expect(ports.scramblePassword).toHaveBeenCalledTimes(2); // the first try, and B (paused inside it)

        pausedB.resume();
        expect(await retryB).toEqual({ kind: 'reset', code: CODE_B });
    });

    it('a retry cannot start behind a worker that may be inside an Auth call', async () => {
        const { roster } = await setup();
        const ports = roster.resetPorts();
        ports.endSessions.mockResolvedValueOnce({ ok: false, message: 'rpc down' });
        const first = await runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: null });
        const token = (first as { resetToken: string }).resetToken;

        // A passed its fence and its password write is on the way to Auth.
        const pausedA = roster.pause('scramblePassword');
        const retryA = runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: token });
        await pausedA.arrived;
        expect(roster.held.get('s1')?.inAuth).toBe(true);

        // B with the same token is told the reset is still finishing.
        expect(await runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: token })).toEqual({
            kind: 'busy',
            holder: 'reset',
        });
        expect(ports.scramblePassword).toHaveBeenCalledTimes(2);

        pausedA.resume();
        expect(await retryA).toEqual({ kind: 'reset', code: CODE_B });
    });

    it('a worker that reported back lets the retry resume its hold at once', async () => {
        const { roster } = await setup();
        const ports = roster.resetPorts();
        ports.scramblePassword.mockResolvedValueOnce({ ok: false, message: 'weak password', definite: true });
        const first = await runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: null });
        expect(first).toMatchObject({ kind: 'incomplete' });
        const token = (first as { resetToken: string }).resetToken;
        const retry = await runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: token });
        expect(retry).toEqual({ kind: 'reset', code: CODE_B });
        expect(roster.held.size).toBe(0);
    });

    it('a claim that lands while the hold had run out fences the reset out before any Auth write', async () => {
        const { roster, deps } = await setup();
        const ports = roster.resetPorts();
        const pausedA = roster.pause('fence');
        const resetA = runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: null });
        await pausedA.arrived;
        // A's hold runs out (its request stalled past the TTL) and the student
        // claims the old card meanwhile.
        roster.now += TTL_MS + 1;
        expect((await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps)).status).toBe(200);

        pausedA.resume();
        expect(await resetA).toEqual({ kind: 'lost' });
        expect(ports.scramblePassword).not.toHaveBeenCalled();
        expect(roster.passwords.get('user-s1')).toBe('Correct1horse');
    });
});

describe('a reset whose password write comes back ambiguous (Codex r3 on #70)', () => {
    const input = (resumeToken: string | null = null) => ({ studentId: 's1', studentUserId: 'user-s1', resumeToken });

    /**
     * The scramble's error returns locally while the request is still on its
     * way: nothing is written now, and `land()` is the remote write committing
     * later -- the password and the worker's marker together.
     */
    const ambiguousScramble = (roster: Roster, ports: ReturnType<Roster['resetPorts']>) => {
        let land = () => undefined as void;
        ports.scramblePassword.mockImplementationOnce(async (userId: string, lease: ResetLease) => {
            land = () => roster.applyScramble(userId, lease);
            return { ok: false, message: 'error sending request: connection reset' };
        });
        return { land: () => land() };
    };

    it('the error returns, the write commits later: a retry and a claim both wait until it is confirmed', async () => {
        const { roster, deps } = await setup();
        const ports = roster.resetPorts();
        const remote = ambiguousScramble(roster, ports);

        // A: the error comes back; the immediate re-read finds no marker yet.
        const a = await runCodeReset(ports, input());
        expect(a.kind).toBe('unconfirmed');
        const token = (a as { resetToken: string }).resetToken;
        // Quarantined: A did not report back, so it still counts as inside its Auth call.
        expect(ports.stopWorker).not.toHaveBeenCalled();
        expect(roster.held.get('s1')).toMatchObject({ reservation: token, inAuth: true });

        // A retry with the token waits; so does a claim of the old card.
        expect(await runCodeReset(ports, input(token))).toEqual({ kind: 'busy', holder: 'reset' });
        const early = await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        expect(early.status).toBe(409);
        expect(await early.json()).toMatchObject({ code: 'claim_in_progress' });
        expect(ports.scramblePassword).toHaveBeenCalledTimes(1);

        // A's write commits at Auth now, after its error came back.
        remote.land();

        // The next retry sees A's marker: A's write has landed and nothing of
        // it is in flight. It reports A back, takes a newer lease, completes.
        const b = await runCodeReset(ports, input(token));
        expect(b).toEqual({ kind: 'reset', code: CODE_B });
        expect(ports.stopWorker).toHaveBeenCalledTimes(1);
        expect(ports.scramblePassword).toHaveBeenCalledTimes(2);

        // The student claims B's card; their password stands, A has nothing left to land.
        expect((await handleStudentClaim(claim(CODE_B, 'ada_l', 'Correct1horse'), deps)).status).toBe(200);
        expect(roster.passwords.get('user-s1')).toBe('Correct1horse');
        expect(roster.rows.get('s1')).toMatchObject({ claimed: true, username: 'ada_l' });
    });

    it('the error returns, the write commits later, never confirmed: both wait until the hold runs out', async () => {
        const { roster, deps } = await setup();
        const ports = roster.resetPorts();
        const remote = ambiguousScramble(roster, ports);
        // The Auth user cannot be re-read at all, so nothing ever confirms the write.
        ports.passwordWriteLanded.mockRejectedValue(new Error('auth unavailable'));

        const a = await runCodeReset(ports, input());
        expect(a.kind).toBe('unconfirmed');
        const token = (a as { resetToken: string }).resetToken;
        remote.land();

        // Up to the last moment of the hold, a retry and a claim both wait.
        roster.now += TTL_MS - 1;
        expect(await runCodeReset(ports, input(token))).toEqual({ kind: 'busy', holder: 'reset' });
        expect((await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps)).status).toBe(409);
        expect(ports.stopWorker).not.toHaveBeenCalled();

        // The server-side limit passes: the old card is claimable again, and
        // A's write landed long before the student's password.
        roster.now += 2;
        expect((await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps)).status).toBe(200);
        expect(roster.passwords.get('user-s1')).toBe('Correct1horse');
    });

    it('the worker re-reads straight after the error, and carries on when its write did land', async () => {
        const { roster } = await setup();
        const ports = roster.resetPorts();
        ports.scramblePassword.mockImplementationOnce(async (userId: string, lease: ResetLease) => {
            roster.applyScramble(userId, lease);
            return { ok: false, message: 'upstream request timeout' };
        });
        expect(await runCodeReset(ports, input())).toEqual({ kind: 'reset', code: CODE_B });
        expect(ports.passwordWriteLanded).toHaveBeenCalledTimes(1);
        expect(ports.endSessions).toHaveBeenCalledTimes(1);
        expect(ports.stopWorker).not.toHaveBeenCalled();
        expect(roster.held.size).toBe(0);
    });

    it('a throw from the password write is ambiguous too', async () => {
        const { roster } = await setup();
        const ports = roster.resetPorts();
        ports.scramblePassword.mockRejectedValueOnce(new TypeError('fetch failed'));
        expect((await runCodeReset(ports, input())).kind).toBe('unconfirmed');
        expect(ports.stopWorker).not.toHaveBeenCalled();
        expect(roster.held.get('s1')?.inAuth).toBe(true);
    });

    it('only a definite 4xx refusal reports back at once', async () => {
        const { roster } = await setup();
        const ports = roster.resetPorts();
        ports.scramblePassword.mockResolvedValueOnce({ ok: false, message: 'weak password', definite: true });
        const a = await runCodeReset(ports, input());
        expect(a.kind).toBe('incomplete');
        expect(ports.passwordWriteLanded).not.toHaveBeenCalled();
        expect(ports.stopWorker).toHaveBeenCalledTimes(1);
        const token = (a as { resetToken: string }).resetToken;
        expect(await runCodeReset(ports, input(token))).toEqual({ kind: 'reset', code: CODE_B });

        for (const status of [400, 401, 403, 404, 409, 422, 429]) {
            expect(definiteRefusal(status), String(status)).toBe(true);
        }
        for (const status of [408, 500, 502, 503, 504, 0, undefined, null, '400']) {
            expect(definiteRefusal(status), String(status)).toBe(false);
        }
    });

    it('a worker fenced out after its last fence ends no sessions: the revocation checks the lease itself', async () => {
        const { roster, deps } = await setup();
        const ports = roster.resetPorts();
        ports.scramblePassword.mockResolvedValueOnce({ ok: false, message: 'weak password', definite: true });
        const x = await runCodeReset(ports, input());
        const token = (x as { resetToken: string }).resetToken;

        // A passes both fences and pauses on its way into the session revocation.
        const pausedInSessions = roster.pause('endSessions');
        const retryA = runCodeReset(ports, input(token));
        await pausedInSessions.arrived;

        // B with the token: A is inside an Auth call, but A's scramble is seen
        // to have landed, so B reports A back and takes over.
        const retryB = await runCodeReset(ports, input(token));
        expect(retryB).toEqual({ kind: 'reset', code: CODE_B });
        expect((await handleStudentClaim(claim(CODE_B, 'ada_l', 'Correct1horse'), deps)).status).toBe(200);
        const studentSessions = new Set(roster.sessions);
        expect(studentSessions.size).toBe(1);

        // A's delayed revocation runs now and ends nothing.
        pausedInSessions.resume();
        expect(await retryA).toEqual({ kind: 'lost' });
        expect(roster.sessions).toEqual(studentSessions);
        expect(roster.passwords.get('user-s1')).toBe('Correct1horse');
    });
});

describe('deletion checks right before the Auth writes (decision 61)', () => {
    it('reset: a teacher being deleted gets no Auth write; an unanswered check hands the token back', async () => {
        const { roster } = await setup();
        const ports = roster.resetPorts();
        ports.deletionPending.mockResolvedValueOnce('pending');
        expect(await runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: null })).toEqual({
            kind: 'deletion_pending',
        });
        expect(ports.fence).not.toHaveBeenCalled();
        expect(ports.scramblePassword).not.toHaveBeenCalled();

        roster.held.clear();
        ports.deletionPending.mockRejectedValueOnce(new Error('rpc down'));
        const unknown = await runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: null });
        expect(unknown.kind).toBe('deletion_unknown');
        expect(ports.scramblePassword).not.toHaveBeenCalled();
        // Reported back, so the token resumes at once.
        const token = (unknown as { resetToken: string }).resetToken;
        expect(await runCodeReset(ports, { studentId: 's1', studentUserId: 'user-s1', resumeToken: token })).toEqual({
            kind: 'reset',
            code: CODE_B,
        });
    });

    it('claim: the card of a teacher being deleted sets no password, and an unanswered check is a 503', async () => {
        const { roster, backend, deps } = await setup();
        backend.teacherDeletionPending.mockResolvedValueOnce('pending');
        const pending = await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        expect(pending.status).toBe(409);
        expect(await pending.json()).toEqual(CLAIM_DELETION_PENDING);
        expect(backend.teacherDeletionPending).toHaveBeenCalledWith('s1');

        backend.teacherDeletionPending.mockResolvedValueOnce('unknown');
        const unknown = await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps);
        expect(unknown.status).toBe(503);
        expect(await unknown.json()).toEqual(CLAIM_CHECK_UNAVAILABLE);
        expect(CLAIM_CHECK_UNAVAILABLE.error).toMatch(/try again/i);

        expect(backend.setPassword).not.toHaveBeenCalled();
        expect(backend.releaseClaim).toHaveBeenCalledTimes(2);
        expect(roster.held.size).toBe(0);
        const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder.at(-1) ?? Infinity;
        expect((await handleStudentClaim(claim(CODE_A, 'ada_l', 'Correct1horse'), deps)).status).toBe(200);
        expect(order(backend.teacherDeletionPending)).toBeLessThan(order(backend.setPassword));
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
