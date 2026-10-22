import type * as PasswordPolicy from '../_shared/passwordPolicy.ts';
import type * as ReadCapped from '../_shared/readCappedJson.ts';
import type * as StudentCodes from '../_shared/studentCodes.ts';

/**
 * Spending a login code: the one time a student's code is ever accepted — the
 * control flow, apart from the clients it runs against.
 *
 * index.ts wires this to Supabase; tests drive it with stubs. No runtime
 * imports, for the reason student-login/handler.ts gives: everything it calls
 * arrives in `deps`, and the type-only imports above vanish at compile time.
 *
 * Deployed with `verify_jwt = false` (see supabase/config.toml), the third such
 * function after stripe-webhook and student-login, for the same structural
 * reason: the caller has no Supabase JWT to present. A child typing the code off
 * their card has no account they can reach yet — this is the endpoint that turns
 * the card into a username and a password.
 *
 * The code is a CLAIM TOKEN, not a password. It selects the roster row by hash
 * exactly once, and the successful claim spends it: the hash is nulled in the
 * same statement that stores the username, so a second attempt with the same
 * card finds nothing. That is the whole reason a student's password is never the
 * code — the card can be lost, photographed or left on the piano afterwards
 * without being a credential.
 *
 * Two things keep an endpoint this open from being a guessing machine:
 *
 *  * The hard rate limit below, taken before any other work — per IP, against
 *    the ~59-bit code space of _shared/studentCodes.ts. Even at this ceiling an
 *    attacker exhausts a meaningful fraction of the space some millions of years
 *    from now, and checkRateLimit fails closed, so losing the RPC does not open
 *    it. The ceiling is a CLASSROOM rather than a person, because a whole studio
 *    claims their cards behind one school NAT at the top of a lesson.
 *  * One indistinguishable failure for every path a guess can reach. Wrong
 *    shape, no such code, archived student, ALREADY CLAIMED code, unreadable
 *    auth user, an account that is not a provisioned student — all of them
 *    answer exactly REJECTED, so this is never an oracle for which codes exist
 *    or which have been spent.
 *
 * Some failures deliberately DO distinguish themselves, because none of them is
 * an oracle: the username and password rules are printed on the form the student
 * is looking at, so refusing silently would just be a form that cannot be
 * filled in. "That username is taken" is the interesting one — it is reachable
 * only by someone already holding a valid, unclaimed code, and a username is a
 * semi-public login identifier rather than a secret, so answering it costs
 * nothing and hiding it would strand a student on a name they cannot use. The
 * refusals from the sign-in step (`captcha_failed`, `claim_unavailable`) and
 * `claim_in_progress` are past the lookup for the same reason, and all are
 * retryable with the same card.
 *
 * The RESERVATION (20261022110000_student_claim_reservation.sql) is what makes
 * the rest safe to run in this order. It is taken first, in the statement that
 * finds the row, bound to the card's hash; nothing is written to the account
 * until it is held, and the commit succeeds only while the row still carries
 * that hash and the reservation is still this request's. So:
 *
 *  * two children typing the same card at once: the second is told the card is
 *    busy and never touches the password, which used to be overwritten by
 *    whichever request lost the commit;
 *  * a teacher's reset during a claim: the reset waits for the claim (or the
 *    claim for the reset), so the reset's scramble can never land before a
 *    claim's password write, and a rotated code can never be committed with the
 *    old one;
 *  * archiving blocks a claim in flight (its commit refuses an archived row)
 *    without dropping its reservation, so a reset of the archived student
 *    still waits for it until this request lets go;
 *  * every way this request can stop short of the commit hands the reservation
 *    back at once (releaseClaim), so a retry with the same card works.
 */

/** The only failure a guess can reach. Never varied — see the note above. */
export const REJECTED = { error: 'That code did not work', code: 'invalid_code' } as const;

/**
 * The sentence for a challenge GoTrue would not accept — expired, replayed, or
 * absent on a project with `[auth.captcha]` on. The same copy
 * `_shared/guestEmail.ts` uses for its own `captcha_failed`, and the same code,
 * because the browser branches on the code to put up a fresh widget.
 */
export const CAPTCHA_FAILED = {
    error: 'That “I’m human” check didn’t go through. Try it again.',
    code: 'captcha_failed',
} as const;

/** Another claim (or the teacher's reset) holds this card right now. Retryable. */
export const CLAIM_IN_PROGRESS = {
    error: 'This card is being set up right now. Wait a minute, then try again.',
    code: 'claim_in_progress',
} as const;

export const USERNAME_TAKEN = { error: 'That username is taken', code: 'username_taken' } as const;

/**
 * The card's teacher is deleting their account (account_deletion_pending(),
 * ../_shared/deletionPending.ts), and the deletion removes this student with
 * it: nothing is written to the account.
 */
export const CLAIM_DELETION_PENDING = {
    error: 'This card can no longer be set up. Ask your teacher for help.',
    code: 'account_deletion_pending',
} as const;

/** That could not be checked. Fails closed, as a retry prompt (decision 60(b)). */
export const CLAIM_CHECK_UNAVAILABLE = {
    error: 'We could not check this card just now. Wait a minute, then try again.',
    code: 'deletion_check_unavailable',
    retryAfterSec: 30,
} as const;

/**
 * The cap on the request body: readCappedJson.ts's CONTROL_BODY_MAX_BYTES.
 * Past it the answer is 413 before anything is parsed.
 */
export const BODY_MAX_BYTES = 16 * 1024;
const PAYLOAD_TOO_LARGE = { error: 'Request body too large', code: 'payload_too_large' } as const;

type Gate = { ok: true } | { ok: false; retryAfterSec: number };

/** reserve_student_claim()'s answer; null when the RPC itself failed. */
export type ClaimReservation =
    | { status: 'reserved'; reservation: string; studentId: string; studentUserId: string; displayName: string }
    | { status: 'busy'; retryAfterSec: number }
    | { status: 'not_found' };

/** complete_student_claim()'s answer, with the unique index's 23505 named. */
export type ClaimCompletion = 'claimed' | 'lost' | 'username_taken' | 'error';

export interface StudentClaimSession {
    accessToken: string;
    refreshToken: string;
}

export type SignInResult =
    | { ok: true; session: StudentClaimSession }
    | { ok: false; error: { code?: string | null; message?: string | null } | null };

/** Everything that needs the service role or GoTrue. */
export interface StudentClaimBackend {
    /** reserve_student_claim(): find the unarchived, unclaimed row by hash and hold it. */
    reserveClaim: (codeHash: string) => Promise<ClaimReservation | null>;
    /** The auth user a roster row points at; null if it cannot be read. */
    readAuthUser: (userId: string) => Promise<{ email: string | null; userType: unknown } | null>;
    /** account_deletion_pending() for the teacher whose roster row `studentId` is. */
    teacherDeletionPending: (studentId: string) => Promise<'clear' | 'pending' | 'unknown'>;
    /** Whether a roster row other than `studentId` already has this username. */
    usernameTakenByOther: (username: string, studentId: string) => Promise<boolean>;
    /** auth.admin.updateUserById(password); an error message on failure. */
    setPassword: (userId: string, password: string) => Promise<string | null>;
    /** A password sign-in on a fresh anon client, carrying the caller's captcha token. */
    signIn: (email: string, password: string, captchaToken: string | null) => Promise<SignInResult>;
    /** complete_student_claim(): the commit, only for this reservation and this hash. */
    completeClaim: (
        studentId: string,
        reservation: string,
        codeHash: string,
        username: string,
    ) => Promise<ClaimCompletion>;
    /** release_student_claim(): hand back this request's reservation. Best effort. */
    releaseClaim: (studentId: string, reservation: string) => Promise<void>;
    /**
     * Drops a session this function minted and then decided not to hand out:
     * `'local'` — this ONE session — never `'global'`, which would sign out the
     * winner of a race on the same account. Best effort.
     */
    signOutSession: (accessToken: string) => Promise<void>;
    /** loginThrottle's forgetLoginAccount for the username now claimed. Best effort. */
    forgetLogin: (username: string) => Promise<void>;
}

export interface StudentClaimDeps {
    json: (body: unknown, status?: number) => Response;
    options: () => Response;
    clientKey: (req: Request) => string;
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    /** _shared/readCappedJson.ts's readCappedJson (no runtime imports here). */
    readJson: typeof ReadCapped.readCappedJson;
    codes: Pick<
        typeof StudentCodes,
        | 'hashLoginCode'
        | 'isPlausibleLoginCode'
        | 'isValidUsername'
        | 'normalizeLoginCode'
        | 'normalizeUsername'
        | 'USERNAME_MAX'
        | 'USERNAME_MIN'
    >;
    password: Pick<typeof PasswordPolicy, 'passwordProblem' | 'passwordProblemMessage'>;
    /** Null on a deploy missing the service role, the URL or the anon key. */
    backend: StudentClaimBackend | null;
    logError: (message: string) => void;
}

/** Whether a GoTrue refusal was about the captcha rather than the credential. */
const captchaRefusal = (err: { code?: string | null; message?: string | null } | null): boolean =>
    err?.code === 'captcha_failed' || /captcha/i.test(err?.message ?? '');

export const handleStudentClaim = async (req: Request, deps: StudentClaimDeps): Promise<Response> => {
    const { json, codes } = deps;
    if (req.method === 'OPTIONS') {
        return deps.options();
    }
    if (req.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }
    const reject = (): Response => json(REJECTED, 401);

    // Ahead of everything, the body read included: this is the brute-force gate,
    // so it must cost an attacker a slot even for a request that never parses.
    const rate = await deps.checkRateLimit(`student-claim:${deps.clientKey(req)}`, 60, 60_000);
    if (!rate.ok) {
        return json({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    const read = await deps.readJson(req, BODY_MAX_BYTES);
    if (!read.ok) {
        return read.status === 413 ? json(PAYLOAD_TOO_LARGE, 413) : json({ error: 'Invalid JSON body' }, 400);
    }
    if (!read.value || typeof read.value !== 'object' || Array.isArray(read.value)) {
        return json({ error: 'Invalid JSON body' }, 400);
    }
    const body = read.value as { code?: unknown; username?: unknown; password?: unknown; captchaToken?: unknown };

    // Cards print XXXX-XXXX-XXXX, so normalizing first means the dashes, spaces
    // and lower case a child types are not a way to fail. A missing or non-string
    // `code` normalizes to '' and falls into the same single rejection below.
    const normalized = codes.normalizeLoginCode(typeof body.code === 'string' ? body.code : '');
    if (!codes.isPlausibleLoginCode(normalized)) {
        return reject();
    }

    // Checked after the code, so a bad code plus a bad username is still one
    // indistinguishable 401 rather than a hint that the code was the good half.
    const username = codes.normalizeUsername(typeof body.username === 'string' ? body.username : '');
    if (!codes.isValidUsername(username)) {
        return json(
            {
                error: `Usernames are ${codes.USERNAME_MIN}-${codes.USERNAME_MAX} lowercase letters, numbers and underscores`,
                code: 'invalid_username',
            },
            422,
        );
    }

    // Taken exactly as sent: never trimmed, never normalized. A password whose
    // spaces are silently eaten here is one the student cannot type at
    // /auth/v1/token afterwards. Checked before the code is anywhere near spent,
    // against the same policy GoTrue enforces on the password write below.
    const password = typeof body.password === 'string' ? body.password : '';
    const problem = deps.password.passwordProblem(password);
    if (problem) {
        return json({ error: deps.password.passwordProblemMessage(problem), code: 'weak_password' }, 422);
    }

    // Optional, forwarded untouched to the password grant below and nowhere
    // else. GoTrue's captcha (`[auth.captcha]`) is PROJECT-WIDE, so the token
    // has to come from whoever called us. NOT verified here: a Turnstile token
    // may be redeemed once, and GoTrue is the verifier. The grant comes BEFORE
    // the code is spent, so a refused challenge costs a retry and not the card.
    const captchaToken = typeof body.captchaToken === 'string' && body.captchaToken ? body.captchaToken : null;

    const backend = deps.backend;
    if (!backend) {
        return json({ error: 'Server misconfigured' }, 500);
    }

    // The reservation is the lookup: the same three filters (this hash, not
    // archived, not yet claimed), and the row is held for this request before
    // anything is written to the account. An RPC failure answers REJECTED, as
    // the lookup's own error did, so an outage is not an oracle either.
    const codeHash = await codes.hashLoginCode(normalized);
    const reserved = await backend.reserveClaim(codeHash);
    if (!reserved || reserved.status === 'not_found') {
        return reject();
    }
    if (reserved.status === 'busy') {
        return json({ ...CLAIM_IN_PROGRESS, retryAfterSec: reserved.retryAfterSec }, 409);
    }
    const { reservation, studentId, studentUserId, displayName } = reserved;
    // Every return between here and the commit hands the row back first.
    const release = () => backend.releaseClaim(studentId, reservation);

    // The address comes from the auth user the roster row points at, never from
    // the request: an email the caller supplied would let a known code be aimed
    // at somebody else's account. user_type is admin-set at creation, so
    // checking it means a roster row that somehow named an ordinary account
    // could not turn this open endpoint into a password RESET for it.
    const studentUser = await backend.readAuthUser(studentUserId);
    if (!studentUser || !studentUser.email) {
        deps.logError(`roster row ${studentId} points at an auth user that cannot be read`);
        await release();
        return reject();
    }
    if (studentUser.userType !== 'student') {
        deps.logError(`roster row ${studentId} points at an account that is not a provisioned student`);
        await release();
        return reject();
    }
    const email = studentUser.email;

    // A friendly answer for the overwhelmingly common case, ahead of the write.
    // The unique index is still the authority (the commit's 23505 below).
    if (await backend.usernameTakenByOther(username, studentId)) {
        await release();
        return json(USERNAME_TAKEN, 409);
    }

    // Not for a student whose teacher's account is being deleted: the password
    // write is an Auth write no database trigger can refuse (decision 61).
    // Check-then-write, like every Edge deletion check; the deletion removes
    // the account either way.
    const deletion = await backend.teacherDeletionPending(studentId);
    if (deletion !== 'clear') {
        await release();
        return deletion === 'pending' ? json(CLAIM_DELETION_PENDING, 409) : json(CLAIM_CHECK_UNAVAILABLE, 503);
    }

    // The password goes first — and only now, with the row reserved. The
    // half-state it leaves is safe: the roster row is still Invited, so
    // student-login matches nothing and the code is still live for a retry.
    const passwordError = await backend.setPassword(studentUserId, password);
    if (passwordError) {
        deps.logError(`could not set the password for student ${studentId}: ${passwordError}`);
        await release();
        return json({ error: 'Could not set up the account' }, 502);
    }

    // The sign-in comes BEFORE the commit, so the one thing that can refuse a
    // password grant for a reason unconnected to the password — GoTrue's
    // project-wide captcha — gets its say while the card still works.
    const signIn = await backend.signIn(email, password, captchaToken);
    if (!signIn.ok) {
        deps.logError(`claim for student ${studentId} could not sign in: ${signIn.error?.message ?? 'no session'}`);
        await release();
        return captchaRefusal(signIn.error)
            ? json(CAPTCHA_FAILED, 403)
            : json(
                  { error: 'Could not finish setting up your account. Please try again.', code: 'claim_unavailable' },
                  502,
              );
    }

    // The commit: stores the name, stamps the claim and spends the code — only
    // while the row still carries this hash and this request still holds it.
    const completed = await backend.completeClaim(studentId, reservation, codeHash, username);
    if (completed !== 'claimed') {
        // Nothing was stored, so the session just minted must not be handed out.
        await backend.signOutSession(signIn.session.accessToken);
        if (completed === 'username_taken') {
            // The unique index fired between the pre-check and here. Nothing was
            // written, so the code is still live and the student picks another.
            await release();
            return json(USERNAME_TAKEN, 409);
        }
        if (completed === 'error') {
            deps.logError(`could not claim roster row ${studentId}`);
            await release();
            return json({ error: 'Could not set up the account' }, 502);
        }
        // Lost: the row was archived, its code rotated, or this reservation
        // expired and was taken over. REJECTED, the same answer the lookup would
        // give a moment later. Released all the same: an archive keeps the
        // reservation until its holder lets go (so a reset waits for us), and a
        // release only ever removes this request's own reservation.
        deps.logError(`roster row ${studentId} was no longer this claim's when it tried to commit`);
        await release();
        return reject();
    }

    // The card is spent and the username is this student's now, so whatever
    // student-login has counted against that name no longer stands between them
    // and signing in. Best effort, past the commit.
    await backend.forgetLogin(username);

    // The token pair, the name and the username the student now owns. The
    // synthetic email never leaves the server.
    return json({
        accessToken: signIn.session.accessToken,
        refreshToken: signIn.session.refreshToken,
        displayName,
        username,
    });
};
