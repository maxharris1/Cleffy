import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/imslp.ts';
import {
    hashLoginCode,
    isPlausibleLoginCode,
    isValidStudentPassword,
    isValidUsername,
    normalizeLoginCode,
    normalizeUsername,
    STUDENT_PASSWORD_MIN,
    USERNAME_MAX,
    USERNAME_MIN,
} from '../_shared/studentCodes.ts';

/**
 * Spending a login code: the one time a student's code is ever accepted.
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
 * Three failures deliberately DO distinguish themselves, because none of them is
 * an oracle: the username and password rules are printed on the form the student
 * is looking at, so refusing silently would just be a form that cannot be
 * filled in. "That username is taken" is the interesting one — it is reachable
 * only by someone already holding a valid, unclaimed code, and a username is a
 * semi-public login identifier rather than a secret, so answering it costs
 * nothing and hiding it would strand a student on a name they cannot use.
 */

/** The only failure a guess can reach. Never varied — see the note above. */
const REJECTED = { error: 'That code did not work', code: 'invalid_code' };

const reject = (): Response => jsonResponse(REJECTED, 401);

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    // Ahead of everything, the body read included: this is the brute-force gate,
    // so it must cost an attacker a slot even for a request that never parses.
    const rate = await checkRateLimit(`student-claim:${clientKey(req)}`, 60, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    let body: { code?: string; username?: string; password?: string };
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    // Cards print XXXX-XXXX-XXXX, so normalizing first means the dashes, spaces
    // and lower case a child types are not a way to fail. A missing or non-string
    // `code` normalizes to '' and falls into the same single rejection below.
    const normalized = normalizeLoginCode(typeof body.code === 'string' ? body.code : '');
    if (!isPlausibleLoginCode(normalized)) {
        return reject();
    }

    // Checked after the code, so a bad code plus a bad username is still one
    // indistinguishable 401 rather than a hint that the code was the good half.
    const username = normalizeUsername(typeof body.username === 'string' ? body.username : '');
    if (!isValidUsername(username)) {
        return jsonResponse(
            {
                error: `Usernames are ${USERNAME_MIN}-${USERNAME_MAX} lowercase letters, numbers and underscores`,
                code: 'invalid_username',
            },
            422,
        );
    }

    // Taken exactly as sent: never trimmed, never normalized. A password whose
    // spaces are silently eaten here is one the student cannot type at
    // /auth/v1/token afterwards.
    const password = typeof body.password === 'string' ? body.password : '';
    if (!isValidStudentPassword(password)) {
        return jsonResponse(
            { error: `Passwords are at least ${STUDENT_PASSWORD_MIN} characters`, code: 'weak_password' },
            422,
        );
    }

    const admin = serviceClient();
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!admin || !supabaseUrl || !anonKey) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // The hash is all the roster stores. Three filters, one rejection: an
    // archived student's code is refused because archiving is a real revocation,
    // and a claimed_at that is already set means this card was spent — the row
    // it belongs to now has a username and no hash at all.
    const hash = await hashLoginCode(normalized);
    const { data: student, error: lookupError } = await admin
        .from('managed_students')
        .select('id, student_user_id, display_name')
        .eq('login_code_hash', hash)
        .is('archived_at', null)
        .is('claimed_at', null)
        .maybeSingle();
    if (lookupError || !student) {
        return reject();
    }

    // The address comes from the auth user the roster row points at, never from
    // the request: an email the caller supplied would let a known code be aimed
    // at somebody else's account.
    const { data: userData, error: userError } = await admin.auth.admin.getUserById(student.student_user_id);
    const studentUser = userData?.user;
    const email = studentUser?.email;
    if (userError || !studentUser || !email) {
        console.error(`roster row ${student.id} points at an auth user that cannot be read`);
        return reject();
    }
    // Belt and braces on top of that. app_metadata.user_type is admin-set at
    // creation, so checking it here means a roster row that somehow named an
    // ordinary account could not turn this open endpoint into a password RESET
    // for it.
    if (studentUser.app_metadata?.user_type !== 'student') {
        console.error(`roster row ${student.id} points at an account that is not a provisioned student`);
        return reject();
    }

    // A friendly answer for the overwhelmingly common case, ahead of the write.
    // The unique index is still the authority — this is a race the pre-check
    // cannot close, which is why the 23505 branch below says the same thing.
    const { data: taken } = await admin
        .from('managed_students')
        .select('id')
        .eq('username', username)
        .neq('id', student.id)
        .maybeSingle();
    if (taken) {
        return jsonResponse({ error: 'That username is taken', code: 'username_taken' }, 409);
    }

    // The password goes FIRST, and the half-state that leaves is safe in every
    // direction: the roster row is still Invited, so student-login matches
    // nothing and the code is still live for a retry. The only person who could
    // have set that password is whoever held the code, and the account they set
    // it on has no sign-in path until the row below says it does.
    const { error: passwordError } = await admin.auth.admin.updateUserById(student.student_user_id, {
        password,
    });
    if (passwordError) {
        console.error(`could not set the password for student ${student.id}: ${passwordError.message}`);
        return jsonResponse({ error: 'Could not set up the account' }, 502);
    }

    // The commit: one UPDATE that stores the name, stamps the claim and spends
    // the code. Guarded on claimed_at still being null so two claims racing the
    // same card cannot both win, and the CHECK constraint refuses any two of
    // these three landing without the third.
    const { error: claimError } = await admin
        .from('managed_students')
        .update({
            username,
            claimed_at: new Date().toISOString(),
            login_code_hash: null,
        })
        .eq('id', student.id)
        .is('claimed_at', null);
    if (claimError) {
        // The unique index fired between the pre-check and here. Nothing was
        // written, so the code is still live and the student simply picks
        // another name — the same answer the pre-check gives.
        if (claimError.code === '23505') {
            return jsonResponse({ error: 'That username is taken', code: 'username_taken' }, 409);
        }
        console.error(`could not claim roster row ${student.id}: ${claimError.message}`);
        return jsonResponse({ error: 'Could not set up the account' }, 502);
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
        // Past the commit, so this is NOT a rejection: the account exists, the
        // credential works, and only the convenience of being signed in straight
        // away was lost. Saying "that code did not work" here would send a
        // student back to a card that is now spent.
        console.error(`claim committed for student ${student.id} but the sign-in failed`);
        return jsonResponse(
            {
                error: 'Your account is ready — sign in with your new username and password',
                code: 'claimed_sign_in_failed',
            },
            502,
        );
    }

    // The token pair, the name and the username the student now owns. The client
    // calls supabase.auth.setSession with the pair. The synthetic email stays an
    // implementation detail of provisioning and never leaves the server, and no
    // user object is echoed back for a caller to mine.
    return jsonResponse({
        accessToken: signIn.session.access_token,
        refreshToken: signIn.session.refresh_token,
        displayName: student.display_name,
        username,
    });
});
