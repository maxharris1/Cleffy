import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/imslp.ts';
import { hashLoginCode, isPlausibleLoginCode, normalizeLoginCode } from '../_shared/studentCodes.ts';

/**
 * Student sign-in by login code.
 *
 * Deployed with `verify_jwt = false` (see supabase/config.toml) — the second
 * such function after stripe-webhook, and for the same structural reason: the
 * caller has no Supabase JWT to present. A student typing the code off their
 * card is not signed in yet; this is the endpoint that gets them a session.
 *
 * The code IS the credential: it selects the roster row by hash AND is the
 * password of the synthetic student user, so whoever holds it needs nothing
 * else, and whoever does not gets nowhere. Two things keep an endpoint this
 * open from being a guessing machine:
 *
 *  * The hard rate limit below, taken before any other work — 10 attempts per
 *    minute per IP against the ~59-bit code space of _shared/studentCodes.ts.
 *    That is the brute-force story: at that rate an attacker exhausts a
 *    meaningful fraction of the space some hundreds of millions of years from
 *    now, and checkRateLimit fails closed, so losing the RPC does not open it.
 *  * One indistinguishable failure. Wrong shape, no such code, archived
 *    student, unreadable auth user, refused password — every path answers with
 *    exactly REJECTED, so this is never an oracle for which codes exist. Only
 *    the "no such code" path is reachable by guessing at all; the rest are
 *    internal inconsistencies a caller cannot provoke, so the fact that they
 *    return later in the function leaks nothing either.
 */

/** The only failure this endpoint has. Never varied — see the note above. */
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
    const rate = await checkRateLimit(`student-login:${clientKey(req)}`, 10, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    let body: { code?: string };
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

    const admin = serviceClient();
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!admin || !supabaseUrl || !anonKey) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // The hash is all the roster stores, so this is the entire lookup. An archived
    // row no longer matches, which is what makes archiving a student a real
    // revocation of their code and not just of their seat.
    const hash = await hashLoginCode(normalized);
    const { data: student, error: lookupError } = await admin
        .from('managed_students')
        .select('id, student_user_id, display_name')
        .eq('login_code_hash', hash)
        .is('archived_at', null)
        .maybeSingle();
    if (lookupError || !student) {
        return reject();
    }

    // The synthetic address comes from the auth user the roster row points at,
    // never from the request: an email the caller supplied would let a known code
    // be aimed at somebody else's account.
    const { data: userData, error: userError } = await admin.auth.admin.getUserById(student.student_user_id);
    const studentUser = userData?.user;
    const email = studentUser?.email;
    if (userError || !studentUser || !email) {
        console.error(`roster row ${student.id} points at an auth user that cannot be read`);
        return reject();
    }
    // Belt and braces on top of that. app_metadata.user_type is admin-set at
    // creation, so checking it here means a roster row that somehow named an
    // ordinary account could not turn this open endpoint into a password login
    // for it.
    if (studentUser.app_metadata?.user_type !== 'student') {
        console.error(`roster row ${student.id} points at an account that is not a provisioned student`);
        return reject();
    }

    // A FRESH anon-key client, deliberately carrying no Authorization header:
    // nothing the caller sent travels with this sign-in, and the session it
    // produces is handed to the client rather than kept in the isolate.
    const anonClient = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: signIn, error: signInError } = await anonClient.auth.signInWithPassword({
        email,
        password: normalized,
    });
    if (signInError || !signIn.session) {
        return reject();
    }

    // The token pair and the name, nothing else: the client calls
    // supabase.auth.setSession with the pair. The synthetic email is an
    // implementation detail of provisioning and never leaves the server, and no
    // user object is echoed back for a caller to mine.
    return jsonResponse({
        accessToken: signIn.session.access_token,
        refreshToken: signIn.session.refresh_token,
        displayName: student.display_name,
    });
});
