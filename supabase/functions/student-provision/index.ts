import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { rejectAnonymous, rejectStudent, requireUser } from '../_shared/auth.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { isUnlimited, LIMIT_REACHED_STATUS, limitReachedBody, type Entitlements } from '../_shared/entitlements.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/imslp.ts';
import { supabaseQuotaBackend } from '../_shared/quota.ts';
import { formatLoginCode, generateLoginCode, hashLoginCode, syntheticStudentEmail } from '../_shared/studentCodes.ts';

/**
 * Teacher-side roster management: create / rotate / archive / restore.
 *
 * Provisioning a student means creating a real auth user, which no client may
 * do, so every write here runs under the service role — managed_students has no
 * client write policy at all, by design (see 20260826194426_roster.sql).
 *
 * The roster is a STOCK, not a flow: `students` never reaches usage_counters, it
 * is the live count of unarchived rows, checked here where a seat is claimed.
 * That is why 'create' and 'restore' share one check and 'archive' needs none —
 * archiving is what gives a seat back.
 *
 * 'archive' and 'restore' each touch TWO things, because the roster row and the
 * auth account are two halves of one student: the row decides the seat and what
 * student-login will match, and the account's ban decides whether the code still
 * opens a session at all. Archiving only the row would leave the printed code
 * working directly against /auth/v1/token.
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
    displayName?: string;
    parentEmail?: string;
    studentId?: string;
}

interface RosterRow {
    id: string;
    student_user_id: string;
    archived_at: string | null;
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
        .select('id, student_user_id, archived_at')
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

const createStudent = async (admin: SupabaseClient, userId: string, body: ProvisionBody): Promise<Response> => {
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName || displayName.length > MAX_DISPLAY_NAME) {
        return jsonResponse({ error: `displayName must be 1-${MAX_DISPLAY_NAME} characters` }, 400);
    }

    // Optional, and never the student's own address: no email is ever collected
    // from a provisioned student. This one is the parent's, for the teacher's
    // records and for sending the printed code home.
    const parentEmailInput = typeof body.parentEmail === 'string' ? body.parentEmail.trim() : '';
    if (parentEmailInput && !emailRe.test(parentEmailInput)) {
        return jsonResponse({ error: 'parentEmail must be an email address' }, 400);
    }
    const parentEmail = parentEmailInput || null;

    // Before any write, the auth user included: a refused teacher must not be
    // left with an account nothing points at.
    const gate = await checkRosterStock(admin, userId);
    if (!gate.ok) {
        return gate.response;
    }

    // Minted here because the roster id names the synthetic auth address: the
    // account and the row it belongs to share one identifier.
    const rosterId = crypto.randomUUID();
    const code = generateLoginCode();
    // Generated codes are already in normalized form, which is exactly what
    // student-login hashes after normalizeLoginCode() on what the student typed.
    const loginCodeHash = await hashLoginCode(code);

    const { data: created, error: createError } = await admin.auth.admin.createUser({
        email: syntheticStudentEmail(rosterId),
        // The code IS the password. student-login signs in with the normalized
        // code against this same address; nothing else is ever issued.
        password: code,
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
        login_code_hash: loginCodeHash,
        parent_email: parentEmail,
    });
    if (insertError) {
        // An auth user with no roster row is unreachable forever: no teacher can
        // see it, no rotate can reach it, and it holds the unique
        // student_user_id against a later re-provision. Undo it.
        const { error: cleanupError } = await admin.auth.admin.deleteUser(created.user.id);
        if (cleanupError) {
            console.error(`orphaned student auth user ${created.user.id}: ${cleanupError.message}`);
        }
        return jsonResponse({ error: 'Could not create the student roster row' }, 502);
    }

    // The one and only time this code is readable. managed_students keeps the
    // SHA-256 of it and Supabase keeps the password hash — neither can be read
    // back, so a lost code is replaced by 'rotate', never recovered.
    return jsonResponse({
        student: { id: rosterId, studentUserId: created.user.id, displayName },
        loginCode: formatLoginCode(code),
    });
};

const rotateLoginCode = async (admin: SupabaseClient, userId: string, body: ProvisionBody): Promise<Response> => {
    const owned = await loadOwnedRoster(admin, userId, body.studentId);
    if (!owned.ok) {
        return owned.response;
    }

    const code = generateLoginCode();
    const loginCodeHash = await hashLoginCode(code);

    // The code is two facts that have to agree: the password of the synthetic
    // user, and the hash that selects the roster row. Nothing here can land both
    // atomically, and the old code exists only as a hash, so a half-applied
    // rotation cannot be rolled back either. It IS repairable — running 'rotate'
    // again rewrites both — which is why a partial failure is reported loudly
    // instead of handing back a code that may not work.
    const { error: passwordError } = await admin.auth.admin.updateUserById(owned.row.student_user_id, {
        password: code,
    });
    if (passwordError) {
        console.error(`could not rotate the password for student ${owned.row.id}: ${passwordError.message}`);
        return jsonResponse({ error: 'Could not rotate the login code' }, 502);
    }

    const { error: updateError } = await admin
        .from('managed_students')
        .update({ login_code_hash: loginCodeHash })
        .eq('id', owned.row.id);
    if (updateError) {
        console.error(`login code hash out of step for student ${owned.row.id}: ${updateError.message}`);
        return jsonResponse({ error: 'Could not rotate the login code' }, 502);
    }

    // Rotating an archived student is allowed and changes nothing for them:
    // student-login only matches unarchived rows, so the code stays refused
    // until the row is restored.
    return jsonResponse({ loginCode: formatLoginCode(code) });
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
    // own: the code on the card is still the account's Supabase password, and
    // the synthetic address is a pure function of the roster id the student can
    // read from their own row (managed_students_select), so an expelled student
    // would sign straight back in at /auth/v1/token, never touching this
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
            case 'rotate':
                return await rotateLoginCode(admin, userId, body);
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
