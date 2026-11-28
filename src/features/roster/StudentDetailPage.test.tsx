import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RosterAssignment } from '@/features/roster/rosterService';
import { StudentDetailPage } from '@/features/roster/StudentDetailPage';
import { getDb } from '@/sync/db';
import type { ManagedStudentRow } from '@/types/database';

const listRoster = vi.fn();
const listAssignmentsForStudent = vi.fn();
const documentThumbRevs = vi.fn();
const assignScore = vi.fn();
const unassignScore = vi.fn();

vi.mock('@/features/roster/rosterService', () => ({
    listRoster: (...args: unknown[]) => listRoster(...args),
    listAssignmentsForStudent: (...args: unknown[]) => listAssignmentsForStudent(...args),
    documentThumbRevs: (...args: unknown[]) => documentThumbRevs(...args),
    assignScore: (...args: unknown[]) => assignScore(...args),
    unassignScore: (...args: unknown[]) => unassignScore(...args),
}));

vi.mock('@/features/library/ScoreThumb', () => ({
    ScoreThumb: ({ docId }: { docId: string }) => <span data-testid="thumb">{docId}</span>,
}));

const student = (id: string, displayName: string, overrides: Partial<ManagedStudentRow> = {}): ManagedStudentRow => ({
    id,
    teacher_id: 'teacher-1',
    student_user_id: `${id}-user`,
    display_name: displayName,
    parent_email: null,
    auth_method: 'code',
    username: null,
    student_email: null,
    claimed_at: null,
    archived_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    country: null,
    age_attested_at: null,
    age_attested_min_age: null,
    ...overrides,
});

const assigned = (
    documentId: string,
    documentTitle: string,
    studentUserId: string,
    overrides: Partial<RosterAssignment['assignment']> = {},
): RosterAssignment => ({
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
        ...overrides,
    },
    documentTitle,
});

const inFuture = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

const renderAt = (path: string) =>
    render(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route
                    element={
                        <main>
                            <Outlet context={{ userId: 'teacher-1' }} />
                        </main>
                    }
                >
                    <Route path="/students/:studentId" element={<StudentDetailPage />} />
                </Route>
                <Route path="/library" element={<p>library page</p>} />
            </Routes>
        </MemoryRouter>,
    );

beforeEach(() => {
    listRoster.mockResolvedValue([student('s1', 'Leo Martin', { username: 'leo_plays', claimed_at: '2026-08-02' })]);
    listAssignmentsForStudent.mockResolvedValue([
        assigned('doc-1', 'Für Elise', 's1-user', { due_at: inFuture(3), note: 'Start at bar 9.' }),
        assigned('doc-2', 'Minuet in G', 's1-user', { access: 'view' }),
    ]);
    documentThumbRevs.mockResolvedValue(new Map());
    assignScore.mockResolvedValue(undefined);
    unassignScore.mockResolvedValue(undefined);
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('StudentDetailPage', () => {
    it('shows a loading state until the roster arrives', () => {
        listRoster.mockReturnValue(new Promise(() => undefined));
        renderAt('/students/s1');
        expect(screen.getByText('Loading student…')).toBeInTheDocument();
    });

    it('heads the page with the name, the username, the count and the next due date', async () => {
        renderAt('/students/s1');

        expect(await screen.findByRole('heading', { level: 1, name: 'Leo Martin' })).toBeInTheDocument();
        expect(screen.getByText(/@leo_plays · 2 scores · next due/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Students' })).toHaveAttribute('href', '/students');
        expect(screen.getByRole('link', { name: 'Assign a score' })).toHaveAttribute('href', '/library');
        expect(screen.queryByText('Write a note')).not.toBeInTheDocument();
    });

    it('leaves out the parts of the line it has no data for', async () => {
        listAssignmentsForStudent.mockResolvedValue([]);
        listRoster.mockResolvedValue([student('s1', 'Leo Martin')]);
        renderAt('/students/s1');

        expect(await screen.findByText('0 scores')).toBeInTheDocument();
        expect(screen.queryByText(/@/)).not.toBeInTheDocument();
        expect(screen.queryByText(/next due/)).not.toBeInTheDocument();
    });

    it('lists each assignment with its links, due pill, note and controls', async () => {
        renderAt('/students/s1');

        expect(await screen.findByRole('heading', { level: 2, name: 'Leo Martin’s scores' })).toBeInTheDocument();
        const items = screen.getAllByRole('listitem');
        expect(items).toHaveLength(2);
        const first = within(items[0]!);
        expect(first.getByRole('link', { name: 'Für Elise' })).toHaveAttribute('href', '/doc/doc-1');
        expect(first.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/doc/doc-1');
        expect(first.getByText(/^Due /)).toBeInTheDocument();
        expect(first.getByText('Start at bar 9.')).toBeInTheDocument();
        expect(first.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
        expect(within(items[1]!).getByRole('button', { name: 'View' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.queryByText(/own copy/)).not.toBeInTheDocument();
    });

    it('flips access by re-running the assignment with its note and due date', async () => {
        const user = userEvent.setup();
        renderAt('/students/s1');

        const item = within((await screen.findAllByRole('listitem'))[0]!);
        await user.click(item.getByRole('button', { name: 'View' }));

        await waitFor(() =>
            expect(assignScore).toHaveBeenCalledWith('doc-1', 's1-user', 'view', 'Start at bar 9.', expect.any(String)),
        );
    });

    it('unassigns a score and reloads the list', async () => {
        const user = userEvent.setup();
        renderAt('/students/s1');

        const item = within((await screen.findAllByRole('listitem'))[1]!);
        await user.click(item.getByRole('button', { name: 'Unassign' }));

        await waitFor(() => expect(unassignScore).toHaveBeenCalledWith('doc-2', 's1-user'));
        await waitFor(() => expect(listRoster).toHaveBeenCalledTimes(2));
    });

    it('shows the load error when the roster cannot be read', async () => {
        listRoster.mockRejectedValue(new Error('Could not load your roster: offline'));
        renderAt('/students/s1');

        expect(await screen.findByText('Could not load your roster: offline')).toBeInTheDocument();
    });

    it('renders the not-found page for an id that is not on this roster', async () => {
        renderAt('/students/someone-else');

        expect(await screen.findByRole('heading', { name: 'Tacet.' })).toBeInTheDocument();
        expect(screen.queryByText('Leo Martin')).not.toBeInTheDocument();
        expect(screen.getAllByRole('main')).toHaveLength(1);
    });

    it('renders the not-found page for an absent id even when assignments cannot be read', async () => {
        listRoster.mockResolvedValue([]);
        listAssignmentsForStudent.mockRejectedValue(new Error('Could not load assignments: offline'));
        renderAt('/students/s1');

        expect(await screen.findByRole('heading', { name: 'Tacet.' })).toBeInTheDocument();
        expect(screen.queryByText(/Could not load assignments/)).not.toBeInTheDocument();
    });

    it('asks only for this student’s assignments', async () => {
        renderAt('/students/s1');

        await screen.findAllByRole('listitem');
        expect(listAssignmentsForStudent).toHaveBeenCalledWith('s1-user');
    });

    it('drops an unassigned row even when the refresh after it fails', async () => {
        const user = userEvent.setup();
        renderAt('/students/s1');

        const item = within((await screen.findAllByRole('listitem'))[1]!);
        listRoster.mockRejectedValue(new Error('Could not load your roster: offline'));
        await user.click(item.getByRole('button', { name: 'Unassign' }));

        expect(await screen.findByText('Could not load your roster: offline')).toBeInTheDocument();
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
        expect(screen.queryByRole('link', { name: 'Minuet in G' })).not.toBeInTheDocument();
        expect(screen.getByText(/1 score\b/)).toBeInTheDocument();
    });

    it('shows the access a successful change set even when the refresh after it fails', async () => {
        const user = userEvent.setup();
        renderAt('/students/s1');

        const item = within((await screen.findAllByRole('listitem'))[0]!);
        listRoster.mockRejectedValue(new Error('Could not load your roster: offline'));
        await user.click(item.getByRole('button', { name: 'View' }));

        expect(await screen.findByText('Could not load your roster: offline')).toBeInTheDocument();
        expect(item.getByRole('button', { name: 'View' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('rewrites the roster’s cached count when a score is unassigned', async () => {
        await getDb().rosterCache.put({
            userId: 'teacher-1',
            students: [student('s1', 'Leo Martin')],
            assignmentCounts: [
                ['s1-user', 2],
                ['s2-user', 4],
            ],
            cachedAt: '2026-08-01T00:00:00Z',
        });
        const user = userEvent.setup();
        renderAt('/students/s1');

        const item = within((await screen.findAllByRole('listitem'))[1]!);
        listRoster.mockReturnValue(new Promise(() => undefined));
        await user.click(item.getByRole('button', { name: 'Unassign' }));

        await waitFor(async () => {
            const cached = await getDb().rosterCache.get('teacher-1');
            expect(new Map(cached?.assignmentCounts)).toEqual(
                new Map([
                    ['s1-user', 1],
                    ['s2-user', 4],
                ]),
            );
        });
        await getDb().rosterCache.clear();
    });
});
