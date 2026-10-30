import { mapAuthError } from '@/features/auth/authErrors';
import { MANAGED_STUDENT_COLUMNS } from '@/features/roster/rosterService';
import { getSupabase, requireSupabaseConfig } from '@/lib/supabase';
import type { AssignmentRow, DocumentRow, ManagedStudentRow } from '@/types/database';

/**
 * The student side of the roster.
 *
 * Everything a signed-in student reads here is a plain RLS-scoped select — the
 * policies in the roster migration already answer "whose row is this?", so none
 * of these queries filter by user id themselves. The exceptions are the sign-in
 * and claim calls below, which by definition happen before there is a session to
 * scope by.
 */

/** Collapsed by the server on purpose; used when a response carries no message. */
const REJECTION = 'That username and password did not work';

const NETWORK_FAILURE = 'Could not reach Cleffy. Check the internet connection and try again.';

/**
 * An archived student signing in. student-login says it itself (ARCHIVED in
 * its handler, only to the right password); an email-method student meets
 * GoTrue's own `user_banned` instead — archiving is the only ban the app sets
 * — and is told the same thing.
 */
export const STUDENT_ARCHIVED_MESSAGE =
    "Your teacher has archived this account, so it can't sign in for now. Ask your teacher to restore it.";

/**
 * A refusal the server chose to name — 'invalid_credentials', 'username_taken',
 * and the rest of the documented set. The code exists so a page can put the
 * message where it belongs (under the username field, back on the code step)
 * WITHOUT re-deriving what went wrong from the prose, which would drift the
 * moment the copy is edited. A dead network is not one of these: it throws a
 * plain Error, because it says nothing about the credential that was typed.
 */
export class StudentAuthError extends Error {
    constructor(
        message: string,
        public readonly code: string,
    ) {
        super(message);
        this.name = 'StudentAuthError';
    }
}

interface StudentSessionBody {
    accessToken?: string;
    refreshToken?: string;
    displayName?: string;
    username?: string;
}

const rejectionFrom = async (response: Response): Promise<StudentAuthError> => {
    try {
        const body = (await response.json()) as { error?: string; code?: string };
        return new StudentAuthError(body.error || REJECTION, body.code ?? 'unknown');
    } catch {
        return new StudentAuthError(REJECTION, 'unknown');
    }
};

/**
 * Post to one of the two unauthenticated student functions and adopt the session
 * it hands back; resolves to the display name.
 *
 * Deliberately NOT callEdgeFunction: that helper requires an access token, and a
 * student signing in or claiming a card has none — student-login and
 * student-claim are deployed with verify_jwt = false precisely because the body
 * IS the credential. So this is a bare fetch carrying the anon apikey and
 * nothing else; sending an Authorization header would only invite the function
 * to trust a caller-supplied identity it must ignore.
 *
 * `captchaToken` travels in the body like every other field, under the name
 * supabase-js uses for it, and is forwarded by both functions to the password
 * grant they call server-side. It is null on every build with no
 * VITE_TURNSTILE_SITE_KEY — which is every build today — and both functions
 * leave the grant's `options` off entirely without one, so nothing about these
 * requests changes until the key is set. Nothing on this side verifies it:
 * GoTrue is the one that redeems it, and a Turnstile token may only be redeemed
 * once.
 *
 * Failures are not re-interpreted, only carried. Both functions answer with one
 * indistinguishable body per class of rejection so neither can become an oracle
 * for which usernames or codes exist, and second-guessing that on the client
 * would throw it away. The one thing worth telling apart is a request that never
 * reached the server at all — that is a dead network, not a bad credential, and
 * a child staring at a correct card deserves to be told which it is.
 */
const openStudentSession = async (fn: 'student-login' | 'student-claim', payload: object): Promise<string> => {
    const { url: projectUrl, anonKey } = requireSupabaseConfig();

    let response: Response;
    try {
        response = await fetch(`${projectUrl}/functions/v1/${fn}`, {
            method: 'POST',
            headers: {
                apikey: anonKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });
    } catch {
        throw new Error(NETWORK_FAILURE);
    }

    if (!response.ok) {
        throw await rejectionFrom(response);
    }

    const body = (await response.json()) as StudentSessionBody;
    if (!body.accessToken || !body.refreshToken) {
        throw new StudentAuthError(REJECTION, 'unknown');
    }

    // The function hands back a token pair rather than a cookie, so adopting the
    // session is the client's job — and until this resolves the student is still
    // signed out, which is why the caller must await it before navigating.
    const { error } = await getSupabase().auth.setSession({
        access_token: body.accessToken,
        refresh_token: body.refreshToken,
    });
    if (error) {
        throw new StudentAuthError(REJECTION, 'unknown');
    }

    return body.displayName ?? 'Student';
};

/**
 * Sign a student in from one field; resolves to the display name.
 *
 * The two paths a student can arrive on split HERE, on the shape of what they
 * typed, and they stay split all the way down. An email-method student is an
 * ordinary auth user with an ordinary password, so they go straight at GoTrue's
 * own sign-in — the same throttled endpoint every teacher login already uses,
 * which is also what makes /forgot-password work for them unchanged. The edge
 * function's careful oracle posture exists to protect the code/username space,
 * which an email login never touches; routing email sign-ins through it would
 * buy nothing and cost them password reset.
 *
 * An '@' is the whole test. Usernames cannot contain one (see USERNAME_RE in
 * supabase/functions/_shared/studentCodes.ts), so no username can be mistaken
 * for an address, and an address typed by a code student simply fails at GoTrue
 * exactly as a wrong password would.
 */
export const loginStudent = async (
    identifier: string,
    password: string,
    captchaToken?: string | null,
): Promise<string> => {
    if (identifier.includes('@')) {
        const { data, error } = await getSupabase().auth.signInWithPassword({
            email: identifier.trim(),
            password,
            ...(captchaToken ? { options: { captchaToken } } : {}),
        });
        if (error) {
            // GoTrue answers a banned account before it checks the password,
            // and says so in the response either way; the copy adds nothing
            // to what the endpoint already tells anyone who asks it.
            if (error.code === 'user_banned') {
                throw new StudentAuthError(STUDENT_ARCHIVED_MESSAGE, 'student_archived');
            }
            // The same refusal student-login gives a wrong username or
            // password, so the page answers both halves of the roster alike.
            if (error.code === 'invalid_credentials') {
                throw new StudentAuthError(mapAuthError(error, 'Could not sign in.'), 'invalid_credentials');
            }
            throw new Error(mapAuthError(error, 'Could not sign in.'));
        }
        const meta = data.session?.user.user_metadata as Record<string, unknown> | undefined;
        return typeof meta?.['display_name'] === 'string' ? (meta['display_name'] as string) : 'Student';
    }
    // Sent exactly as typed. The function normalizes case and surrounding space
    // itself, so reshaping it here could only ever turn a username that would
    // have worked into one that does not.
    return openStudentSession('student-login', { username: identifier, password, captchaToken });
};

/**
 * Spend a setup code on a username and password; resolves to the display name.
 *
 * The code is a one-time claim token, so this is the only call that ever sends
 * one — after it succeeds the student signs in through loginStudent like anyone
 * else, and the code is dead.
 */
export const claimStudentAccount = async (input: {
    code: string;
    username: string;
    password: string;
    captchaToken?: string | null;
}): Promise<string> => openStudentSession('student-claim', input);

/** One assigned score: the teacher's assignment plus the document it points at. */
export interface AssignedScore {
    assignment: AssignmentRow;
    document: DocumentRow;
}

/**
 * Every score assigned to the caller, newest first.
 *
 * Two queries rather than an embedded select: PostgREST resource embedding
 * needs a declared foreign-key relationship to traverse, and assignments is
 * typed here with `Relationships: []`. One `.in()` over the collected ids is
 * both simpler and still a single extra round trip however long the list is.
 */
export const fetchMyAssignments = async (): Promise<AssignedScore[]> => {
    const supabase = getSupabase();
    const { data: assignments, error } = await supabase
        .from('assignments')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) {
        throw new Error(`Could not load your pieces: ${error.message}`);
    }
    if (assignments.length === 0) {
        return [];
    }

    const documentIds = [...new Set(assignments.map((assignment) => assignment.document_id))];
    // Narrow columns — the student list only needs title + id for the card link.
    const { data: documents, error: documentsError } = await supabase
        .from('documents')
        .select(
            'id, owner_id, title, storage_path, page_count, content_rev, thumb_rev, created_at, updated_at, archived_at',
        )
        .in('id', documentIds);
    if (documentsError) {
        throw new Error(`Could not load your pieces: ${documentsError.message}`);
    }

    const documentsById = new Map((documents ?? []).map((doc) => [doc.id, doc]));
    // A missing document is a score the teacher deleted without unassigning it.
    // The row is stale, not an error: drop the pair rather than render a card
    // that leads nowhere.
    return assignments.flatMap((assignment) => {
        const doc = documentsById.get(assignment.document_id);
        return doc ? [{ assignment, document: doc }] : [];
    });
};

/**
 * The caller's own roster row — the teacher's spelling of their name, and the
 * teacher they belong to. Null when there is no row (an ordinary account, or a
 * student whose row was archived out from under a live session).
 *
 * `limit(1)` because maybeSingle() rejects on multiple rows, and a teacher
 * calling this would match their whole roster under the same policy.
 */
export const fetchMyRosterProfile = async (): Promise<ManagedStudentRow | null> => {
    const { data, error } = await getSupabase()
        .from('managed_students')
        .select(MANAGED_STUDENT_COLUMNS)
        .limit(1)
        .maybeSingle();
    if (error) {
        throw new Error(`Could not load your profile: ${error.message}`);
    }
    return data;
};

/**
 * Whether this sign-in still stands: false once the teacher archived the
 * student, reset their access, or deleted the account behind it.
 *
 * Asked of the server (student_access_revoked, migration 20261010120300)
 * because none of those signs the device out by itself: the access token stays
 * valid until it expires, and every read under it just comes back empty — which
 * would otherwise read as "Nothing here yet". `profile` is the roster row the
 * caller already fetched; an archived one answers without the round trip.
 *
 * Null when the server could not be asked: the page keeps showing what it has
 * rather than signing someone out over a dropped connection.
 */
export const fetchSignInStillValid = async (profile: ManagedStudentRow | null): Promise<boolean | null> => {
    if (profile?.archived_at) {
        return false;
    }
    const { data, error } = await getSupabase().rpc('student_access_revoked');
    if (error || typeof data !== 'boolean') {
        return null;
    }
    return !data;
};

/**
 * Whether the account behind an ended sign-in is gone altogether: deleted with
 * its teacher, as opposed to archived or reset (fetchSignInStillValid answers
 * false for all three). Asked once the sign-in is known to be over, to choose
 * between keeping what the device queued for the next sign-in and discarding
 * it: a deleted account has no next sign-in.
 *
 * True only when the server says so on both counts under this token: it is
 * refused as a student's (student_access_revoked, which reads true for a
 * student token whose roster row is gone), and no roster row answers to it.
 * Anything unanswered is false — keeping a deleted account's changes costs a
 * little storage, discarding a live one's would lose them.
 */
export const fetchAccountDeleted = async (): Promise<boolean> => {
    const [profile, revoked] = await Promise.allSettled([
        fetchMyRosterProfile(),
        (async () => {
            const { data, error } = await getSupabase().rpc('student_access_revoked');
            return !error && data === true;
        })(),
    ]);
    return profile.status === 'fulfilled' && profile.value === null && revoked.status === 'fulfilled' && revoked.value;
};
