import { getSupabase } from '@/lib/supabase';
import type { AssignmentRow, DocumentRow, ManagedStudentRow } from '@/types/database';

/**
 * The student side of the roster.
 *
 * Everything a signed-in student reads here is a plain RLS-scoped select — the
 * policies in the roster migration already answer "whose row is this?", so none
 * of these queries filter by user id themselves. The one exception is the login
 * below, which by definition happens before there is a session to scope by.
 */

/** Collapsed by the server on purpose; used when a response carries no message. */
const REJECTION = 'That code did not work';

const failureMessage = async (response: Response): Promise<string> => {
    try {
        const body = (await response.json()) as { error?: string; message?: string };
        return body.error || body.message || REJECTION;
    } catch {
        return REJECTION;
    }
};

/**
 * Trade a printed login code for a student session; resolves to the display name.
 *
 * Deliberately NOT callEdgeFunction: that helper requires an access token, and
 * a student typing the code off their card has none — student-login is deployed
 * with verify_jwt = false precisely because the code IS the credential. So this
 * is a bare fetch carrying the anon apikey and nothing else; sending an
 * Authorization header would only invite the function to trust a caller-supplied
 * identity it must ignore.
 *
 * Failures are not interpreted. student-login answers every rejection with one
 * indistinguishable body so it can never become an oracle for which codes
 * exist, and re-deriving "wrong code" vs "archived student" on the client would
 * throw that away. The one thing worth telling apart is a request that never
 * reached the server at all — that is a dead network, not a bad code, and a
 * child staring at a correct code deserves to be told which it is.
 */
export const loginWithCode = async (code: string): Promise<string> => {
    const projectUrl = import.meta.env.VITE_SUPABASE_URL as string;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

    let response: Response;
    try {
        response = await fetch(`${projectUrl}/functions/v1/student-login`, {
            method: 'POST',
            headers: {
                apikey: anonKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ code }),
        });
    } catch {
        throw new Error('Could not reach Cleffy. Check the internet connection and try again.');
    }

    if (!response.ok) {
        throw new Error(await failureMessage(response));
    }

    const body = (await response.json()) as { accessToken?: string; refreshToken?: string; displayName?: string };
    if (!body.accessToken || !body.refreshToken) {
        throw new Error(REJECTION);
    }

    // The function hands back a token pair rather than a cookie, so adopting the
    // session is the client's job — and until this resolves the student is still
    // signed out, which is why the caller must await it before navigating.
    const { error } = await getSupabase().auth.setSession({
        access_token: body.accessToken,
        refresh_token: body.refreshToken,
    });
    if (error) {
        throw new Error(REJECTION);
    }

    return body.displayName ?? 'Student';
};

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
    const { data: documents, error: documentsError } = await supabase
        .from('documents')
        .select('*')
        .in('id', documentIds);
    if (documentsError) {
        throw new Error(`Could not load your pieces: ${documentsError.message}`);
    }

    const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
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
    const { data, error } = await getSupabase().from('managed_students').select('*').limit(1).maybeSingle();
    if (error) {
        throw new Error(`Could not load your profile: ${error.message}`);
    }
    return data;
};
