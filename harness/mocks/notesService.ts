import type { PracticeNoteRow } from '../../src/types/database';

import { todayIsoDate } from '../../src/features/notes/notesService';

export * from '../../src/features/notes/notesService';

const iso = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
const note = (id: string, d: number, body: string, shared: boolean): PracticeNoteRow => ({
    id, document_id: 'doc-fixture', student_user_id: 'student', author_id: 'teacher', noted_on: d === 0 ? todayIsoDate() : iso(d), body, shared,
    created_at: new Date(Date.now() - d * 86_400_000).toISOString(), updated_at: new Date(Date.now() - d * 86_400_000).toISOString(),
});

const NOTES: PracticeNoteRow[] = [
    note('n1', 0, 'Bars 9–16: left hand alone, slow, with the circled fingering. Keep the wrist loose on the leaps.', true),
    note('n2', 0, 'Rushing the turn in bar 12 again. Try it next week with the metronome at 60.', false),
    note('n3', 7, 'Lovely dynamics in the opening. Practise the A section hands together, 10 minutes a day.', true),
];

export const listNotes = async (_documentId: string) => NOTES;
export const listNoteRecipients = async (_documentId: string) => [{ studentUserId: 'student', displayName: 'Maya Chen' }];
