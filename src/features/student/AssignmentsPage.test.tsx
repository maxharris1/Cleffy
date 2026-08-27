import type { Session } from '@supabase/supabase-js';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as sessionModule from '@/features/auth/session';
import { AssignmentsPage } from '@/features/student/AssignmentsPage';
import type { AssignedScore } from '@/features/student/studentApi';
import type { AssignmentRow, ManagedStudentRow } from '@/types/database';

const fetchMyAssignments = vi.fn();
const fetchMyRosterProfile = vi.fn();
const signOut = vi.fn();

vi.mock('@/features/student/studentApi', () => ({
    fetchMyAssignments: (...args: unknown[]) => fetchMyAssignments(...args),
    fetchMyRosterProfile: (...args: unknown[]) => fetchMyRosterProfile(...args),
}));

// userTypeOf and displayNameOf stay real: the gate below is the page's own.
vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<typeof sessionModule>()),
    useSession: () => ({ session: studentSession, loading: false, lastEvent: null }),
    signOut: (...args: unknown[]) => signOut(...args),
}));

/** A provisioned student: no email, user_type set by student-provision. */
const studentSession = {
    access_token: 'access-token',
    user: {
        id: 'student-1',
        is_anonymous: false,
        app_metadata: { user_type: 'student' },
        user_metadata: { display_name: 'Ada' },
    },
} as unknown as Session;

const assigned = (id: string, title: string, over: Partial<AssignmentRow> = {}): AssignedScore => ({
    assignment: {
        id: `assignment-${id}`,
        document_id: id,
        student_user_id: 'student-1',
        assigned_by: 'teacher-1',
        note: null,
        due_at: null,
        access: 'edit',
        created_at: '2026-08-01T00:00:00Z',
        updated_at: '2026-08-01T00:00:00Z',
        ...over,
    },
    document: {
        id,
        owner_id: 'teacher-1',
        title,
        storage_path: `${id}/original.pdf`,
        page_count: 3,
        content_rev: 0,
        created_at: '2026-08-01T00:00:00Z',
        updated_at: '2026-08-01T00:00:00Z',
        archived_at: null,
    },
});

const rosterRow = (displayName: string): ManagedStudentRow => ({
    id: 'roster-1',
    teacher_id: 'teacher-1',
    student_user_id: 'student-1',
    display_name: displayName,
    parent_email: null,
    archived_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
});

const renderAssignments = () =>
    render(
        <MemoryRouter initialEntries={['/assignments']}>
            <Routes>
                <Route path="/assignments" element={<AssignmentsPage />} />
                <Route path="/student" element={<p>student login</p>} />
            </Routes>
        </MemoryRouter>,
    );

beforeEach(() => {
    vi.clearAllMocks();
    fetchMyAssignments.mockResolvedValue([]);
    fetchMyRosterProfile.mockResolvedValue(null);
    signOut.mockResolvedValue(undefined);
});

afterEach(() => {
    cleanup();
});

describe('AssignmentsPage', () => {
    it('lists each assigned piece as a link into the viewer', async () => {
        fetchMyAssignments.mockResolvedValue([
            assigned('doc-1', 'Prelude and Fugue', {
                note: 'Slowly, hands separately.',
                due_at: `${new Date().getFullYear()}-09-04T09:00:00Z`,
            }),
            assigned('doc-2', 'An Chloe', { access: 'view' }),
        ]);
        renderAssignments();

        const prelude = await screen.findByRole('link', { name: /Prelude and Fugue/ });
        expect(prelude).toHaveAttribute('href', '/doc/doc-1');
        expect(within(prelude).getByText(/^Due /)).toBeInTheDocument();
        expect(within(prelude).getByText('Slowly, hands separately.')).toBeInTheDocument();
        expect(within(prelude).queryByText('View only')).not.toBeInTheDocument();

        const chloe = screen.getByRole('link', { name: /An Chloe/ });
        expect(chloe).toHaveAttribute('href', '/doc/doc-2');
        expect(within(chloe).getByText('View only')).toBeInTheDocument();
        expect(within(chloe).queryByText(/^Due /)).not.toBeInTheDocument();
    });

    it('invites the student to wait rather than showing an empty page', async () => {
        renderAssignments();
        expect(await screen.findByRole('heading', { name: 'Nothing here yet' })).toBeInTheDocument();
        expect(screen.getByText('Your teacher will assign your pieces.')).toBeInTheDocument();
    });

    it('prefers the teacher’s spelling of the student’s name', async () => {
        fetchMyRosterProfile.mockResolvedValue(rosterRow('Ada Lovelace'));
        renderAssignments();
        expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    });

    it('signs out and returns to the code-entry page', async () => {
        const user = userEvent.setup();
        renderAssignments();

        await user.click(await screen.findByRole('button', { name: 'Sign out' }));

        expect(signOut).toHaveBeenCalled();
        expect(await screen.findByText('student login')).toBeInTheDocument();
    });
});
