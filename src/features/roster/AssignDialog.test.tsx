import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssignDialog } from '@/features/roster/AssignDialog';
import type { RosterAssignment } from '@/features/roster/rosterService';
import type { ManagedStudentRow } from '@/types/database';

const listRoster = vi.fn();
const listAssignmentsForStudents = vi.fn();
const assignScore = vi.fn();

vi.mock('@/features/roster/rosterService', () => ({
    listRoster: (...args: unknown[]) => listRoster(...args),
    listAssignmentsForStudents: (...args: unknown[]) => listAssignmentsForStudents(...args),
    assignScore: (...args: unknown[]) => assignScore(...args),
}));

const student = (id: string, displayName: string, archivedAt: string | null = null): ManagedStudentRow => ({
    id,
    teacher_id: 'teacher-1',
    student_user_id: `${id}-user`,
    display_name: displayName,
    parent_email: null,
    auth_method: 'code',
    username: null,
    student_email: null,
    claimed_at: null,
    archived_at: archivedAt,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    country: null,
    age_attested_at: null,
    age_attested_min_age: null,
});

const rosterAssignment = (documentId: string, studentUserId: string): RosterAssignment => ({
    assignment: {
        id: `assignment-${documentId}`,
        document_id: documentId,
        student_user_id: studentUserId,
        assigned_by: 'teacher-1',
        note: 'Bars 12–24, hands separately',
        due_at: '2026-09-01T23:59:59Z',
        access: 'edit',
        created_at: '2026-08-01T00:00:00Z',
        updated_at: '2026-08-01T00:00:00Z',
    },
    documentTitle: 'Prelude and Fugue',
});

const renderDialog = () =>
    render(
        <MemoryRouter>
            <AssignDialog documentId="doc-1" documentTitle="Prelude and Fugue" onClose={vi.fn()} />
        </MemoryRouter>,
    );

beforeEach(() => {
    vi.clearAllMocks();
    listRoster.mockResolvedValue([student('s1', 'Ada Lovelace'), student('s2', 'Bo Diddley')]);
    listAssignmentsForStudents.mockResolvedValue(new Map());
    assignScore.mockResolvedValue('assignment-1');
});

afterEach(() => {
    cleanup();
});

describe('AssignDialog', () => {
    it('never shows the roster before it knows who already has the score', async () => {
        // The race this closes: the roster resolves first, the list goes
        // interactive with `assigned` still empty, and Ada — who already has this
        // score, with a note and a due date — renders unticked, enabled and
        // badge-less. Assigning her in that window re-runs the upsert, whose
        // `do update set note = excluded.note, due_at = excluded.due_at` writes
        // this dialog's blank fields over what she was given last time.
        let releaseAssignments: (value: Map<string, RosterAssignment[]>) => void = () => undefined;
        listAssignmentsForStudents.mockReturnValue(
            new Promise<Map<string, RosterAssignment[]>>((resolve) => {
                releaseAssignments = resolve;
            }),
        );

        renderDialog();

        // The roster load has landed by now; the list must still be waiting.
        await waitFor(() => expect(listRoster).toHaveBeenCalled());
        expect(await screen.findByText('Loading your roster…')).toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

        releaseAssignments(new Map([['s1-user', [rosterAssignment('doc-1', 's1-user')]]]));

        const ada = await screen.findByRole('checkbox', { name: /Ada Lovelace/ });
        expect(ada).toBeChecked();
        expect(ada).toBeDisabled();
        expect(screen.getByRole('checkbox', { name: /Bo Diddley/ })).toBeEnabled();
        expect(screen.getByText('Assigned')).toBeInTheDocument();
    });

    it('assigns only the students who did not already have the score', async () => {
        const user = userEvent.setup();
        listAssignmentsForStudents.mockResolvedValue(new Map([['s1-user', [rosterAssignment('doc-1', 's1-user')]]]));
        renderDialog();

        await user.click(await screen.findByRole('checkbox', { name: /Bo Diddley/ }));
        await user.click(screen.getByRole('button', { name: 'Assign' }));

        await waitFor(() => expect(assignScore).toHaveBeenCalledTimes(1));
        expect(assignScore).toHaveBeenCalledWith('doc-1', 's2-user', 'edit', null, null);
    });

    it('says plainly that Edit reaches the teacher’s own marks too', async () => {
        // One shared layer per score (owner decision): a student with Edit can
        // erase the teacher's marks, so the choice must not read as "their own".
        const user = userEvent.setup();
        renderDialog();

        await screen.findByRole('checkbox', { name: /Ada Lovelace/ });
        expect(
            screen.getByText('They can add, change and erase all marks on this score, including yours.'),
        ).toBeInTheDocument();
        expect(screen.queryByText(/their own fingerings/)).not.toBeInTheDocument();
        // Students sign in with a username or email now; the code works once.
        expect(screen.queryByText(/sign in with their code/)).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'View only' }));
        expect(screen.getByText('They can read and play from it, but not mark it up.')).toBeInTheDocument();
    });
});
