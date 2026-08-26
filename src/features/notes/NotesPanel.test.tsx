import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NotesPanel } from '@/features/notes/NotesPanel';
import type { PracticeNoteRow } from '@/types/database';

const listNotes = vi.fn();
const listNoteRecipients = vi.fn();
const createNote = vi.fn();
const updateNote = vi.fn();
const deleteNote = vi.fn();

/** Pinned so 'Today' and the note dates below cannot drift apart mid-run. */
const TODAY = '2026-08-26';
const LAST_WEEK = '2026-08-19';

vi.mock('@/features/notes/notesService', () => ({
    listNotes: (...args: unknown[]) => listNotes(...args),
    listNoteRecipients: (...args: unknown[]) => listNoteRecipients(...args),
    createNote: (...args: unknown[]) => createNote(...args),
    updateNote: (...args: unknown[]) => updateNote(...args),
    deleteNote: (...args: unknown[]) => deleteNote(...args),
    todayIsoDate: () => TODAY,
}));

const note = (id: string, body: string, over: Partial<PracticeNoteRow> = {}): PracticeNoteRow => ({
    id,
    document_id: 'doc-1',
    student_user_id: 'student-1',
    author_id: 'teacher-1',
    noted_on: TODAY,
    body,
    shared: false,
    created_at: `${TODAY}T10:00:00Z`,
    updated_at: `${TODAY}T10:00:00Z`,
    ...over,
});

const ada = { studentUserId: 'student-1', displayName: 'Ada Lovelace' };
const bo = { studentUserId: 'student-2', displayName: 'Bo Diddley' };

const renderPanel = (role: 'owner' | 'member') =>
    render(<NotesPanel documentId="doc-1" role={role} onClose={vi.fn()} />);

beforeEach(() => {
    vi.clearAllMocks();
    listNotes.mockResolvedValue([]);
    listNoteRecipients.mockResolvedValue([ada]);
});

afterEach(() => {
    cleanup();
});

describe('NotesPanel — the teacher’s journal', () => {
    it('opens the composer and files every note, shared or not, under its lesson day', async () => {
        listNotes.mockResolvedValue([
            note('n1', 'Shared: metronome at 60.', { shared: true }),
            note('n2', 'Private: still rushing the left hand.'),
            note('n3', 'Private: chose the Bach for the recital.', { noted_on: LAST_WEEK }),
        ]);
        renderPanel('owner');

        expect(await screen.findByText('Private: still rushing the left hand.')).toBeInTheDocument();
        expect(screen.getByLabelText('New note')).toBeInTheDocument();
        expect(screen.getByText('Shared: metronome at 60.')).toBeInTheDocument();
        expect(screen.getByText('Private: chose the Bach for the recital.')).toBeInTheDocument();

        // One heading per lesson day, newest first — today's is named as such.
        const days = screen.getAllByRole('heading', { level: 3 });
        expect(days).toHaveLength(2);
        expect(screen.getByRole('heading', { level: 3, name: 'Today' })).toBeInTheDocument();
        // Only the shared note is marked; sharing is always a deliberate act.
        expect(screen.getAllByText('Shared')).toHaveLength(1);
    });

    it('writes a new note as shared when the box is ticked', async () => {
        const user = userEvent.setup();
        listNoteRecipients.mockResolvedValue([ada, bo]);
        createNote.mockResolvedValue(note('n9', 'Bars 12–16, hands separately.', { shared: true }));
        renderPanel('owner');

        await user.type(await screen.findByLabelText('New note'), 'Bars 12–16, hands separately.');
        await user.click(screen.getByRole('checkbox', { name: 'Visible to student' }));
        await user.click(screen.getByRole('button', { name: 'Save' }));

        expect(createNote).toHaveBeenCalledWith('doc-1', 'Bars 12–16, hands separately.', TODAY, true, 'student-1');
    });

    it('shares an existing private note from its actions', async () => {
        const user = userEvent.setup();
        const priv = note('n1', 'Still rushing the left hand.');
        listNotes.mockResolvedValue([priv]);
        updateNote.mockResolvedValue({ ...priv, shared: true });
        renderPanel('owner');

        await user.click(await screen.findByRole('button', { name: 'Note actions' }));
        await user.click(screen.getByRole('button', { name: 'Make visible to student' }));

        expect(updateNote).toHaveBeenCalledWith('n1', { shared: true });
        expect(await screen.findByText('Shared')).toBeInTheDocument();
    });
});

describe('NotesPanel — the student’s view', () => {
    it('shows the shared notes read-only, and never asks for the roster', async () => {
        listNotes.mockResolvedValue([
            note('n1', 'Metronome at 60 this week.', { shared: true }),
            // The panel filters as well as the policy does, so a leak stays invisible.
            note('n2', 'Private: still rushing the left hand.'),
        ]);
        renderPanel('member');

        expect(await screen.findByText('Metronome at 60 this week.')).toBeInTheDocument();
        expect(screen.getByText('Notes your teacher has shared with you.')).toBeInTheDocument();
        expect(screen.queryByText('Private: still rushing the left hand.')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('New note')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Note actions' })).not.toBeInTheDocument();
        expect(listNoteRecipients).not.toHaveBeenCalled();
    });

    it('explains the silence when nothing has been shared', async () => {
        renderPanel('member');
        expect(await screen.findByRole('heading', { name: 'No notes from your teacher yet.' })).toBeInTheDocument();
        expect(screen.getByText('Anything they write for you about this piece will show up here.')).toBeInTheDocument();
    });
});
