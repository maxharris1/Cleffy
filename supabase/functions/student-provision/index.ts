import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { rejectAnonymous, rejectStudent, requireUser } from '../_shared/auth.ts';
import { readTeacherAttestation, type TeacherAttestation } from '../_shared/consentAge.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import {
    ACCOUNT_DELETION_PENDING,
    accountDeletionPending,
    DELETION_CHECK_UNAVAILABLE,
} from '../_shared/deletionPending.ts';
import {
    checkDistrictChoice,
    DISTRICT_DELETION_PENDING,
    type DistrictRpc,
    isDistrictDeletionPending,
} from '../_shared/districtProvision.ts';
import { logError } from '../_shared/errorReporting.ts';
import { isUnlimited, LIMIT_REACHED_STATUS, limitReachedBody, type Entitlements } from '../_shared/entitlements.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/imslp.ts';
import { forgetLoginAccount, STUDENT_LOGIN_SCOPE } from '../_shared/loginThrottle.ts';
import { supabaseQuotaBackend } from '../_shared/quota.ts';
import { mailLimit } from '../_shared/mailBudget.ts';
import { loginThrottleSecret, refundRateLimit } from '../_shared/rateLimit.ts';
import { CONTROL_BODY_MAX_BYTES, isJsonObject, PAYLOAD_TOO_LARGE, readCappedJson } from '../_shared/readCappedJson.ts';
import { reserveStudentAccountMail, studentMailRefusal } from '../_shared/studentAccountMail.ts';
import {
    type CodeResetPorts,
    definiteRefusal,
    MARKER_KEY,
    type ReserveResetAnswer,
    runCodeReset,
} from '../_shared/studentCodeReset.ts';
import { endStudentSessions, endStudentSessionsFenced } from '../_shared/studentSessions.ts';
import {
    formatLoginCode,
    generateLoginCode,
    generateProvisionPassword,
    hashLoginCode,
    syntheticStudentEmail,
} from '../_shared/studentCodes.ts';

/**
 * Teacher-side roster management: create / reset / archive / restore / delete.
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
 * anything else: the password is scrambled and every open session ended FIRST,
 * then the row goes back to Invited. A half-applied reset therefore always fails
 * safe — access is already gone — and re-running it repairs the rest.
 *
 * The roster is a STOCK, not a flow: `students` never reaches usage_counters, it
 * is the live count of unarchived rows, checked here where a seat is claimed.
 * That is why 'create' and 'restore' share one check and 'archive' needs none —
 * archiving is what gives a seat back.
 *
 * 'archive' and 'restore' each touch TWO things, because the roster row and the
 * auth account are two halves of one student: the row decides the seat, what
 * student-login will match and (through document_role()) whether a token the
 * student already holds still reaches anything, and the account's ban decides
 * whether the student's password still opens a session at all. Archiving only
 * the row would leave a student who knows their own password working directly
 * against /auth/v1/token — more true now than when the credential was a code,
 * not less.
 *
 * Sessions already open are ended too, on 'archive' and on 'reset'
 * (../_shared/studentSessions.ts): a ban or a new password only stops the next
 * sign-in, while a signed-in device would otherwise keep its access token for
 * up to an hour and, after a reset, its refresh token for good.
 *
 * AGE. A roster student never sees the age screen, so 'create' and 'restore'
 * each need the teacher's attestation — the student's country and a ticked
 * "at least N", N being consent_age() for that country
 * (../_shared/consentAge.ts). It is checked before anything is written,
 * stored on the roster row, logged in teacher_attestations
 * (20261021120100_teacher_attestations.sql), and carried into the account's
 * user_metadata as the same age_gate a self sign-up has, which is what the
 * before_user_created hook checks on the invite path.
 *
 * DISTRICT. A student belongs to a district only when 'create' names it
 * (`districtStudioId`) and the teacher owns or holds a seat in it
 * (../_shared/districtProvision.ts). Naming none provisions a private student,
 * seated teacher or not; the district's contract-end purge never touches one
 * (20261021120800_district_student_attribution.sql). A district whose purge
 * has begun takes no new students: 409 `district_deletion_pending`, from the
 * check before any write or from the roster insert's trigger
 * (20261022130300_district_retention_late_students.sql).
 *
 * 'delete' is for good: the student's markings are scrubbed (tombstoned, and
 * cut out of lesson-history snapshots — 20261021120200), then the auth user
 * goes, and its cascades take the roster row, assignments and practice notes.
 *
 * Nothing in this file consumes a metered budget. Students are never billed, and
 * a teacher's roster is paid for by occupancy rather than by activity. The one
 * thing counted is MAIL: an invitation or a reset link reserves its place in
 * the studentAccountMail share, per teacher and per address
 * (../_shared/studentAccountMail.ts), before GoTrue is asked to send it.
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
 * A ban is the revocation archiving needs beyond the archived_at stamp: it
 * refuses the password grant at /auth/v1/token AND every refresh. The stamp is
 * what refuses the access token a live session still holds (document_role()
 * reads it, migration 20261010120300), and ending the sessions is what tells
 * that session's open viewer.
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
    /**
     * On 'reset' only: the token a failed reset of this student handed back,
     * so the same reset resumes its own reservation instead of waiting it out.
     */
    resetToken?: unknown;
    /** On 'create' and 'restore': see readTeacherAttestation. */
    attestation?: unknown;
    /** On 'create' only: the district this student is provisioned for. Absent: a private student. */
    districtStudioId?: unknown;
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

/** The body, null when it is not a JSON object, or 'too_large' past the control cap. */
const readBody = async (req: Request): Promise<ProvisionBody | null | 'too_large'> => {
    const read = await readCappedJson(req, CONTROL_BODY_MAX_BYTES);
    if (!read.ok) {
        return read.status === 413 ? 'too_large' : null;
    }
    return isJsonObject(read.value) ? (read.value as ProvisionBody) : null;
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
    attestation: TeacherAttestation;
    /** Checked by checkDistrictChoice, and again by the roster table's trigger. */
    districtStudioId: string | null;
}

/** The account-side record of the attestation: the shape a self sign-up's age screen writes. */
const ageGateOf = (attestation: TeacherAttestation) => ({
    country: attestation.country,
    min_age: attestation.minAge,
    source: 'teacher',
    v: 1,
});

/** The roster row's copy of the attestation. */
const attestationColumns = (attestation: TeacherAttestation) => ({
    country: attestation.country,
    age_attested_at: new Date().toISOString(),
    age_attested_min_age: attestation.minAge,
});

/** The history row: who vouched for which student, with which words, when. */
const recordAttestation = async (
    admin: SupabaseClient,
    teacherId: string,
    managedStudentId: string,
    action: 'create' | 'restore',
    attestation: TeacherAttestation,
): Promise<boolean> => {
    const { error } = await admin.from('teacher_attestations').insert({
        teacher_id: teacherId,
        managed_student_id: managedStudentId,
        action,
        country: attestation.country,
        min_age: attestation.minAge,
        wording: attestation.wording,
        wording_version: attestation.version,
    });
    if (error) {
        console.error(`could not record the age attestation for student ${managedStudentId}: ${error.message}`);
        return false;
    }
    return true;
};

/** A refusal from readTeacherAttestation, as the response the form shows. */
const attestationRefusal = (body: ProvisionBody): { attestation: TeacherAttestation } | { response: Response } => {
    const checked = readTeacherAttestation(body.attestation);
    return checked.ok
        ? { attestation: checked.attestation }
        : { response: jsonResponse({ error: checked.error, code: checked.code }, checked.status) };
};

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
 * The teacher's own account is being deleted (20261022110100_account_deletion_pending.sql):
 * the database refuses a new roster row for it, and a student created now would
 * outlive their teacher with nobody to manage them.
 */
const DELETION_PENDING = {
    error: 'This account is being deleted, so no new students can be added.',
    code: 'account_deletion_pending',
} as const;

/**
 * What a reset that failed part-way tells the teacher (decision 49 item 5). The
 * roster UI shows the same words for code 'reset_incomplete'.
 */
const RESET_INCOMPLETE_MESSAGE =
    'The reset did not finish. The student’s current card is held for up to 10 minutes, so it cannot be used meanwhile. Try the reset again.';

/**
 * The same, when the password write may still land (20261022110800): a retry
 * waits for it (decision 60(a)). The roster UI shows these words for code
 * 'reset_unconfirmed'.
 */
const RESET_UNCONFIRMED_MESSAGE =
    'The reset did not finish, and we could not confirm whether the student’s password was changed. Their current card is held for up to 10 minutes. Try the reset again in a few minutes.';

/**
 * account_deletion_pending() for the teacher, as the dispatcher asks it: null
 * when clear, else the refusal (409 while pending; 503 when it cannot be
 * answered, decision 60(b)). Asked again right before the Auth writes that give
 * a student access back -- a reset's scramble, a restore's unban -- since the
 * dispatcher's answer can be stale by then (decision 61). Revocations (an
 * archive's ban) and the creation path (whose intent the deletion sees, and
 * whose student flag must land so it can) are not re-asked.
 */
const deletionRefusal = async (admin: SupabaseClient, userId: string): Promise<Response | null> => {
    const pending = await accountDeletionPending(admin, userId);
    if (!pending.ok) {
        console.error(`could not check whether ${userId} is being deleted: ${pending.message}`);
        return jsonResponse(DELETION_CHECK_UNAVAILABLE, 503);
    }
    return pending.pending ? jsonResponse(ACCOUNT_DELETION_PENDING, 409) : null;
};

/** Whether an insert was refused by the deletion-pending trigger. */
const isDeletionPending = (error: { code?: string; message?: string } | null): boolean =>
    error?.code === '55000' && /account_deletion_pending/.test(error.message ?? '');

/**
 * One invitation or reset link's place in the student-mail budget
 * (_shared/studentAccountMail.ts), reserved before GoTrue is asked to send it.
 */
const reserveStudentMail = (teacherId: string, recipient: string) =>
    reserveStudentAccountMail(
        {
            checkRateLimit,
            refundRateLimit,
            projectLimits: {
                hour: mailLimit('studentAccountMail', 'hour', (name) => Deno.env.get(name)),
                day: mailLimit('studentAccountMail', 'day', (name) => Deno.env.get(name)),
            },
        },
        teacherId,
        recipient,
    );

/**
 * The provisioning ended with nothing left behind: its intent
 * (20261022110600_account_deletion_barrier.sql) goes. Best effort: an intent
 * left over is only a record a deletion or a person checks and drops.
 */
const finishProvision = async (admin: SupabaseClient, rosterId: string): Promise<void> => {
    const { error } = await admin.rpc('finish_student_provision', { p_roster_id: rosterId });
    if (error) {
        console.error(`could not clear provisioning intent ${rosterId}: ${error.message}`);
    }
};

/**
 * Records the Auth account a provisioning just created on its intent, so a
 * crash from here on leaves a row naming it. 'gone' when the intent was swept
 * (the teacher's deletion began): the caller undoes the account.
 */
const attachProvision = async (
    admin: SupabaseClient,
    rosterId: string,
    studentUserId: string,
): Promise<'ok' | 'gone' | 'error'> => {
    const { data, error } = await admin.rpc('attach_student_provision', {
        p_roster_id: rosterId,
        p_student_user: studentUserId,
    });
    if (error) {
        console.error(`could not record the account of provisioning ${rosterId}: ${error.message}`);
        return 'error';
    }
    return data === true ? 'ok' : 'gone';
};

/**
 * Deletes an account create just made; its roster row, if any, goes with it by
 * cascade. Once it is gone the provisioning's intent goes too; if it cannot be
 * deleted the intent stays, naming the orphan.
 */
const undoCreatedStudent = async (admin: SupabaseClient, studentUserId: string, rosterId: string): Promise<void> => {
    const { error } = await admin.auth.admin.deleteUser(studentUserId);
    if (error) {
        logError('student-provision', error, { code: 'orphaned_auth_user' });
        return;
    }
    await finishProvision(admin, rosterId);
};

/**
 * The zero-email path. The account gets a scramble for a password —
 * generateProvisionPassword, generated, set and forgotten — so the printed code
 * is a claim token and nothing else: it selects this row once, in student-claim,
 * and until it does no sign-in path to the account exists for anyone.
 */
const createCodeStudent = async (admin: SupabaseClient, userId: string, spec: NewStudent): Promise<Response> => {
    const { rosterId, displayName, parentEmail, attestation, districtStudioId } = spec;
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
        // The admin API's createUser skips the before_user_created hook, so this
        // is a record rather than a gate: the gate was readTeacherAttestation.
        user_metadata: { display_name: displayName, age_gate: ageGateOf(attestation) },
    });
    if (createError || !created.user) {
        // Logged rather than returned: an auth error can name the synthetic
        // address, which is an implementation detail even the teacher never sees.
        // The intent stays: if GoTrue did create the account, a deletion finds
        // it by its address.
        console.error(`student account creation failed for ${userId}: ${createError?.message ?? 'no user returned'}`);
        return jsonResponse({ error: 'Could not create the student account' }, 502);
    }

    const attached = await attachProvision(admin, rosterId, created.user.id);
    if (attached !== 'ok') {
        await undoCreatedStudent(admin, created.user.id, rosterId);
        return attached === 'gone'
            ? jsonResponse(DELETION_PENDING, 409)
            : jsonResponse({ error: 'Could not create the student account' }, 502);
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
        district_studio_id: districtStudioId,
        ...attestationColumns(attestation),
    });
    if (insertError) {
        // An auth user with no roster row is unreachable forever: no teacher can
        // see it, no reset can reach it, and it holds the unique
        // student_user_id against a later re-provision. Undo it.
        const { error: cleanupError } = await admin.auth.admin.deleteUser(created.user.id);
        if (cleanupError) {
            logError('student-provision', cleanupError, { code: 'orphaned_auth_user', studentUserId: created.user.id });
        } else {
            await finishProvision(admin, rosterId);
        }
        return isDeletionPending(insertError)
            ? jsonResponse(DELETION_PENDING, 409)
            : isDistrictDeletionPending(insertError)
              ? jsonResponse(DISTRICT_DELETION_PENDING, 409)
              : jsonResponse({ error: 'Could not create the student roster row' }, 502);
    }

    // A student whose attestation went unrecorded is undone like a missing
    // roster row: the record is the point of asking.
    if (!(await recordAttestation(admin, userId, rosterId, 'create', attestation))) {
        await undoCreatedStudent(admin, created.user.id, rosterId);
        return jsonResponse({ error: 'Could not record the age confirmation' }, 502);
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
    const { rosterId, displayName, parentEmail, studentEmail, redirectTo, attestation, districtStudioId } = spec;

    // The invitation's place in the mail budget, before GoTrue sends it.
    const mail = await reserveStudentMail(userId, studentEmail);
    if (!mail.ok) {
        await finishProvision(admin, rosterId);
        return jsonResponse(studentMailRefusal(mail), 429);
    }

    // The invite DOES pass through the before_user_created hook, which refuses
    // a user without a passing age_gate — the teacher's, here.
    const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(studentEmail, {
        data: { display_name: displayName, age_gate: ageGateOf(attestation) },
        redirectTo,
    });
    if (inviteError || !invited.user) {
        // The one auth failure worth naming: it is the teacher's own typo or a
        // student who already has a Cleffy account, and both are fixed in the
        // form rather than by retrying.
        if (inviteError && isEmailInUse(inviteError)) {
            // GoTrue refused before sending anything (or creating an account):
            // the place goes back, and so does the intent.
            await mail.release();
            await finishProvision(admin, rosterId);
            return jsonResponse(
                { error: 'That email address already has a Cleffy account', code: 'email_in_use' },
                409,
            );
        }
        console.error(`student invite failed for ${userId}: ${inviteError?.message ?? 'no user returned'}`);
        return jsonResponse({ error: 'Could not send the invitation' }, 502);
    }

    const attached = await attachProvision(admin, rosterId, invited.user.id);
    if (attached !== 'ok') {
        await undoCreatedStudent(admin, invited.user.id, rosterId);
        return attached === 'gone'
            ? jsonResponse(DELETION_PENDING, 409)
            : jsonResponse({ error: 'Could not create the student account' }, 502);
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
            logError('student-provision', cleanupError, { code: 'unflagged_student', studentUserId: invited.user.id });
        } else {
            await finishProvision(admin, rosterId);
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
        district_studio_id: districtStudioId,
        ...attestationColumns(attestation),
    });
    if (insertError) {
        const { error: cleanupError } = await admin.auth.admin.deleteUser(invited.user.id);
        if (cleanupError) {
            logError('student-provision', cleanupError, { code: 'orphaned_auth_user', studentUserId: invited.user.id });
        } else {
            await finishProvision(admin, rosterId);
        }
        return isDeletionPending(insertError)
            ? jsonResponse(DELETION_PENDING, 409)
            : isDistrictDeletionPending(insertError)
              ? jsonResponse(DISTRICT_DELETION_PENDING, 409)
              : jsonResponse({ error: 'Could not create the student roster row' }, 502);
    }

    if (!(await recordAttestation(admin, userId, rosterId, 'create', attestation))) {
        await undoCreatedStudent(admin, invited.user.id, rosterId);
        return jsonResponse({ error: 'Could not record the age confirmation' }, 502);
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

    const checked = attestationRefusal(body);
    if ('response' in checked) {
        return checked.response;
    }

    // Before any write too: a district the teacher is not in is refused here,
    // not by the trigger after an account exists.
    const district = await checkDistrictChoice(admin as unknown as DistrictRpc, userId, body.districtStudioId);
    if (!district.ok) {
        return jsonResponse({ error: district.error, code: district.code }, district.status);
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
    const spec: NewStudent = {
        rosterId,
        displayName,
        parentEmail,
        attestation: checked.attestation,
        districtStudioId: district.districtStudioId,
    };

    // The intent, durably, BEFORE any Auth account exists
    // (20261022110600_account_deletion_barrier.sql). Refused while the
    // teacher's account is being deleted, so no student can be created that the
    // deletion would not see; and a request that dies after the account is made
    // leaves this row naming it, for the deletion (or a person) to clean up.
    // The roster row clears it, by trigger, in the same transaction.
    const { data: begun, error: beginError } = await admin.rpc('begin_student_provision', {
        p_teacher: userId,
        p_roster_id: rosterId,
        p_auth_email: method === 'email' ? studentEmail : syntheticStudentEmail(rosterId),
    });
    if (beginError) {
        console.error(`could not register the provisioning for ${userId}: ${beginError.message}`);
        return jsonResponse({ error: 'Could not create the student account' }, 502);
    }
    if (begun !== 'ok') {
        return jsonResponse(DELETION_PENDING, 409);
    }

    return method === 'email'
        ? await createEmailStudent(admin, userId, { ...spec, studentEmail, redirectTo })
        : await createCodeStudent(admin, userId, spec);
};

/** The code reset's database and Auth calls (../_shared/studentCodeReset.ts). */
const codeResetPorts = (admin: SupabaseClient, userId: string): CodeResetPorts => ({
    reserveReset: async (studentId, resumeToken) => {
        const { data, error } = await admin.rpc('reserve_student_code_reset', {
            p_student: studentId,
            p_reservation: resumeToken,
        });
        if (error) {
            throw new Error(error.message);
        }
        return data && typeof data === 'object' ? (data as ReserveResetAnswer) : null;
    },
    fence: async (studentId, lease) => {
        const { data, error } = await admin.rpc('fence_student_code_reset', {
            p_student: studentId,
            p_reservation: lease.reservation,
            p_worker: lease.worker,
            p_epoch: lease.epoch,
        });
        if (error) {
            throw new Error(error.message);
        }
        return data === 'ok' ? 'ok' : 'lost';
    },
    deletionPending: async () => {
        const pending = await accountDeletionPending(admin, userId);
        if (!pending.ok) {
            console.error(`could not check whether ${userId} is being deleted: ${pending.message}`);
            return 'unknown';
        }
        return pending.pending ? 'pending' : 'clear';
    },
    // The marker rides in the same Auth update as the password (one GoTrue
    // transaction; app_metadata keys merge), so seeing it means the write landed.
    scramblePassword: async (studentUserId, lease) => {
        const { error } = await admin.auth.admin.updateUserById(studentUserId, {
            password: generateProvisionPassword(),
            app_metadata: { [MARKER_KEY]: lease.worker },
        });
        return error
            ? { ok: false, message: error.message, definite: definiteRefusal((error as { status?: unknown }).status) }
            : { ok: true };
    },
    passwordWriteLanded: async (studentUserId, worker) => {
        const { data, error } = await admin.auth.admin.getUserById(studentUserId);
        if (error || !data.user) {
            throw new Error(error?.message ?? 'no user returned');
        }
        return data.user.app_metadata?.[MARKER_KEY] === worker;
    },
    endSessions: async (studentId, lease) => {
        const ended = await endStudentSessionsFenced(admin, studentId, lease);
        return ended === 'lost' ? 'lost' : ended.ok ? { ok: true } : ended;
    },
    mintCode: async () => {
        const code = generateLoginCode();
        return { code, hash: await hashLoginCode(code) };
    },
    complete: async (studentId, lease, codeHash) => {
        const { data, error } = await admin.rpc('complete_student_code_reset', {
            p_student: studentId,
            p_reservation: lease.reservation,
            p_worker: lease.worker,
            p_epoch: lease.epoch,
            p_code_hash: codeHash,
        });
        if (error) {
            throw new Error(error.message);
        }
        return data === 'reset' ? 'reset' : 'lost';
    },
    stopWorker: async (studentId, lease) => {
        const { error } = await admin.rpc('stop_student_code_reset_worker', {
            p_student: studentId,
            p_reservation: lease.reservation,
            p_worker: lease.worker,
            p_epoch: lease.epoch,
        });
        if (error) {
            throw new Error(error.message);
        }
    },
    log: (message) => console.error(message),
});

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

        // The link's place in the mail budget, BEFORE anything is revoked: a
        // spent budget must not leave the student locked out and waiting for a
        // link that never goes.
        const mail = await reserveStudentMail(userId, row.student_email);
        if (!mail.ok) {
            return jsonResponse(studentMailRefusal(mail), 429);
        }

        // Asked again right before the scramble; nothing was sent, so the
        // link's place goes back on a refusal.
        const refused = await deletionRefusal(admin, userId);
        if (refused) {
            await mail.release();
            return refused;
        }

        const { error: scrambleError } = await admin.auth.admin.updateUserById(row.student_user_id, {
            password: generateProvisionPassword(),
        });
        if (scrambleError) {
            console.error(`could not revoke the password for student ${row.id}: ${scrambleError.message}`);
            // Nothing was sent: the link's place goes back.
            await mail.release();
            return jsonResponse({ error: 'Could not reset the student' }, 502);
        }

        // Part of the revocation, so before anything is sent: the old password
        // is dead, and so is every device still signed in with it.
        const ended = await endStudentSessions(admin, row.student_user_id);
        if (!ended.ok) {
            console.error(`could not end the sessions of student ${row.id}: ${ended.message}`);
            await mail.release();
            return jsonResponse({ error: 'Could not reset the student' }, 502);
        }

        // The ANON client, not the service role: this is the same magic link a
        // teacher gets from the sign-in page, and shouldCreateUser keeps it from
        // conjuring an account if the address ever drifts from the roster row.
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
        if (!supabaseUrl || !anonKey) {
            await mail.release();
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

    // Reserve the row before anything is revoked
    // (20261022110000_student_claim_reservation.sql). A claim in flight on the
    // current card is about to set its own password; scrambling first would let
    // that write land after ours and survive the reset. So a reset during a
    // claim waits for it, and a claim during this reset waits for us. The
    // reservation carries a resume token (20261022110500), and every attempt
    // takes its own worker lease and is fenced before each Auth side effect
    // (20261022110700_student_code_reset_worker.sql, ../_shared/studentCodeReset.ts),
    // so two retries of one token can never both write the password.
    //
    // The scramble is what revokes the password the student chose when they
    // claimed, and ending the sessions is the other half: a device already
    // signed in would otherwise keep refreshing its way past the reset. Both
    // come before the new code exists, so a failure hands back no card that
    // would suggest the reset took. Nothing can land them and the code
    // atomically, and the old code exists only as a hash, so a half-applied
    // reset cannot be rolled back; it IS repairable -- the token resumes it --
    // which is why a partial failure is reported loudly. `username` is left
    // alone: the claim overwrites it, so keeping the old name is the student's
    // choice.
    const resumeToken = typeof body.resetToken === 'string' && uuidRe.test(body.resetToken) ? body.resetToken : null;
    const outcome = await runCodeReset(codeResetPorts(admin, userId), {
        studentId: row.id,
        studentUserId: row.student_user_id,
        resumeToken,
    });
    switch (outcome.kind) {
        case 'not_found':
            return jsonResponse({ error: 'Student not found' }, 404);
        case 'unavailable':
            return jsonResponse({ error: 'Could not reset the login code' }, 502);
        case 'busy':
            return outcome.holder === 'reset'
                ? jsonResponse(
                      {
                          error: 'Another reset of this student is still finishing. Try again in a few minutes.',
                          code: 'reset_in_progress',
                      },
                      409,
                  )
                : jsonResponse(
                      {
                          error: 'This student is setting up their account with their current card right now. Try again in a few minutes.',
                          code: 'claim_in_progress',
                      },
                      409,
                  );
        case 'incomplete':
            // The hold stays (up to 10 minutes); the token lets this teacher's
            // retry resume it at once.
            return jsonResponse(
                { error: RESET_INCOMPLETE_MESSAGE, code: 'reset_incomplete', resetToken: outcome.resetToken },
                502,
            );
        case 'unconfirmed':
            // Quarantined (20261022110800): the password write may still land,
            // so the hold stays and a retry waits until it is confirmed or the
            // hold runs out. The token is what lets that retry confirm it.
            return jsonResponse(
                { error: RESET_UNCONFIRMED_MESSAGE, code: 'reset_unconfirmed', resetToken: outcome.resetToken },
                502,
            );
        case 'deletion_pending':
            return jsonResponse(ACCOUNT_DELETION_PENDING, 409);
        case 'deletion_unknown':
            return jsonResponse({ ...DELETION_CHECK_UNAVAILABLE, resetToken: outcome.resetToken }, 503);
        case 'lost':
            // A newer try of this reset, or the student's claim, stands; this
            // one stopped before touching anything it no longer owned.
            return jsonResponse(
                { error: 'This reset was overtaken by a newer one. Try the reset again.', code: 'reset_lost' },
                409,
            );
    }
    const code = outcome.code;

    // The teacher's reset is the way back for a student someone has been
    // locking out by hammering their username, so it lifts student-login's
    // limits on that name too (the claim does again, for whichever name the
    // student ends up with). Best effort: the reset itself has happened, and a
    // failure here only means the lock runs out on its own.
    if (row.username) {
        await forgetLoginAccount(admin, loginThrottleSecret(), STUDENT_LOGIN_SCOPE, row.username);
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

    // Reported, not fatal. By now the stamp refuses every token the student
    // holds and the ban refuses every refresh, so access is already gone; what
    // this adds is the tidy end of those sessions and the ping that makes an
    // open viewer notice now rather than on its next write.
    const ended = await endStudentSessions(admin, owned.row.student_user_id);
    if (!ended.ok) {
        logError('student-provision', new Error(ended.message), {
            code: 'archive_sessions_not_ended',
            studentUserId: owned.row.student_user_id,
        });
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

    // Asked again on every restore: the teacher is vouching for the student as
    // they are now, and rows archived before attestations existed have none.
    const checked = attestationRefusal(body);
    if ('response' in checked) {
        return checked.response;
    }

    // A restore claims a seat exactly as a create does. Without this, archive +
    // restore would launder the free tier's cap into an unlimited roster.
    const gate = await checkRosterStock(admin, userId);
    if (!gate.ok) {
        return gate.response;
    }

    // Recorded before anything changes, so a restore never happens unrecorded.
    if (!(await recordAttestation(admin, userId, owned.row.id, 'restore', checked.attestation))) {
        return jsonResponse({ error: 'Could not record the age confirmation' }, 502);
    }

    // Asked again right before the unban, which gives the student access back.
    const refused = await deletionRefusal(admin, userId);
    if (refused) {
        return refused;
    }

    // The ban comes off BEFORE the row comes back, so the two can only ever fail
    // in the safe direction: a failure here leaves the student archived and still
    // revoked, where the reverse would leave an active roster row whose account
    // is silently banned — a student refused for a reason no teacher could see.
    //
    // The account carries the restore's attestation as its age_gate, the same
    // shape create writes, so the account side never keeps a stale (or, for a
    // student provisioned before attestations, missing) one. GoTrue merges
    // user_metadata keys, so display_name is untouched.
    const { error: unbanError } = await admin.auth.admin.updateUserById(owned.row.student_user_id, {
        ban_duration: 'none',
        user_metadata: { age_gate: ageGateOf(checked.attestation) },
    });
    if (unbanError) {
        console.error(`could not restore access for student ${owned.row.id}: ${unbanError.message}`);
        return jsonResponse({ error: 'Could not restore the student' }, 502);
    }

    // Still archived, or nothing: the 12-month purge (20261021120500) locks the
    // row it is about to delete, so a restore racing it either lands first (and
    // the purge's re-check skips the student) or waits and then matches no row.
    // That second case is reported, not answered ok for a student who is gone.
    const { data: restored, error } = await admin
        .from('managed_students')
        .update({ archived_at: null, ...attestationColumns(checked.attestation) })
        .eq('id', owned.row.id)
        .not('archived_at', 'is', null)
        .select('id');
    if (error) {
        return jsonResponse({ error: 'Could not restore the student' }, 502);
    }
    if (!restored?.length) {
        const { data: still } = await admin.from('managed_students').select('id').eq('id', owned.row.id).maybeSingle();
        if (!still) {
            return jsonResponse({ error: 'Student not found' }, 404);
        }
    }

    return jsonResponse({ ok: true });
};

/**
 * Deletes a student for good: their markings first, then the account.
 *
 * The scrub comes FIRST because the account is what names the marks. Once the
 * auth user is gone, annotations.created_by is cleared by its ON DELETE SET
 * NULL (20261007120600) and nothing could tell this student's marks from
 * anyone else's.
 *
 * revoke_and_scrub_student (20261021120400) archives the row, ends the
 * student's sessions and scrubs their markings in ONE transaction, holding the
 * roster row's lock that every student write also takes. A mark drawn while
 * it runs is either committed before it and scrubbed, or refused after it; one
 * drawn between a scrub and a later revocation can no longer slip through and
 * lose its author when the account goes. A failure after it leaves a student
 * who is archived, signed out and without markings, whose account still
 * exists — a retry finishes it, and the second scrub is a no-op.
 *
 * Allowed on any plan, active or archived, like archive: it hands a seat
 * back rather than claiming one.
 */
const deleteStudent = async (admin: SupabaseClient, userId: string, body: ProvisionBody): Promise<Response> => {
    const owned = await loadOwnedRoster(admin, userId, body.studentId);
    if (!owned.ok) {
        return owned.response;
    }
    const row = owned.row;

    const { data: scrubbed, error: scrubError } = await admin.rpc('revoke_and_scrub_student', {
        p_student: row.student_user_id,
    });
    if (scrubError) {
        console.error(`could not revoke and scrub student ${row.id}: ${scrubError.message}`);
        return jsonResponse({ error: 'Could not delete the student' }, 502);
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(row.student_user_id);
    if (deleteError && deleteError.status !== 404) {
        console.error(`could not delete the account of student ${row.id}: ${deleteError.message}`);
        return jsonResponse({ error: 'Could not delete the student' }, 502);
    }

    // The cascade normally took it; this covers an account that was already gone.
    const { error: rowError } = await admin.from('managed_students').delete().eq('id', row.id);
    if (rowError) {
        console.error(`could not remove the roster row of student ${row.id}: ${rowError.message}`);
        return jsonResponse({ error: 'Could not delete the student' }, 502);
    }

    if (row.username) {
        await forgetLoginAccount(admin, loginThrottleSecret(), STUDENT_LOGIN_SCOPE, row.username);
    }

    return jsonResponse({ ok: true, scrubbed });
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
    if (body === 'too_large') {
        return jsonResponse(PAYLOAD_TOO_LARGE, 413);
    }
    if (!body) {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const userId = auth.caller.userId;

    // Nothing in a roster changes while its teacher's account is being deleted
    // (../_shared/deletionPending.ts): every action here writes with the service
    // role, much of it to Auth, where no database trigger can refuse it.
    const pending = await accountDeletionPending(admin, userId);
    if (!pending.ok) {
        console.error(`could not check whether ${userId} is being deleted: ${pending.message}`);
        return jsonResponse(DELETION_CHECK_UNAVAILABLE, 503);
    }
    if (pending.pending) {
        return jsonResponse(ACCOUNT_DELETION_PENDING, 409);
    }

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
            case 'delete':
                return await deleteStudent(admin, userId, body);
            default:
                return jsonResponse({ error: 'Unknown action' }, 400);
        }
    } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : 'Student provisioning failed' }, 502);
    }
});
