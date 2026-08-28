import { callEdgeFunction, limitErrorFrom } from '@/features/billing/billingApi';
import { getSupabase } from '@/lib/supabase';
import type { AssignmentAccess, AssignmentRow, ManagedStudentRow, PracticeNoteRow } from '@/types/database';

/**
 * The teacher's side of the roster: provisioning, assignments, and the practice
 * journal read back as a per-student timeline.
 *
 * Two very different write paths meet here, and the split is deliberate:
 *  - Provisioning creates a real auth user, which no client may do, so
 *    create/reset/archive/restore all go through the student-provision Edge
 *    Function under the service role. managed_students has no client write
 *    policy at all.
 *  - Assigning writes document_members, which also has no client write policy,
 *    so it goes through the assign_score / unassign_score SECURITY DEFINER RPCs.
 *
 * That leaves the reads, which are plain RLS-scoped selects: the policies in the
 * roster migration already answer "whose row is this?", so nothing below filters
 * by teacher id itself.
 *
 * Raw fetch rather than functions.invoke, for the reason billingApi documents:
 * invoke collapses a non-2xx into FunctionsHttpError and throws the body away,
 * and the 402 body is the entire point — a full roster is a pricing state, not
 * an error, and it has to reach the UI intact.
 */

/**
 * Every column of managed_students the client is granted, which is every column
 * except login_code_hash — `select('*')` would ask for that one too and be
 * refused outright. Shared so the three readers cannot drift from the grant, or
 * from each other, when a column is added.
 */
export const MANAGED_STUDENT_COLUMNS =
    'id, teacher_id, student_user_id, display_name, parent_email, auth_method, username, student_email, claimed_at, archived_at, created_at, updated_at';

export interface ProvisionedStudent {
    id: string;
    studentUserId: string;
    displayName: string;
}

/**
 * How a new student will get in, and therefore what comes back.
 *
 * `parentEmail` is the PARENT's on both paths — for the teacher's records and
 * for sending the card home — and stays independent of `studentEmail`, which is
 * the student's own and exists only on the invite path. Conflating them would
 * mean a parent's address could be turned into a child's sign-in.
 */
export type ProvisionOptions =
    { parentEmail?: string; method: 'code' } | { parentEmail?: string; method: 'email'; studentEmail: string };

/** A printed card, or an invite already in flight — never both. */
export type ProvisionResult =
    | {
          student: ProvisionedStudent;
          /** Readable exactly once. Nothing can look it up again — only 'reset' replaces it. */
          loginCode: string;
      }
    | { student: ProvisionedStudent; invited: true; studentEmail: string };

/** The same two shapes after a reset, minus the row itself, which is unchanged. */
export type ResetResult =
    | {
          loginCode: string;
          /** The username the student already claimed, kept across the reset; null if they never did. */
          username: string | null;
      }
    | { invited: true; studentEmail: string };

/** An assignment paired with the score's title, joined client-side. */
export interface RosterAssignment {
    assignment: AssignmentRow;
    documentTitle: string;
}

/** One practice-journal entry with the score it was written against. */
export interface TimelineEntry {
    note: PracticeNoteRow;
    documentTitle: string;
}

const messageFrom = async (response: Response, fallback: string): Promise<string> => {
    try {
        const body = (await response.json()) as { error?: string; message?: string };
        return body.error || body.message || fallback;
    } catch {
        return fallback;
    }
};

/**
 * Turns any non-2xx from student-provision into the right kind of throw.
 *
 * A 402 is the roster stock being full, which the pricing UI renders as an
 * upgrade prompt rather than red error text, so it keeps its type all the way
 * up. Everything else is a plain Error carrying whatever the server said.
 */
const failFrom = async (response: Response, fallback: string): Promise<never> => {
    const limit = await limitErrorFrom(response);
    if (limit) {
        throw limit;
    }
    throw new Error(await messageFrom(response, fallback));
};

const provision = (payload: Record<string, unknown>): Promise<Response> =>
    callEdgeFunction('student-provision', payload);

/**
 * Where the invite and reset emails have to land. The function cannot work this
 * out for itself — it has no idea which origin the teacher is on — so every call
 * that could send mail carries it.
 */
const welcomeRedirect = (): string => `${window.location.origin}/student/welcome`;

interface ProvisionBody {
    student?: ProvisionedStudent;
    loginCode?: string;
    username?: string | null;
    invited?: boolean;
    studentEmail?: string;
}

/**
 * Creates the student account and the roster row that names it.
 *
 * Throws LimitReachedError when the seat would exceed the plan's roster, and a
 * plain Error carrying the server's own words for the rest — including the 409
 * that says this address is already somebody's sign-in, which is a sentence the
 * teacher has to read rather than a state the UI can resolve for them.
 */
export const provisionStudent = async (displayName: string, opts: ProvisionOptions): Promise<ProvisionResult> => {
    const trimmedEmail = opts.parentEmail?.trim();
    const response = await provision({
        action: 'create',
        displayName: displayName.trim(),
        method: opts.method,
        ...(trimmedEmail ? { parentEmail: trimmedEmail } : {}),
        ...(opts.method === 'email' ? { studentEmail: opts.studentEmail.trim(), redirectTo: welcomeRedirect() } : {}),
    });
    if (!response.ok) {
        return failFrom(response, 'Could not add that student.');
    }

    const body = (await response.json()) as ProvisionBody;
    if (!body.student) {
        throw new Error('The student was created but the server did not say who — reload your roster.');
    }
    if (opts.method === 'email') {
        if (!body.invited || !body.studentEmail) {
            // The seat is spent either way, so this is not a retry prompt.
            throw new Error('The student was created but the invite did not go out — reset their access to send it.');
        }
        return { student: body.student, invited: true, studentEmail: body.studentEmail };
    }
    if (!body.loginCode) {
        // Same: reload the roster and reset access for whoever appeared.
        throw new Error('The student was created but no setup code came back — reset their access to get one.');
    }
    return { student: body.student, loginCode: body.loginCode };
};

/**
 * Cuts off however the student gets in today and issues the replacement.
 *
 * One action for both paths because it is one intent — "they cannot get in, fix
 * it" — and the roster row already knows which door they use. A code student
 * gets a fresh card (keeping the username they claimed, if they ever did); an
 * invited student gets another link. Either way whatever they had stops working
 * the moment this returns, which is what makes it the answer to a lost card AND
 * to a password someone else now knows.
 */
export const resetStudentAccess = async (studentId: string): Promise<ResetResult> => {
    const response = await provision({ action: 'reset', studentId, redirectTo: welcomeRedirect() });
    if (!response.ok) {
        return failFrom(response, 'Could not reset that student’s access.');
    }
    const body = (await response.json()) as ProvisionBody;
    if (body.invited) {
        if (!body.studentEmail) {
            throw new Error('The server did not say where the link was sent.');
        }
        return { invited: true, studentEmail: body.studentEmail };
    }
    if (!body.loginCode) {
        throw new Error('The server did not return a new setup code.');
    }
    return { loginCode: body.loginCode, username: body.username ?? null };
};

/** Frees the seat and revokes the code. Deletes nothing — restore brings it all back. */
export const archiveStudent = async (studentId: string): Promise<void> => {
    const response = await provision({ action: 'archive', studentId });
    if (!response.ok) {
        await failFrom(response, 'Could not archive that student.');
    }
};

/** Re-occupies a seat, so this can be refused with LimitReachedError exactly as create is. */
export const restoreStudent = async (studentId: string): Promise<void> => {
    const response = await provision({ action: 'restore', studentId });
    if (!response.ok) {
        await failFrom(response, 'Could not restore that student.');
    }
};

/**
 * The teacher's roster: active students first, then archived, each block
 * alphabetical.
 *
 * Sorted here rather than in the query because the ordering is two-level and the
 * first level is a predicate (archived or not), not a column — ordering by
 * archived_at would sort the archived block by when it was archived.
 */
export const listRoster = async (): Promise<ManagedStudentRow[]> => {
    const { data, error } = await getSupabase().from('managed_students').select(MANAGED_STUDENT_COLUMNS);
    if (error) {
        throw new Error(`Could not load your roster: ${error.message}`);
    }
    return [...(data ?? [])].sort((a, b) => {
        const archived = Number(a.archived_at !== null) - Number(b.archived_at !== null);
        return archived !== 0 ? archived : a.display_name.localeCompare(b.display_name);
    });
};

/** Titles for a set of score ids, in one query — the client-side half of the joins below. */
const documentTitles = async (documentIds: string[]): Promise<Map<string, string>> => {
    const unique = [...new Set(documentIds)];
    if (unique.length === 0) {
        return new Map();
    }
    const { data, error } = await getSupabase().from('documents').select('id, title').in('id', unique);
    if (error) {
        throw new Error(`Could not load score titles: ${error.message}`);
    }
    return new Map((data ?? []).map((row) => [row.id, row.title]));
};

const UNKNOWN_TITLE = 'Untitled score';

/**
 * Every assignment the teacher owns, grouped by the student it belongs to.
 *
 * No teacher filter: the assignments policy already resolves to "mine as the
 * score owner, or mine as the student", and a teacher is never the latter.
 */
export const listAssignmentsForStudents = async (): Promise<Map<string, RosterAssignment[]>> => {
    const { data, error } = await getSupabase()
        .from('assignments')
        .select('*')
        .order('created_at', { ascending: false });
    if (error) {
        throw new Error(`Could not load assignments: ${error.message}`);
    }

    const rows = data ?? [];
    const titles = await documentTitles(rows.map((row) => row.document_id));
    const grouped = new Map<string, RosterAssignment[]>();
    for (const assignment of rows) {
        const forStudent = grouped.get(assignment.student_user_id) ?? [];
        forStudent.push({ assignment, documentTitle: titles.get(assignment.document_id) ?? UNKNOWN_TITLE });
        grouped.set(assignment.student_user_id, forStudent);
    }
    return grouped;
};

/** The RPCs raise structured errors; these are the ones a teacher can act on. */
const rpcMessage = (raw: string, fallback: string): string => {
    if (raw.includes('not on your roster')) {
        return 'That student is not on your active roster — restore them first.';
    }
    if (raw.includes('only the score owner')) {
        return 'Only the owner of a score can assign it.';
    }
    if (raw.includes('access must be')) {
        return 'Choose whether the student can edit or only view.';
    }
    if (raw.includes('not authenticated')) {
        return 'Your session expired. Sign in again and retry.';
    }
    return `${fallback} ${raw}`;
};

/**
 * Assigns (or re-assigns) a score and returns the assignment id.
 *
 * The RPC upserts, so calling it again is how the access toggle works — but it
 * overwrites note and due date with what it is given, which is why callers
 * flipping access have to pass the existing values back.
 */
export const assignScore = async (
    documentId: string,
    studentUserId: string,
    access: AssignmentAccess,
    note?: string | null,
    dueAt?: string | null,
): Promise<string> => {
    const { data, error } = await getSupabase().rpc('assign_score', {
        p_document: documentId,
        p_student: studentUserId,
        p_access: access,
        p_note: note ?? null,
        p_due_at: dueAt ?? null,
    });
    if (error) {
        throw new Error(rpcMessage(error.message, 'Could not assign that score:'));
    }
    return data;
};

/** Withdraws the assignment and the membership it granted. Annotations stay. */
export const unassignScore = async (documentId: string, studentUserId: string): Promise<void> => {
    const { error } = await getSupabase().rpc('unassign_score', {
        p_document: documentId,
        p_student: studentUserId,
    });
    if (error) {
        throw new Error(rpcMessage(error.message, 'Could not unassign that score:'));
    }
};

/**
 * One student's practice journal, newest lesson day first.
 *
 * No author filter: practice_notes' policy already limits a teacher to notes
 * they wrote, so this reads as "my notes about this student" — a note another
 * teacher wrote about the same account is invisible here by construction.
 */
export const fetchStudentTimeline = async (studentUserId: string): Promise<TimelineEntry[]> => {
    const { data, error } = await getSupabase()
        .from('practice_notes')
        .select('*')
        .eq('student_user_id', studentUserId)
        .order('noted_on', { ascending: false })
        .order('created_at', { ascending: false });
    if (error) {
        throw new Error(`Could not load practice notes: ${error.message}`);
    }

    const rows = data ?? [];
    const titles = await documentTitles(rows.map((row) => row.document_id));
    return rows.map((note) => ({ note, documentTitle: titles.get(note.document_id) ?? UNKNOWN_TITLE }));
};
