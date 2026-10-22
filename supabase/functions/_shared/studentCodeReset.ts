/**
 * A teacher's reset of a code-method student's card: the worker side of
 * 20261022110700_student_code_reset_worker.sql.
 *
 * NO imports, like studentSessions.ts: Deno loads it with the `.ts` extension
 * and vitest without, so what student-provision runs is what the tests drive.
 * Every database and Auth call is a port.
 *
 * The resume token (`resetToken`, handed back on a failed reset) only names
 * WHICH reset a retry continues. Each attempt gets its own worker lease (a
 * worker id and a fencing epoch) from reserveReset, and acts only while that
 * lease is the current one:
 *
 *   reserve -> fence -> password write -> fence -> end sessions -> complete
 *
 * The fence is checked immediately before each Auth side effect. A stale
 * attempt -- a newer retry of the same token took over, or the student has
 * claimed since -- is told 'lost' and stops without touching Auth. Once a
 * fence passes, the worker counts as inside an Auth call, and no retry can
 * take over until it reports back (completes, or stopWorker on a failure) or
 * the hold runs out, because a password write already sent cannot be called
 * back.
 */

export interface ResetLease {
    reservation: string;
    worker: string;
    epoch: number;
}

export type ReserveResetAnswer =
    ({ status: 'reserved' } & ResetLease) | { status: 'busy'; kind: 'reset' | 'claim' } | { status: 'not_found' };

export type AuthStep = { ok: true } | { ok: false; message: string };

export interface CodeResetPorts {
    /** reserve_student_code_reset; throws (or returns null) when the RPC fails. */
    reserveReset(studentId: string, resumeToken: string | null): Promise<ReserveResetAnswer | null>;
    /** fence_student_code_reset: 'ok' to go ahead with the next Auth side effect. */
    fence(studentId: string, lease: ResetLease): Promise<'ok' | 'lost'>;
    /** The Auth password write: a scramble nobody has seen. */
    scramblePassword(studentUserId: string): Promise<AuthStep>;
    /** Ends every open session (end_student_sessions). */
    endSessions(studentUserId: string): Promise<AuthStep>;
    /** A fresh card and its hash. */
    mintCode(): Promise<{ code: string; hash: string }>;
    /** complete_student_code_reset. */
    complete(studentId: string, lease: ResetLease, codeHash: string): Promise<'reset' | 'lost'>;
    /** stop_student_code_reset_worker: no Auth call of this worker is in flight any more. */
    stopWorker(studentId: string, lease: ResetLease): Promise<void>;
    log(message: string): void;
}

export type CodeResetOutcome =
    | { kind: 'reset'; code: string }
    | { kind: 'not_found' }
    /** Another reservation holds the row (or this one's worker is still inside an Auth call). */
    | { kind: 'busy'; holder: 'reset' | 'claim' }
    /** Could not reserve at all: nothing happened. */
    | { kind: 'unavailable' }
    /** Stopped part-way; the hold stays, and `resetToken` resumes it. */
    | { kind: 'incomplete'; resetToken: string }
    /** Fenced out, or the completion was lost: a newer reset or a claim stands. */
    | { kind: 'lost' };

const fenced = async (
    ports: CodeResetPorts,
    studentId: string,
    lease: ResetLease,
): Promise<'ok' | 'lost' | 'error'> => {
    try {
        return (await ports.fence(studentId, lease)) === 'ok' ? 'ok' : 'lost';
    } catch (err) {
        ports.log(`could not fence the reset of student ${studentId}: ${String(err)}`);
        return 'error';
    }
};

export const runCodeReset = async (
    ports: CodeResetPorts,
    input: { studentId: string; studentUserId: string; resumeToken: string | null },
): Promise<CodeResetOutcome> => {
    const { studentId, studentUserId } = input;
    let answer: ReserveResetAnswer | null;
    try {
        answer = await ports.reserveReset(studentId, input.resumeToken);
    } catch (err) {
        ports.log(`could not reserve student ${studentId} for a reset: ${String(err)}`);
        return { kind: 'unavailable' };
    }
    if (!answer) {
        return { kind: 'unavailable' };
    }
    if (answer.status === 'not_found') {
        return { kind: 'not_found' };
    }
    if (answer.status !== 'reserved') {
        return { kind: 'busy', holder: answer.kind === 'reset' ? 'reset' : 'claim' };
    }
    const lease: ResetLease = { reservation: answer.reservation, worker: answer.worker, epoch: answer.epoch };

    // From here a failure keeps the reservation (the password may already be
    // scrambled, and the old card must not be claimable as if nothing had
    // happened) but reports this worker back, so the token resumes at once.
    const incomplete = async (): Promise<CodeResetOutcome> => {
        try {
            await ports.stopWorker(studentId, lease);
        } catch (err) {
            ports.log(`could not report the reset worker of student ${studentId} back: ${String(err)}`);
        }
        return { kind: 'incomplete', resetToken: lease.reservation };
    };

    // Before the password write: still this worker's reset, and no claim since?
    const beforeScramble = await fenced(ports, studentId, lease);
    if (beforeScramble === 'lost') {
        return { kind: 'lost' };
    }
    if (beforeScramble === 'error') {
        return incomplete();
    }
    const scrambled = await ports.scramblePassword(studentUserId);
    if (!scrambled.ok) {
        ports.log(`could not revoke the password for student ${studentId}: ${scrambled.message}`);
        return incomplete();
    }

    // Again before the session revocation, which would end a student's fresh
    // sign-in just as surely as the scramble would overwrite their password.
    const beforeSessions = await fenced(ports, studentId, lease);
    if (beforeSessions === 'lost') {
        return { kind: 'lost' };
    }
    if (beforeSessions === 'error') {
        return incomplete();
    }
    const ended = await ports.endSessions(studentUserId);
    if (!ended.ok) {
        ports.log(`could not end the sessions of student ${studentId}: ${ended.message}`);
        return incomplete();
    }

    const { code, hash } = await ports.mintCode();
    let completed: 'reset' | 'lost';
    try {
        completed = await ports.complete(studentId, lease, hash);
    } catch (err) {
        ports.log(`login code hash out of step for student ${studentId}: ${String(err)}`);
        return incomplete();
    }
    return completed === 'reset' ? { kind: 'reset', code } : { kind: 'lost' };
};
