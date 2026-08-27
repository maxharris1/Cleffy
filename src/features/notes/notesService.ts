import { getSupabase } from '@/lib/supabase';
import type { PracticeNoteRow, PracticeNoteUpdate } from '@/types/database';

/**
 * The practice journal behind a score.
 *
 * Every read here is a plain RLS-scoped select — practice_notes_select already
 * answers "whose note is this?" (the author sees all of theirs, a student sees
 * the shared ones addressed to them), so listNotes filters by document and
 * nothing else. That is deliberate: one query serves the teacher's private
 * journal and the student's read-only feed, and neither role can widen its own
 * result by asking differently.
 *
 * Ids are client-generated, matching documents/annotations/library_tags.
 */

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * Today in the `noted_on` wire format (a bare ISO date).
 *
 * Built from local parts rather than toISOString(), which is UTC: an evening
 * lesson west of Greenwich would otherwise be filed under tomorrow, and the day
 * a note belongs to is the whole organizing device of this feature.
 */
export const todayIsoDate = (): string => {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/** Notes on a score, newest lesson day first, newest note within the day first. */
export const listNotes = async (documentId: string): Promise<PracticeNoteRow[]> => {
    const { data, error } = await getSupabase()
        .from('practice_notes')
        .select('*')
        .eq('document_id', documentId)
        .order('noted_on', { ascending: false })
        .order('created_at', { ascending: false });
    if (error) {
        throw new Error(`Could not load practice notes: ${error.message}`);
    }
    return data;
};

/**
 * Writes a note. `studentUserId` is who the note is ABOUT, and it is set whether
 * or not the note is shared — a private note about a student is still about that
 * student, and stamping it now is what lets `shared` be flipped later.
 * PracticeNoteUpdate deliberately cannot change it (see the schema comment), so
 * a note created with no student can never become visible to one.
 */
export const createNote = async (
    documentId: string,
    body: string,
    notedOn: string,
    shared: boolean,
    studentUserId?: string | null,
): Promise<PracticeNoteRow> => {
    const supabase = getSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    const authorId = sessionData.session?.user.id;
    if (!authorId) {
        throw new Error('Not signed in');
    }

    const { data, error } = await supabase
        .from('practice_notes')
        .insert({
            id: crypto.randomUUID(),
            document_id: documentId,
            student_user_id: studentUserId ?? null,
            author_id: authorId,
            noted_on: notedOn,
            body,
            shared,
        })
        .select()
        .single();
    if (error) {
        throw new Error(`Could not save that note: ${error.message}`);
    }
    return data;
};

export const updateNote = async (id: string, patch: PracticeNoteUpdate): Promise<PracticeNoteRow> => {
    const { data, error } = await getSupabase().from('practice_notes').update(patch).eq('id', id).select().single();
    if (error) {
        throw new Error(`Could not update that note: ${error.message}`);
    }
    return data;
};

export const deleteNote = async (id: string): Promise<void> => {
    const { error } = await getSupabase().from('practice_notes').delete().eq('id', id);
    if (error) {
        throw new Error(`Could not delete that note: ${error.message}`);
    }
};

/** A student this score is assigned to — i.e. someone a shared note can actually reach. */
export interface NoteRecipient {
    studentUserId: string;
    displayName: string;
}

/**
 * Who "Visible to student" means for this score.
 *
 * A shared note is only readable by the student it names, so the composer has to
 * know that name before it can offer to share; with nobody assigned, sharing is
 * an option that would silently do nothing and the panel disables it instead.
 *
 * Two queries rather than an embedded select: assignments is typed with
 * `Relationships: []`, so PostgREST has no declared path to traverse.
 */
export const listNoteRecipients = async (documentId: string): Promise<NoteRecipient[]> => {
    const supabase = getSupabase();
    const { data: assignments, error } = await supabase.from('assignments').select('*').eq('document_id', documentId);
    if (error) {
        throw new Error(`Could not load who this score is assigned to: ${error.message}`);
    }
    if (assignments.length === 0) {
        return [];
    }

    const studentIds = [...new Set(assignments.map((assignment) => assignment.student_user_id))];
    const { data: roster, error: rosterError } = await supabase
        .from('managed_students')
        .select('student_user_id, display_name, archived_at')
        .in('student_user_id', studentIds);
    if (rosterError) {
        throw new Error(`Could not load who this score is assigned to: ${rosterError.message}`);
    }

    // Archived students keep their history but are no longer someone to write to.
    return roster
        .filter((student) => student.archived_at === null)
        .map((student) => ({ studentUserId: student.student_user_id, displayName: student.display_name }));
};
