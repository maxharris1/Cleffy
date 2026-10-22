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
 *   reserve -> deletion check -> fence -> password write -> fence
 *     -> end sessions (lease checked in its own transaction) -> complete
 *
 * The fence is checked immediately before each Auth side effect. A stale
 * attempt -- a newer retry of the same token took over, or the student has
 * claimed since -- is told 'lost' and stops without touching Auth. Once a
 * fence passes, the worker counts as inside an Auth call, and no retry can
 * take over until it reports back (completes, or stopWorker on a failure) or
 * the hold runs out, because a password write already sent cannot be called
 * back.
 *
 * A failed password write reports back only when Auth DEFINITELY refused it
 * (a 4xx other than 408). Any other failure -- a dropped connection, a
 * timeout, a 5xx, a throw -- may still commit at Auth after the error came
 * back, so the attempt is quarantined: it does not report back, and the hold
 * stands (20261022110800_student_code_reset_quarantine.sql) until the write is
 * confirmed or the hold runs out. The scramble carries a marker naming its
 * worker (MARKER_KEY, in the same Auth update), and seeing it means the write
 * has landed: the worker re-reads it straight after the error and carries on,
 * and a later retry with the token re-reads it before reporting the
 * quarantined worker back itself. The session revocation is a database call
 * that checks the lease in its own transaction (end_student_sessions_fenced),
 * so a late one from a stale worker does nothing.
 */

/** The app_metadata key the scramble writes this worker's id to, in the same Auth update. */
export const MARKER_KEY = 'code_reset_worker';

export interface ResetLease {
    reservation: string;
    worker: string;
    epoch: number;
}

export type ReserveResetAnswer =
    | ({ status: 'reserved' } & ResetLease)
    /** `worker`/`epoch`: this reset's own worker, inside an Auth call (only for the token's holder). */
    | { status: 'busy'; kind: 'reset' | 'claim'; worker?: string; epoch?: number }
    | { status: 'not_found' };

/** `definite`: Auth refused the write outright (a 4xx other than 408), so it cannot land later. */
export type AuthStep = { ok: true } | { ok: false; message: string; definite?: boolean };

/** Whether a failed Auth call's HTTP status says it was refused outright (not a timeout or a 5xx). */
export const definiteRefusal = (status: unknown): boolean =>
    typeof status === 'number' && status >= 400 && status < 500 && status !== 408;

export interface CodeResetPorts {
    /** reserve_student_code_reset; throws (or returns null) when the RPC fails. */
    reserveReset(studentId: string, resumeToken: string | null): Promise<ReserveResetAnswer | null>;
    /** fence_student_code_reset: 'ok' to go ahead with the next Auth side effect. */
    fence(studentId: string, lease: ResetLease): Promise<'ok' | 'lost'>;
    /** account_deletion_pending() for the teacher, asked again right before the Auth write. */
    deletionPending(): Promise<'clear' | 'pending' | 'unknown'>;
    /** The Auth password write: a scramble nobody has seen, plus MARKER_KEY = lease.worker. */
    scramblePassword(studentUserId: string, lease: ResetLease): Promise<AuthStep>;
    /** Whether the Auth user carries MARKER_KEY = worker, i.e. that worker's write has landed. */
    passwordWriteLanded(studentUserId: string, worker: string): Promise<boolean>;
    /** end_student_sessions_fenced: 'lost' when this lease no longer owns the reset. */
    endSessions(studentId: string, lease: ResetLease): Promise<AuthStep | 'lost'>;
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
    /** The password write may still land: quarantined until confirmed or the hold runs out. */
    | { kind: 'unconfirmed'; resetToken: string }
    /** The teacher's account is being deleted; nothing was written to Auth. */
    | { kind: 'deletion_pending' }
    /** Whether the teacher's account is being deleted could not be checked; nothing was written. */
    | { kind: 'deletion_unknown'; resetToken: string }
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

const landed = async (ports: CodeResetPorts, studentUserId: string, worker: string): Promise<boolean> => {
    try {
        return await ports.passwordWriteLanded(studentUserId, worker);
    } catch (err) {
        ports.log(`could not re-read student account ${studentUserId}: ${String(err)}`);
        return false;
    }
};

export const runCodeReset = async (
    ports: CodeResetPorts,
    input: { studentId: string; studentUserId: string; resumeToken: string | null },
): Promise<CodeResetOutcome> => {
    const { studentId, studentUserId, resumeToken } = input;
    let answer: ReserveResetAnswer | null;
    try {
        answer = await ports.reserveReset(studentId, resumeToken);
        // This reset's own worker is quarantined (or still inside its Auth
        // call). Once its write is seen to have landed, nothing of it is in
        // flight: report it back for it, and take a new lease.
        if (
            resumeToken &&
            answer?.status === 'busy' &&
            typeof answer.worker === 'string' &&
            typeof answer.epoch === 'number' &&
            (await landed(ports, studentUserId, answer.worker))
        ) {
            await ports.stopWorker(studentId, { reservation: resumeToken, worker: answer.worker, epoch: answer.epoch });
            answer = await ports.reserveReset(studentId, resumeToken);
        }
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
    // happened) but reports this worker back, so the token resumes at once --
    // except after a password write that may still land, which is quarantined.
    const incomplete = async (): Promise<CodeResetOutcome> => {
        try {
            await ports.stopWorker(studentId, lease);
        } catch (err) {
            ports.log(`could not report the reset worker of student ${studentId} back: ${String(err)}`);
        }
        return { kind: 'incomplete', resetToken: lease.reservation };
    };

    // The dispatcher asked before the action began; asked again here, right
    // before the Auth write, which no database trigger can refuse (decision 61).
    let deletion: 'clear' | 'pending' | 'unknown';
    try {
        deletion = await ports.deletionPending();
    } catch (err) {
        ports.log(`could not check the deletion of the teacher of student ${studentId}: ${String(err)}`);
        deletion = 'unknown';
    }
    if (deletion !== 'clear') {
        // Nothing was sent to Auth: report back, so the token resumes later.
        await incomplete();
        return deletion === 'pending'
            ? { kind: 'deletion_pending' }
            : { kind: 'deletion_unknown', resetToken: lease.reservation };
    }

    // Before the password write: still this worker's reset, and no claim since?
    const beforeScramble = await fenced(ports, studentId, lease);
    if (beforeScramble === 'lost') {
        return { kind: 'lost' };
    }
    if (beforeScramble === 'error') {
        return incomplete();
    }
    let scrambled: AuthStep;
    try {
        scrambled = await ports.scramblePassword(studentUserId, lease);
    } catch (err) {
        scrambled = { ok: false, message: String(err) };
    }
    if (!scrambled.ok) {
        ports.log(`could not revoke the password for student ${studentId}: ${scrambled.message}`);
        if (scrambled.definite) {
            return incomplete();
        }
        // It may still land. Carry on only if it is seen to have; otherwise
        // stay inside the Auth call -- no report-back -- so no retry or claim
        // can start behind a write still on its way.
        if (!(await landed(ports, studentUserId, lease.worker))) {
            return { kind: 'unconfirmed', resetToken: lease.reservation };
        }
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
    const ended = await ports.endSessions(studentId, lease);
    if (ended === 'lost') {
        return { kind: 'lost' };
    }
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
