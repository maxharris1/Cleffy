import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { rejectAnonymous, rejectStudent, requireUser } from '../_shared/auth.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { isUnlimited, LIMIT_REACHED_STATUS, limitReachedBody, type Entitlements } from '../_shared/entitlements.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/imslp.ts';
import { supabaseQuotaBackend } from '../_shared/quota.ts';
import {
    formatLoginCode,
    generateLoginCode,
    generateProvisionPassword,
    hashLoginCode,
    syntheticStudentEmail,
} from '../_shared/studentCodes.ts';

/**
 * Teacher-side roster management: create / reset / archive / restore.
 *
 * Provisioning a student means creating a real auth user, which no client may
 * do, so every write here runs under the service role — managed_students has no
 * client write policy at all, by design (see 20260826194426_roster.sql).
 *
 * TWO METHODS, chosen per student at creation and fixed for the life of the row
 * (see 20260827150000_student_credentials.sql for the state machine this obeys):
 *
 *  * 'code' — the zero-email path, for a young child. A synthetic address nobody
 *    ever sees, and a printed code that is a ONE-TIME CLAIM TOKEN: student-claim
 *    spends it for a username and a password of the student's own. The account's
 *    password here is a scramble nobody has ever seen, never the code, so the
 *    card on the piano is not a credential and an unclaimed account has no
 *    sign-in path at all.
 *  * 'email' — the teacher supplies the student's real address and GoTrue
 *    invites it. No code, no username, no synthetic address; the student sets a
 *    password from the emailed link and signs in client-side like a teacher.
 *
 * 'reset' is the one recovery path for both, and it is a revocation before it is
 * anything else: the password is scrambled FIRST, then the row goes back to
 * Invited. A half-applied reset therefore always fails safe — access is already
 * gone — and re-running it repairs the rest.
 *
 * The roster is a STOCK, not a flow: `students` never reaches usage_counters, it
 * is the live count of unarchived rows, checked here where a seat is claimed.
 * That is why 'create' and 'restore' share one check and 'archive' needs none —
 * archiving is what gives a seat back.
 *
 * 'archive' and 'restore' each touch TWO things, because the roster row and the
 * auth account are two halves of one student: the row decides the seat and what
 * student-login will match, and the account's ban decides whether the student's
 * password still opens a session at all. Archiving only the row would leave a
 * student who knows their own password working directly against /auth/v1/token —
 * more true now than when the credential was a code, not less.
 *
 * Nothing in this file consumes a metered budget. Students are never billed, and
 * a teacher's roster is paid for by occupancy rather than by activity.
 */

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deliberately loose: this catches typos, it does not adjudicate addresses. */
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_DISPLAY_NAME = 80;

/**
 * How long an archived student's account stays banned — a Go duration, GoTrue's
 * format, set to a century because "until restored" has no spelling. 'none'
 * lifts it, which is what 'restore' sends.
 *
 * A ban is the revocation archiving needs and the archived_at stamp is not: it
 * refuses the password grant at /auth/v1/token AND every refresh, so a live
 * session dies with its current access token rather than lasting forever.
 */
const ARCHIVE_BAN_DURATION = '876000h';

interface ProvisionBody {
    action?: string;
    /** 'code' | 'email', on 'create' only. Explicit — see createStudent. */
    method?: string;
    displayName?: string;
    parentEmail?: string;
    studentEmail?: string;
    /** Where the invite / reset link lands. Required on the email path. */
    redirectTo?: string;
    studentId?: string;
}

interface RosterRow {
    id: string;
    student_user_id: string;
    archived_at: string | null;
    auth_method: string;
    username: string | null;
    student_email: string | null;
}

type Gate = { ok: true } | { ok: false; response: Response };

type OwnedRoster = { ok: true; row: RosterRow } | { ok: false; response: Response };

const readBody = async (req: Request): Promise<ProvisionBody | null> => {
    try {
        return (await req.json()) as ProvisionBody;
    } catch {
        return null;
    }
};

/**
 * Effective entitlements for the caller, straight from get_entitlements().
 *
 * Taken through supabaseQuotaBackend rather than read from the RPC here, so this
 * function shares the one place that maps that jsonb onto Entitlements. It is
 * the only half of ./quota.ts a roster needs: `students` is a stock, so there is
 * nothing for enforce()/refund() to count.
 */
const loadEntitlements = (admin: SupabaseClient, userId: string): Promise<Entitlements | null> =>
    supabaseQuotaBackend(admin).getEntitlements(userId);

/**
 * The roster stock, checked before a seat is claimed — by 'create' and equally
 * by 'restore', since a restored row re-occupies the seat it gave up.
 *
 * Check-then-write, unlike consume_quota: there is no single statement that both
 * counts unarchived rows and claims one, so two simultaneous creates can both
 * see the same last free seat. The window is one seat wide and self-correcting
 * (the next create refuses), and a teacher racing themselves is not what this
 * gate is here to stop.
 */
const checkRosterStock = async (admin: SupabaseClient, userId: string): Promise<Gate> => {
    const entitlements = await loadEntitlements(admin, userId);
    if (!entitlements) {
        // Fail closed: an unresolvable tier must not be read as an open roster.
        return { ok: false, response: jsonResponse({ error: 'Could not resolve entitlements' }, 500) };
    }

    const limit = entitlements.limits.students;
    if (isUnlimited(limit)) {
        return { ok: true };
    }

    const refusal = (): Gate => ({
        ok: false,
        response: jsonResponse(limitReachedBody('students', limit, entitlements.tier), LIMIT_REACHED_STATUS),
    });

    // Personal carries students: 0 — the solo practice plan has no roster at all,
    // so it refuses without spending a query on the count.
    if (limit === 0) {
        return refusal();
    }

    const { count, error } = await admin
        .from('managed_students')
        .select('id', { count: 'exact', head: true })
        .eq('teacher_id', userId)
        .is('archived_at', null);
    if (error || count === null) {
        // Fail closed again: an unreadable roster must not hand out a free seat.
        return { ok: false, response: jsonResponse({ error: 'Could not read the roster' }, 502) };
    }

    return count >= limit ? refusal() : { ok: true };
};

/** Resolves the roster row and proves the caller owns it, in one query. */
const loadOwnedRoster = async (
    admin: SupabaseClient,
    userId: string,
    studentId: string | undefined,
): Promise<OwnedRoster> => {
    const id = typeof studentId === 'string' ? studentId.trim() : '';
    if (!uuidRe.test(id)) {
        return { ok: false, response: jsonResponse({ error: 'studentId must be a UUID' }, 400) };
    }

    const { data, error } = await admin
        .from('managed_students')
        .select('id, student_user_id, archived_at, auth_method, username, student_email')
        .eq('id', id)
        .eq('teacher_id', userId)
        .maybeSingle<RosterRow>();
    if (error) {
        return { ok: false, response: jsonResponse({ error: 'Could not read the roster' }, 502) };
    }
    if (!data) {
        // One 404 for "no such row" and "not yours" alike: whether another
        // teacher's roster holds this id is not the caller's business.
        return { ok: false, response: jsonResponse({ error: 'Student not found' }, 404) };
    }

    return { ok: true, row: data };
};

/** Everything both create paths validated before either of them wrote anything. */
interface NewStudent {
    rosterId: string;
    displayName: string;
    parentEmail: string | null;
}

/**
 * GoTrue refusing an address that already has an account. supabase-js v2 carries
 * `code: 'email_exists'`; the message is matched too because that code is a
 * recent addition and this is the difference between telling the teacher which
 * field to fix and handing them an opaque 502.
 */
const isEmailInUse = (error: { code?: string; message?: string }): boolean =>
    error.code === 'email_exists' ||
    error.code === 'user_already_exists' ||
    /already (been )?registered|already exists/i.test(error.message ?? '');

/**
 * The zero-email path. The account gets a scramble for a password —
 * generateProvisionPassword, generated, set and forgotten — so the printed code
 * is a claim token and nothing else: it selects this row once, in student-claim,
 * and until it does no sign-in path to the account exists for anyone.
 */
const createCodeStudent = async (admin: SupabaseClient, userId: string, spec: NewStudent): Promise<Response> => {
    const { rosterId, displayName, parentEmail } = spec;
    const code = generateLoginCode();
    // Generated codes are already in normalized form, which is exactly what
    // student-claim hashes after normalizeLoginCode() on what the student typed.
    const loginCodeHash = await hashLoginCode(code);

    const { data: created, error: createError } = await admin.auth.admin.createUser({
        email: syntheticStudentEmail(rosterId),
        // NOT the code. Nobody, this function included, remembers this value.
        password: generateProvisionPassword(),
        // No inbox exists behind that address, so nothing could ever confirm it.
        email_confirm: true,
        // app_metadata is admin-only, which is what makes this flag trustworthy in
        // get_entitlements() and in the documents_insert policy.
        app_metadata: { user_type: 'student', teacher_id: userId },
        user_metadata: { display_name: displayName },
    });
    if (createError || !created.user) {
        // Logged rather than returned: an auth error can name the synthetic
        // address, which is an implementation detail even the teacher never sees.
        console.error(`student account creation failed for ${userId}: ${createError?.message ?? 'no user returned'}`);
        return jsonResponse({ error: 'Could not create the student account' }, 502);
    }

    const { error: insertError } = await admin.from('managed_students').insert({
        id: rosterId,
        teacher_id: userId,
        student_user_id: created.user.id,
        display_name: displayName,
        // The column default would cover this. Written out because the method is
        // what every other branch in this file reads to decide what a student is.
        auth_method: 'code',
        login_code_hash: loginCodeHash,
        parent_email: parentEmail,
    });
    if (insertError) {
        // An auth user with no roster row is unreachable forever: no teacher can
        // see it, no reset can reach it, and it holds the unique
        // student_user_id against a later re-provision. Undo it.
        const { error: cleanupError } = await admin.auth.admin.deleteUser(created.user.id);
        if (cleanupError) {
            console.error(`orphaned student auth user ${created.user.id}: ${cleanupError.message}`);
        }
        return jsonResponse({ error: 'Could not create the student roster row' }, 502);
    }

    // The one and only time this code is readable. managed_students keeps the
    // SHA-256 of it and nothing keeps the plaintext, so a lost code is replaced
    // by 'reset', never recovered.
    return jsonResponse({
        student: { id: rosterId, studentUserId: created.user.id, displayName },
        loginCode: formatLoginCode(code),
    });
};

/**
 * The email path: an older student with an address of their own. GoTrue mails
 * the invite and the student sets a password from the link, so no credential is
 * ever minted here and nothing is displayed to the teacher afterwards.
 */
const createEmailStudent = async (
    admin: SupabaseClient,
    userId: string,
    spec: NewStudent & { studentEmail: string; redirectTo: string },
): Promise<Response> => {
    const { rosterId, displayName, parentEmail, studentEmail, redirectTo } = spec;

    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(studentEmail, {
        data: { display_name: displayName },
        redirectTo,
    });
    if (inviteError || !invited.user) {
        // The one auth failure worth naming: it is the teacher's own typo or a
        // student who already has a Cleffy account, and both are fixed in the
        // form rather than by retrying.
        if (inviteError && isEmailInUse(inviteError)) {
            return jsonResponse(
                { error: 'That email address already has a Cleffy account', code: 'email_in_use' },
                409,
            );
        }
        console.error(`student invite failed for ${userId}: ${inviteError?.message ?? 'no user returned'}`);
        return jsonResponse({ error: 'Could not send the invitation' }, 502);
    }

    // inviteUserByEmail cannot set app_metadata, so the flag that makes this
    // account a student arrives one call later. Everything that gates a student —
    // get_entitlements(), documents_insert, rejectStudent — reads it, so an
    // account left without it is an ORDINARY free account sitting on a child's
    // address, already invited and claimable by whoever opens the mail. Deleting
    // it is the only acceptable outcome of failing here.
    const { error: metadataError } = await admin.auth.admin.updateUserById(invited.user.id, {
        app_metadata: { user_type: 'student', teacher_id: userId },
    });
    if (metadataError) {
        console.error(`could not flag invited student ${invited.user.id}: ${metadataError.message}`);
        const { error: cleanupError } = await admin.auth.admin.deleteUser(invited.user.id);
        if (cleanupError) {
            console.error(`unflagged student auth user ${invited.user.id}: ${cleanupError.message}`);
        }
        return jsonResponse({ error: 'Could not create the student account' }, 502);
    }

    const { error: insertError } = await admin.from('managed_students').insert({
        id: rosterId,
        teacher_id: userId,
        student_user_id: invited.user.id,
        display_name: displayName,
        auth_method: 'email',
        student_email: studentEmail,
        // No code is ever minted on this path, and no username is ever chosen:
        // the state CHECK requires both to stay null for the life of the row.
        parent_email: parentEmail,
    });
    if (insertError) {
        const { error: cleanupError } = await admin.auth.admin.deleteUser(invited.user.id);
        if (cleanupError) {
            console.error(`orphaned student auth user ${invited.user.id}: ${cleanupError.message}`);
        }
        return jsonResponse({ error: 'Could not create the student roster row' }, 502);
    }

    // The address is echoed back so the teacher can see, prominently, exactly
    // where the invitation went — a typo here mails a stranger, and this is the
    // moment to catch it.
    return jsonResponse({
        student: { id: rosterId, studentUserId: invited.user.id, displayName },
        invited: true,
        studentEmail,
    });
};

const createStudent = async (admin: SupabaseClient, userId: string, body: ProvisionBody): Promise<Response> => {
    // EXPLICIT, and defaulted rather than required so existing callers keep
    // working: reading the method off the presence of `studentEmail` would let a
    // stray field flip a child onto the email path, which is the one decision in
    // this file that cannot be undone afterwards.
    const method = body.method ?? 'code';
    if (method !== 'code' && method !== 'email') {
        return jsonResponse({ error: "method must be 'code' or 'email'" }, 400);
    }

    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName || displayName.length > MAX_DISPLAY_NAME) {
        return jsonResponse({ error: `displayName must be 1-${MAX_DISPLAY_NAME} characters` }, 400);
    }

    // Optional, and never the student's own address on either path. This one is
    // the parent's, for the teacher's records and for sending the printed code
    // home.
    const parentEmailInput = typeof body.parentEmail === 'string' ? body.parentEmail.trim() : '';
    if (parentEmailInput && !emailRe.test(parentEmailInput)) {
        return jsonResponse({ error: 'parentEmail must be an email address' }, 400);
    }
    const parentEmail = parentEmailInput || null;

    const studentEmail = typeof body.studentEmail === 'string' ? body.studentEmail.trim() : '';
    // The link GoTrue puts in the mail. Passed through rather than derived: this
    // is the same trust model as the client's own signUp emailRedirectTo, since
    // GoTrue refuses anything outside the project's redirect allow-list.
    const redirectTo = typeof body.redirectTo === 'string' ? body.redirectTo.trim() : '';
    if (method === 'email') {
        if (!studentEmail || !emailRe.test(studentEmail)) {
            return jsonResponse({ error: 'studentEmail must be an email address', code: 'invalid_email' }, 400);
        }
        if (!redirectTo) {
            return jsonResponse({ error: 'redirectTo is required to invite a student' }, 400);
        }
    }

    // Before any write, the auth user included: a refused teacher must not be
    // left with an account nothing points at.
    const gate = await checkRosterStock(admin, userId);
    if (!gate.ok) {
        return gate.response;
    }

    // Minted here because the roster id names the synthetic auth address on the
    // code path: the account and the row it belongs to share one identifier.
    const rosterId = crypto.randomUUID();
    const spec: NewStudent = { rosterId, displayName, parentEmail };

    return method === 'email'
        ? await createEmailStudent(admin, userId, { ...spec, studentEmail, redirectTo })
        : await createCodeStudent(admin, userId, spec);
};

/**
 * The one recovery path, for a forgotten password on either method — and the
 * only way back to Invited, since nothing else in this file writes claimed_at.
 *
 * On both paths the SCRAMBLE COMES FIRST, and that ordering is the point: it is
 * the actual revocation, so a reset that then fails halfway has already taken
 * the old password away. Everything after it is repairable by re-running.
 */
const resetStudentAccess = async (admin: SupabaseClient, userId: string, body: ProvisionBody): Promise<Response> => {
    const owned = await loadOwnedRoster(admin, userId, body.studentId);
    if (!owned.ok) {
        return owned.response;
    }
    const row = owned.row;

    if (row.auth_method === 'email') {
        if (!row.student_email) {
            console.error(`email-method student ${row.id} has no address to invite`);
            return jsonResponse({ error: 'Could not reset the student' }, 502);
        }
        const redirectTo = typeof body.redirectTo === 'string' ? body.redirectTo.trim() : '';
        if (!redirectTo) {
            return jsonResponse({ error: 'redirectTo is required to reset an invited student' }, 400);
        }

        const { error: scrambleError } = await admin.auth.admin.updateUserById(row.student_user_id, {
            password: generateProvisionPassword(),
        });
        if (scrambleError) {
            console.error(`could not revoke the password for student ${row.id}: ${scrambleError.message}`);
            return jsonResponse({ error: 'Could not reset the student' }, 502);
        }

        // The ANON client, not the service role: this is the same magic link a
        // teacher gets from the sign-in page, and shouldCreateUser keeps it from
        // conjuring an account if the address ever drifts from the roster row.
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
        if (!supabaseUrl || !anonKey) {
            return jsonResponse({ error: 'Server misconfigured' }, 500);
        }
        const anonClient = createClient(supabaseUrl, anonKey, {
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const { error: otpError } = await anonClient.auth.signInWithOtp({
            email: row.student_email,
            options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
        });
        if (otpError) {
            // Safe half-state: the old password is already dead, so the student is
            // locked out rather than left with a credential the teacher believes
            // they revoked. Running 'reset' again re-sends the mail. (An archived
            // student is banned, and GoTrue may refuse to mail one at all —
            // restore first, then reset.)
            console.error(`could not send the reset link for student ${row.id}: ${otpError.message}`);
            return jsonResponse({ error: 'Could not send the invitation' }, 502);
        }

        const { error: updateError } = await admin
            .from('managed_students')
            .update({ claimed_at: null })
            .eq('id', row.id);
        if (updateError) {
            // Cosmetic drift only — claimed_at is a setup-complete flag on this
            // path, not a gate — but reported rather than swallowed, and a rerun
            // repairs it.
            console.error(`claimed_at out of step for student ${row.id}: ${updateError.message}`);
            return jsonResponse({ error: 'Could not reset the student' }, 502);
        }

        return jsonResponse({ invited: true, studentEmail: row.student_email });
    }

    // The scramble is what revokes the password the student chose when they
    // claimed. Minting a code without it would leave the OLD password working
    // alongside the new card — a "reset" that resets nothing.
    const { error: scrambleError } = await admin.auth.admin.updateUserById(row.student_user_id, {
        password: generateProvisionPassword(),
    });
    if (scrambleError) {
        console.error(`could not revoke the password for student ${row.id}: ${scrambleError.message}`);
        return jsonResponse({ error: 'Could not reset the login code' }, 502);
    }

    const code = generateLoginCode();
    const loginCodeHash = await hashLoginCode(code);

    // Both columns in one statement, because the state CHECK admits no row that
    // carries only half of them. `username` is deliberately left alone: the claim
    // overwrites it, so whether to keep the old name is the student's choice and
    // not something a reset should make for them.
    //
    // Nothing here can land the scramble and this update atomically, and the old
    // code exists only as a hash, so a half-applied reset cannot be rolled back
    // either. It IS repairable — running 'reset' again rewrites both — which is
    // why a partial failure is reported loudly instead of handing back a code
    // that may not work.
    const { error: updateError } = await admin
        .from('managed_students')
        .update({ login_code_hash: loginCodeHash, claimed_at: null })
        .eq('id', row.id);
    if (updateError) {
        console.error(`login code hash out of step for student ${row.id}: ${updateError.message}`);
        return jsonResponse({ error: 'Could not reset the login code' }, 502);
    }

    // Resetting an archived student is allowed and changes nothing for them:
    // student-claim only matches unarchived rows, so the new code stays refused
    // until the row is restored. The username goes back so the teacher can tell
    // the student which name they are claiming into again.
    return jsonResponse({ loginCode: formatLoginCode(code), username: row.username });
};

const archiveStudent = async (admin: SupabaseClient, userId: string, body: ProvisionBody): Promise<Response> => {
    const owned = await loadOwnedRoster(admin, userId, body.studentId);
    if (!owned.ok) {
        return owned.response;
    }

    // Archiving frees the seat. It deletes NOTHING — assignments, annotations and
    // practice notes all stay — so a restored student gets their history back.
    const { error } = await admin
        .from('managed_students')
        .update({ archived_at: new Date().toISOString() })
        .eq('id', owned.row.id)
        .is('archived_at', null);
    if (error) {
        return jsonResponse({ error: 'Could not archive the student' }, 502);
    }

    // The stamp above only stops student-login. It is not a revocation on its
    // own: an active student holds a password they chose themselves, against an
    // address they either supplied (email method) or can derive from the roster
    // id they read off their own row (managed_students_select), so an expelled
    // student would sign straight back in at /auth/v1/token, never touching this
    // function's archived filter — and their already-open tab would never stop
    // working at all. Banning the account is what actually withdraws access.
    //
    // Run unconditionally rather than only when the update matched: a retry
    // after a half-applied archive has to be able to finish the job, and the
    // guarded update above no-ops on the second pass.
    const { error: banError } = await admin.auth.admin.updateUserById(owned.row.student_user_id, {
        ban_duration: ARCHIVE_BAN_DURATION,
    });
    if (banError) {
        // Loud, and NOT reported as success: the row says archived while the
        // account still signs in, which is exactly the state this guards against.
        console.error(`could not revoke access for archived student ${owned.row.id}: ${banError.message}`);
        return jsonResponse({ error: 'Could not archive the student' }, 502);
    }

    // Idempotent: an already-archived row matches no update, is already in the
    // state the caller asked for, and is re-banned harmlessly.
    return jsonResponse({ ok: true });
};

const restoreStudent = async (admin: SupabaseClient, userId: string, body: ProvisionBody): Promise<Response> => {
    const owned = await loadOwnedRoster(admin, userId, body.studentId);
    if (!owned.ok) {
        return owned.response;
    }

    // An active row already holds its seat, so there is nothing to re-occupy —
    // and running the stock check anyway would 402 a teacher who sits exactly at
    // their limit, for what is a no-op.
    if (owned.row.archived_at === null) {
        return jsonResponse({ ok: true });
    }

    // A restore claims a seat exactly as a create does. Without this, archive +
    // restore would launder the free tier's cap into an unlimited roster.
    const gate = await checkRosterStock(admin, userId);
    if (!gate.ok) {
        return gate.response;
    }

    // The ban comes off BEFORE the row comes back, so the two can only ever fail
    // in the safe direction: a failure here leaves the student archived and still
    // revoked, where the reverse would leave an active roster row whose account
    // is silently banned — a student refused for a reason no teacher could see.
    const { error: unbanError } = await admin.auth.admin.updateUserById(owned.row.student_user_id, {
        ban_duration: 'none',
    });
    if (unbanError) {
        console.error(`could not restore access for student ${owned.row.id}: ${unbanError.message}`);
        return jsonResponse({ error: 'Could not restore the student' }, 502);
    }

    const { error } = await admin.from('managed_students').update({ archived_at: null }).eq('id', owned.row.id);
    if (error) {
        return jsonResponse({ error: 'Could not restore the student' }, 502);
    }

    return jsonResponse({ ok: true });
};

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const rate = await checkRateLimit(`student-provision:${clientKey(req)}`, 20, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    const auth = await requireUser(req);
    if (!auth.ok) {
        return auth.response;
    }
    // A share-link guest has no plan of their own, and a provisioned student is
    // somebody else's roster row. Neither may provision: rejectAnonymous does not
    // catch a student, who is a registered non-anonymous user.
    const anonymous = rejectAnonymous(auth.caller);
    if (anonymous) {
        return anonymous;
    }
    const student = rejectStudent(auth.caller);
    if (student) {
        return student;
    }

    const admin = serviceClient();
    if (!admin) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    const body = await readBody(req);
    if (!body) {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const userId = auth.caller.userId;

    try {
        switch (body.action) {
            case 'create':
                return await createStudent(admin, userId, body);
            case 'reset':
                return await resetStudentAccess(admin, userId, body);
            case 'archive':
                return await archiveStudent(admin, userId, body);
            case 'restore':
                return await restoreStudent(admin, userId, body);
            default:
                return jsonResponse({ error: 'Unknown action' }, 400);
        }
    } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : 'Student provisioning failed' }, 502);
    }
});
