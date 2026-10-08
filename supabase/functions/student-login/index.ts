import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/imslp.ts';
import {
    accountThrottleKey,
    beginLoginAttempt,
    clearLoginAttempts,
    STUDENT_LOGIN_THROTTLE,
    tooManyAttemptsMessage,
    waitForFloor,
} from '../_shared/loginThrottle.ts';
import { normalizeUsername, USERNAME_RE } from '../_shared/studentCodes.ts';

/**
 * Student sign-in by username and password.
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
 * lookup has to happen under the service role, here.
 *
 * The credential is now the student's own password, chosen when they spent their
 * code in student-claim. That changes the brute-force story from the one this
 * function used to tell: the ~59-bit code space is no longer what stands behind
 * a guess, a user-chosen password is, and it is guarded by the per-IP ceiling
 * below PLUS a per-ACCOUNT limiter. The per-IP ceiling is a CLASSROOM rather
 * than a person, because a whole studio arrives behind one school NAT at the
 * top of a lesson — a limit tight enough to be interesting against one account
 * would read as an outage for the 11th child to sign in. checkRateLimit fails
 * closed, so losing the RPC does not open the endpoint. clientKey() is what
 * makes the bucket meaningful: see its note on why the first x-forwarded-for
 * entry is the caller's to choose.
 *
 * The per-account limit used to be left to GoTrue, and GoTrue cannot do it: it
 * throttles by IP, and the only IP it ever sees here is this function's. So a
 * few hundred attacker addresses could each spend their 60/min on one child's
 * username. loginThrottle.ts now counts attempts per username (as typed — real
 * or not, so a lockout confirms nothing) before the password is checked, and
 * locks the username out with exponential backoff after a handful of misses.
 *
 * One indistinguishable failure, unchanged in spirit and more load-bearing than
 * before: bad username shape, no such username, an unclaimed or archived row, an
 * unreadable auth user, a refused password — every path answers with exactly
 * REJECTED, and no sooner than REJECTION_FLOOR_MS after the request arrived —
 * a username nobody has is refused after one lookup, a real one only after a
 * GoTrue round-trip, and without the floor the response TIME would say which.
 * Whether a username exists is not something this endpoint confirms, which
 * matters now that a username is the thing an attacker would enumerate first.
 * student-claim may say "that username is taken" because a caller there
 * already holds a valid code; nothing here holds anything.
 *
 * Email-method students never touch this function. They have a real address, no
 * username at all, and sign in client-side exactly as a teacher does.
 */

/** The only failure this endpoint has. Never varied — see the note above. */
const REJECTED = { error: 'That username and password did not work', code: 'invalid_credentials' };

const rejectNow = (): Response => jsonResponse(REJECTED, 401);

Deno.serve(async (req) => {
    const startedAt = Date.now();
    // Every credential rejection waits out the same floor: see the note above.
    const reject = async (): Promise<Response> => {
        await waitForFloor(startedAt);
        return rejectNow();
    };

    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    // Ahead of everything, the body read included: this is the brute-force gate,
    // so it must cost an attacker a slot even for a request that never parses.
    const rate = await checkRateLimit(`student-login:${clientKey(req)}`, 60, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    let body: { username?: string; password?: string };
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    // Stored usernames are canonical-lowercase, so normalizing here means the
    // capital a phone keyboard adds is not a way to fail. Shape only, and never
    // isValidUsername: the reserved list is a rule about what may be CLAIMED, and
    // a reserved name simply has no row to match. The sign-in side explains
    // nothing anyway — a missing or non-string field normalizes to '' and falls
    // into the same single rejection as everything else.
    const username = normalizeUsername(typeof body.username === 'string' ? body.username : '');
    if (!USERNAME_RE.test(username)) {
        return await reject();
    }

    // Taken exactly as sent: never trimmed, never normalized. The student chose
    // it, GoTrue stored the bcrypt of those exact bytes, and anything done to it
    // here is a password that silently stops working.
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) {
        return await reject();
    }

    const admin = serviceClient();
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!admin || !supabaseUrl || !anonKey) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // The per-account gate, keyed on the username as typed and counted BEFORE
    // anything about the account is looked up — so it answers identically for
    // a name nobody has, and a burst of parallel guesses is counted up front
    // rather than after each one has had its bcrypt check. Fails closed.
    const accountKey = await accountThrottleKey('student-login', username);
    const gate = await beginLoginAttempt(admin, accountKey, STUDENT_LOGIN_THROTTLE);
    if (!gate.ok) {
        return jsonResponse(
            {
                error: tooManyAttemptsMessage(gate.retryAfterSec),
                code: 'too_many_attempts',
                retryAfterSec: gate.retryAfterSec,
            },
            429,
        );
    }

    // Three filters, one rejection. An archived row no longer matches, which is
    // what makes archiving a student a revocation of their sign-in and not just
    // of their seat; an unclaimed row is one whose password is a scramble nobody
    // has ever seen, so matching it could only ever produce a refused sign-in.
    // An email-method row can never match at all — its username is NULL.
    const { data: student, error: lookupError } = await admin
        .from('managed_students')
        .select('id, student_user_id, display_name')
        .eq('username', username)
        .is('archived_at', null)
        .not('claimed_at', 'is', null)
        .maybeSingle();
    if (lookupError || !student) {
        return await reject();
    }

    // The synthetic address comes from the auth user the roster row points at,
    // never from the request: an email the caller supplied would let a known
    // password be aimed at somebody else's account.
    const { data: userData, error: userError } = await admin.auth.admin.getUserById(student.student_user_id);
    const studentUser = userData?.user;
    const email = studentUser?.email;
    if (userError || !studentUser || !email) {
        console.error(`roster row ${student.id} points at an auth user that cannot be read`);
        return await reject();
    }
    // Belt and braces on top of that. app_metadata.user_type is admin-set at
    // creation, so checking it here means a roster row that somehow named an
    // ordinary account could not turn this open endpoint into a password login
    // for it.
    if (studentUser.app_metadata?.user_type !== 'student') {
        console.error(`roster row ${student.id} points at an account that is not a provisioned student`);
        return await reject();
    }

    // A FRESH anon-key client, deliberately carrying no Authorization header:
    // nothing the caller sent travels with this sign-in, and the session it
    // produces is handed to the client rather than kept in the isolate.
    const anonClient = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: signIn, error: signInError } = await anonClient.auth.signInWithPassword({
        email,
        password,
    });
    if (signInError || !signIn.session) {
        return await reject();
    }

    // Signed in: the misses before this one were typos, not an attack.
    await clearLoginAttempts(admin, accountKey);

    // The token pair and the names, nothing else: the client calls
    // supabase.auth.setSession with the pair. The synthetic email is an
    // implementation detail of provisioning and never leaves the server, and no
    // user object is echoed back for a caller to mine.
    return jsonResponse({
        accessToken: signIn.session.access_token,
        refreshToken: signIn.session.refresh_token,
        displayName: student.display_name,
        username,
    });
});
