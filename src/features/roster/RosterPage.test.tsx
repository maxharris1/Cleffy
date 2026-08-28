import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LimitReachedError } from '@/features/billing/limitErrors';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { RosterPage } from '@/features/roster/RosterPage';
import type { RosterAssignment } from '@/features/roster/rosterService';
import type { ManagedStudentRow } from '@/types/database';

const listRoster = vi.fn();
const listAssignmentsForStudents = vi.fn();
const fetchStudentTimeline = vi.fn();
const provisionStudent = vi.fn();
const rotateStudentCode = vi.fn();
const archiveStudent = vi.fn();
const restoreStudent = vi.fn();
const assignScore = vi.fn();
const unassignScore = vi.fn();

vi.mock('@/features/roster/rosterService', () => ({
    listRoster: (...args: unknown[]) => listRoster(...args),
    listAssignmentsForStudents: (...args: unknown[]) => listAssignmentsForStudents(...args),
    fetchStudentTimeline: (...args: unknown[]) => fetchStudentTimeline(...args),
    provisionStudent: (...args: unknown[]) => provisionStudent(...args),
    rotateStudentCode: (...args: unknown[]) => rotateStudentCode(...args),
    archiveStudent: (...args: unknown[]) => archiveStudent(...args),
    restoreStudent: (...args: unknown[]) => restoreStudent(...args),
    assignScore: (...args: unknown[]) => assignScore(...args),
    unassignScore: (...args: unknown[]) => unassignScore(...args),
}));

const student = (id: string, displayName: string, archivedAt: string | null = null): ManagedStudentRow => ({
    id,
    teacher_id: 'teacher-1',
    student_user_id: `${id}-user`,
    display_name: displayName,
    parent_email: null,
    archived_at: archivedAt,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
});

const rosterAssignment = (documentId: string, documentTitle: string, studentUserId: string): RosterAssignment => ({
    assignment: {
        id: `assignment-${documentId}`,
        document_id: documentId,
        student_user_id: studentUserId,
        assigned_by: 'teacher-1',
        note: null,
        due_at: null,
        access: 'edit',
        created_at: '2026-08-01T00:00:00Z',
        updated_at: '2026-08-01T00:00:00Z',
    },
    documentTitle,
});

const openPricing = vi.fn();

const outletContext: LibraryOutletContext = {
    userId: 'teacher-1',
    uploadPct: null,
    uploading: false,
    onUpload: vi.fn(),
    onImportImslp: vi.fn(),
    uploadError: null,
    clearUploadError: vi.fn(),
    uploadLimit: null,
    tier: 'free',
    canManageStudents: true,
    openPricing,
};

const ContextFrame = () => <Outlet context={outletContext} />;

const renderRoster = () =>
    render(
        <MemoryRouter initialEntries={['/students']}>
            <Routes>
                <Route element={<ContextFrame />}>
                    <Route path="/students" element={<RosterPage />} />
                </Route>
            </Routes>
        </MemoryRouter>,
    );

beforeEach(() => {
    vi.clearAllMocks();
    listRoster.mockResolvedValue([]);
    listAssignmentsForStudents.mockResolvedValue(new Map());
    fetchStudentTimeline.mockResolvedValue([]);
});

afterEach(() => {
    cleanup();
});

describe('RosterPage', () => {
    it('lists the roster with its assignment counts, archived students included', async () => {
        listRoster.mockResolvedValue([
            student('s1', 'Ada Lovelace'),
            student('s2', 'Bo Diddley', '2026-08-20T00:00:00Z'),
        ]);
        listAssignmentsForStudents.mockResolvedValue(
            new Map([['s1-user', [rosterAssignment('doc-1', 'Prelude and Fugue', 's1-user')]]]),
        );
        renderRoster();

        expect(await screen.findByRole('button', { name: /Ada Lovelace/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Bo Diddley/ })).toHaveTextContent('Archived');
        // An archived student holds no seat, so the two counts are stated apart.
        expect(screen.getByText('1 student · 1 archived')).toBeInTheDocument();
        expect(await screen.findByText('1 score')).toBeInTheDocument();
        expect(screen.getByText('No scores')).toBeInTheDocument();
    });

    it('provisions a student and shows the code once, on a printable card', async () => {
        const user = userEvent.setup();
        provisionStudent.mockResolvedValue({
            student: { id: 's1', studentUserId: 's1-user', displayName: 'Ada Lovelace' },
            loginCode: 'ABCD-EFGH-JKLM',
        });
        renderRoster();

        await user.type(await screen.findByLabelText('Student name'), 'Ada Lovelace');
        await user.type(screen.getByLabelText('Parent email (optional)'), 'parent@example.com');
        await user.click(screen.getByRole('button', { name: 'Add student' }));

        expect(provisionStudent).toHaveBeenCalledWith('Ada Lovelace', 'parent@example.com');
        const card = await screen.findByRole('dialog', { name: 'Login card' });
        expect(within(card).getByText('ABCD-EFGH-JKLM')).toBeInTheDocument();
        expect(screen.getByLabelText('Student name')).toHaveValue('');
    });

    it('offers an upgrade instead of an error when the plan’s seats are full', async () => {
        const user = userEvent.setup();
        provisionStudent.mockRejectedValue(
            new LimitReachedError({ code: 'limit_reached', metric: 'students', limit: 3, tier: 'free' }),
        );
        renderRoster();

        await user.type(await screen.findByLabelText('Student name'), 'Ada Lovelace');
        await user.click(screen.getByRole('button', { name: 'Add student' }));

        expect(await screen.findByText(/filled your 3 free student seats/)).toBeInTheDocument();
        // The typed name survives, so upgrading and pressing Add again costs nothing.
        expect(screen.getByLabelText('Student name')).toHaveValue('Ada Lovelace');

        await user.click(screen.getByRole('button', { name: 'See plans' }));
        expect(openPricing).toHaveBeenCalled();
    });

    it('offers the upgrade instead of the roster when the plan has no students', async () => {
        // Personal and provisioned students get students: 0 from tier_limits().
        outletContext.canManageStudents = false;
        try {
            renderRoster();

            expect(await screen.findByText('Your plan doesn’t include students')).toBeInTheDocument();
            // No add form, so nothing can be submitted for the server to refuse.
            expect(screen.queryByLabelText('Student name')).not.toBeInTheDocument();

            await userEvent.click(screen.getByRole('button', { name: 'See plans' }));
            expect(openPricing).toHaveBeenCalledOnce();
        } finally {
            outletContext.canManageStudents = true;
        }
    });
});
