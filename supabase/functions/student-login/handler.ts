import type * as LoginThrottle from '../_shared/loginThrottle.ts';
import type * as StudentCodes from '../_shared/studentCodes.ts';

/**
 * Student sign-in by username and password — the control flow, apart from the
 * clients it runs against.
 *
 * index.ts wires this to Supabase; tests drive it with stubs. It has no runtime
 * imports for the same reason loginThrottle.ts has none (Deno wants the `.ts`
 * extension, vitest and tsc want it gone): everything it calls arrives in
 * `deps`, and the type-only imports above vanish at compile time.
 *
 * Deployed with `verify_jwt = false` (see supabase/config.toml) — the second
 * such function after stripe-webhook, and for the same structural reason: the
 * caller has no Supabase JWT to present. A student at the sign-in box is not
 * signed in yet; this is the endpoint that gets them a session.
 *
 * The function exists at all because a student's auth account is keyed on a
 * SYNTHETIC address (st-<roster-id>@students.cleffy.app) that nobody, the
 * student included, ever sees. The username is the public half of that identity
 * and managed_students is the only thing that maps one to the other, so the
 * lookup has to happen under the service role.
 *
 * The credential is the student's own password, chosen when they spent their
 * code in student-claim, so what stands behind a guess is a user-chosen
 * password. It is guarded by the per-IP ceiling PLUS loginThrottle.ts's
 * per-username limits. The per-IP ceiling is a CLASSROOM rather than a person,
 * because a whole studio arrives behind one school NAT at the top of a lesson —
 * a limit tight enough to be interesting against one account would read as an
 * outage for the 11th child to sign in. checkRateLimit fails closed, so losing
 * the RPC does not open the endpoint. clientKey() is what makes the bucket
 * meaningful: see its note on why the first x-forwarded-for entry is the
 * caller's to choose.
 *
 * The per-username limits used to be left to GoTrue, and GoTrue cannot do it:
 * it throttles by IP, and the only IP it ever sees here is this function's.
 * loginThrottle.ts counts every attempt per username (as typed — real or not,
 * so a lockout confirms nothing) before the password is checked: a steep
 * backoff per (username, address), and a loose ceiling per username from
 * everywhere. Its note explains why it is split that way.
 *
 * One indistinguishable failure: bad username shape, no such username, an
 * unclaimed or archived row, an unreadable auth user, a refused password —
 * every path answers with exactly REJECTED, and no sooner than
 * REJECTION_FLOOR_MS after the request arrived. A username nobody has is
 * refused after one lookup, a real one only after a GoTrue round-trip, and
 * without the floor the response TIME would say which. Whether a username
 * exists is not something this endpoint confirms, which matters because a
 * username is the thing an attacker would enumerate first. student-claim may
 * say "that username is taken" because a caller there already holds a valid
 * code; nothing here holds anything.
 *
 * Email-method students never touch this function. They have a real address, no
 * username at all, and sign in client-side exactly as a teacher does.
 */

/** The only credential failure this endpoint has. Never varied — see above. */
export const REJECTED = { error: 'That username and password did not work', code: 'invalid_credentials' } as const;

type Gate = { ok: true } | { ok: false; retryAfterSec: number };

export interface ClaimedStudent {
    id: string;
    studentUserId: string;
    displayName: string;
}

export interface StudentAuthUser {
    email: string | null;
    /** app_metadata.user_type, as GoTrue holds it. */
    userType: unknown;
}

export interface StudentSession {
    accessToken: string;
    refreshToken: string;
}

/** Everything that needs the service role or GoTrue. */
export interface StudentLoginBackend {
    /** Service-role client the throttle RPCs run on. */
    rpc: LoginThrottle.RpcClient;
    /** loginThrottleSecret(): what the throttle keys are HMAC'd under. */
    throttleSecret: string;
    /** The unarchived, claimed roster row with this username; null for none or on error. */
    findClaimedStudent: (username: string) => Promise<ClaimedStudent | null>;
    /** The auth user a roster row points at; null if it cannot be read. */
    readAuthUser: (userId: string) => Promise<StudentAuthUser | null>;
    /** A password sign-in on a fresh anon client; null when GoTrue refuses. */
    signIn: (email: string, password: string) => Promise<StudentSession | null>;
}

export interface StudentLoginDeps {
    json: (body: unknown, status?: number) => Response;
    options: () => Response;
    clientKey: (req: Request) => string;
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    codes: Pick<typeof StudentCodes, 'normalizeUsername' | 'USERNAME_RE'>;
    throttle: Pick<
        typeof LoginThrottle,
        | 'STUDENT_LOGIN_THROTTLE'
        | 'STUDENT_LOGIN_SCOPE'
        | 'REJECTION_FLOOR_MS'
        | 'loginThrottleKeys'
        | 'beginLoginAttempt'
        | 'clearLoginAttempts'
        | 'tooManyAttemptsMessage'
        | 'waitForFloor'
    >;
    /** Null when the deploy is missing the service role, the anon key or the URL. */
    backend: () => StudentLoginBackend | null;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    logError: (message: string) => void;
}

export const handleStudentLogin = async (req: Request, deps: StudentLoginDeps): Promise<Response> => {
    const { json, throttle } = deps;
    const startedAt = deps.now();
    // Every credential rejection waits out the same floor: see the note above.
    const reject = async (): Promise<Response> => {
        await throttle.waitForFloor(startedAt, throttle.REJECTION_FLOOR_MS, deps.now, deps.sleep);
        return json(REJECTED, 401);
    };

    if (req.method === 'OPTIONS') {
        return deps.options();
    }
    if (req.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }

    // Ahead of everything, the body read included: this is the brute-force gate,
    // so it must cost an attacker a slot even for a request that never parses.
    const client = deps.clientKey(req);
    const rate = await deps.checkRateLimit(`student-login:${client}`, 60, 60_000);
    if (!rate.ok) {
        return json({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    let body: { username?: unknown; password?: unknown };
    try {
        body = await req.json();
    } catch {
        return json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object') {
        body = {};
    }

    // Stored usernames are canonical-lowercase, so normalizing here means the
    // capital a phone keyboard adds is not a way to fail. Shape only, and never
    // isValidUsername: the reserved list is a rule about what may be CLAIMED, and
    // a reserved name simply has no row to match. The sign-in side explains
    // nothing anyway — a missing or non-string field normalizes to '' and falls
    // into the same single rejection as everything else.
    const username = deps.codes.normalizeUsername(typeof body.username === 'string' ? body.username : '');
    if (!deps.codes.USERNAME_RE.test(username)) {
        return await reject();
    }

    // Taken exactly as sent: never trimmed, never normalized. The student chose
    // it, GoTrue stored the bcrypt of those exact bytes, and anything done to it
    // here is a password that silently stops working.
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) {
        return await reject();
    }

    const backend = deps.backend();
    if (!backend) {
        return json({ error: 'Server misconfigured' }, 500);
    }

    // The per-username gate, keyed on the username as typed and counted BEFORE
    // anything about the account is looked up — so it answers identically for
    // a name nobody has, and a burst of parallel guesses is counted up front
    // rather than after each one has had its bcrypt check. Fails closed: a key
    // that cannot be derived is the same refusal as a limiter that cannot count.
    let keys: LoginThrottle.LoginThrottleKeys;
    let gate: Gate;
    try {
        keys = await throttle.loginThrottleKeys(backend.throttleSecret, throttle.STUDENT_LOGIN_SCOPE, username, client);
        gate = await throttle.beginLoginAttempt(backend.rpc, keys, throttle.STUDENT_LOGIN_THROTTLE);
    } catch {
        deps.logError('student-login throttle keys could not be derived');
        return json({ error: throttle.tooManyAttemptsMessage(5), code: 'too_many_attempts', retryAfterSec: 5 }, 429);
    }
    if (!gate.ok) {
        return json(
            {
                error: throttle.tooManyAttemptsMessage(gate.retryAfterSec),
                code: 'too_many_attempts',
                retryAfterSec: gate.retryAfterSec,
            },
            429,
        );
    }

    const student = await backend.findClaimedStudent(username);
    if (!student) {
        return await reject();
    }

    // The synthetic address comes from the auth user the roster row points at,
    // never from the request: an email the caller supplied would let a known
    // password be aimed at somebody else's account.
    const authUser = await backend.readAuthUser(student.studentUserId);
    if (!authUser || !authUser.email) {
        deps.logError(`roster row ${student.id} points at an auth user that cannot be read`);
        return await reject();
    }
    // Belt and braces on top of that. app_metadata.user_type is admin-set at
    // creation, so checking it here means a roster row that somehow named an
    // ordinary account could not turn this open endpoint into a password login
    // for it.
    if (authUser.userType !== 'student') {
        deps.logError(`roster row ${student.id} points at an account that is not a provisioned student`);
        return await reject();
    }

    const session = await backend.signIn(authUser.email, password);
    if (!session) {
        return await reject();
    }

    // Signed in: this address's misses before now were typos, not an attack.
    await throttle.clearLoginAttempts(backend.rpc, keys.source);

    // The token pair and the names, nothing else: the client calls
    // supabase.auth.setSession with the pair. The synthetic email is an
    // implementation detail of provisioning and never leaves the server, and no
    // user object is echoed back for a caller to mine.
    return json({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        displayName: student.displayName,
        username,
    });
};
