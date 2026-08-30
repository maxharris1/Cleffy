import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LimitReachedError } from '@/features/billing/limitErrors';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { getDb } from '@/sync/db';
import { RosterPage } from '@/features/roster/RosterPage';
import type { RosterAssignment } from '@/features/roster/rosterService';
import type { ManagedStudentRow } from '@/types/database';

const listRoster = vi.fn();
const listAssignmentsForStudents = vi.fn();
const fetchStudentTimeline = vi.fn();
const provisionStudent = vi.fn();
const resetStudentAccess = vi.fn();
const archiveStudent = vi.fn();
const restoreStudent = vi.fn();
const assignScore = vi.fn();
const unassignScore = vi.fn();

vi.mock('@/features/roster/rosterService', () => ({
    listRoster: (...args: unknown[]) => listRoster(...args),
    listAssignmentsForStudents: (...args: unknown[]) => listAssignmentsForStudents(...args),
    fetchStudentTimeline: (...args: unknown[]) => fetchStudentTimeline(...args),
    provisionStudent: (...args: unknown[]) => provisionStudent(...args),
    resetStudentAccess: (...args: unknown[]) => resetStudentAccess(...args),
    archiveStudent: (...args: unknown[]) => archiveStudent(...args),
    restoreStudent: (...args: unknown[]) => restoreStudent(...args),
    assignScore: (...args: unknown[]) => assignScore(...args),
    unassignScore: (...args: unknown[]) => unassignScore(...args),
}));

/** A freshly provisioned code student: a card printed, nothing claimed yet. */
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
    ...overrides,
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

/** Opens the only row's action menu and picks the item with this label. */
const pickRowAction = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
    await user.click(await screen.findByRole('button', { name: 'Student actions' }));
    await user.click(screen.getByRole('menuitem', { name: label }));
};

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
            student('s1', 'Ada Lovelace', { username: 'ada_lovelace', claimed_at: '2026-08-02T00:00:00Z' }),
            student('s2', 'Bo Diddley', { archived_at: '2026-08-20T00:00:00Z' }),
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

    it('serves the cached roster with its counts when the network fails, error beside it', async () => {
        await getDb().rosterCache.put({
            userId: 'teacher-1',
            students: [student('s1', 'Ada Lovelace', { claimed_at: '2026-08-02T00:00:00Z' })],
            assignmentCounts: [['s1-user', 3]],
            cachedAt: '2026-08-29T00:00:00Z',
        });
        listRoster.mockRejectedValue(new Error('network down'));
        listAssignmentsForStudents.mockRejectedValue(new Error('network down'));
        try {
            const user = userEvent.setup();
            renderRoster();

            // The cached roster stays up, with the error beside it, not instead of it.
            expect(await screen.findByRole('button', { name: /Ada Lovelace/ })).toBeInTheDocument();
            expect(await screen.findByText('network down')).toBeInTheDocument();
            // Counts come from the snapshot rather than an affirmative "No scores".
            expect(screen.getByText('3 scores')).toBeInTheDocument();
            // The panel is terminal about the missing rows — never an eternal spinner.
            await user.click(screen.getByRole('button', { name: /Ada Lovelace/ }));
            expect(
                await screen.findByText('The assignment list couldn’t be loaded — the count is from the last sync.'),
            ).toBeInTheDocument();
            expect(screen.queryByText('Loading assignments…')).not.toBeInTheDocument();
        } finally {
            await getDb().rosterCache.clear();
        }
    });

    it('provisions a code student and shows the setup code once, on a printable card', async () => {
        const user = userEvent.setup();
        provisionStudent.mockResolvedValue({
            student: { id: 's1', studentUserId: 's1-user', displayName: 'Ada Lovelace' },
            loginCode: 'ABCD-EFGH-JKMN',
        });
        renderRoster();

        await user.type(await screen.findByLabelText('Student name'), 'Ada Lovelace');
        await user.type(screen.getByLabelText('Parent email (optional)'), 'parent@example.com');
        await user.click(screen.getByRole('button', { name: 'Add student' }));

        expect(provisionStudent).toHaveBeenCalledWith('Ada Lovelace', {
            parentEmail: 'parent@example.com',
            method: 'code',
        });
        const card = await screen.findByRole('dialog', { name: 'Setup card' });
        expect(within(card).getByText('ABCD-EFGH-JKMN')).toBeInTheDocument();
        expect(screen.getByLabelText('Student name')).toHaveValue('');
    });

    it('asks for the student’s own address only once the invite method is chosen', async () => {
        const user = userEvent.setup();
        provisionStudent.mockResolvedValue({
            student: { id: 's1', studentUserId: 's1-user', displayName: 'Ada Lovelace' },
            invited: true,
            studentEmail: 'ada@example.com',
        });
        renderRoster();

        await user.type(await screen.findByLabelText('Student name'), 'Ada Lovelace');
        expect(screen.queryByLabelText('Student email')).not.toBeInTheDocument();

        await user.click(screen.getByRole('radio', { name: /Email invite/ }));
        await user.type(screen.getByLabelText('Student email'), 'ada@example.com');
        await user.click(screen.getByRole('button', { name: 'Add student' }));

        // The parent's address stays independent of the student's own.
        expect(provisionStudent).toHaveBeenCalledWith('Ada Lovelace', {
            parentEmail: undefined,
            method: 'email',
            studentEmail: 'ada@example.com',
        });
        const sent = await screen.findByRole('dialog', { name: 'Invite sent' });
        expect(within(sent).getByText('ada@example.com')).toBeInTheDocument();
        expect(within(sent).getByText(/Archive this student and add them again/)).toBeInTheDocument();
    });

    it('will not send an invite without an address to send it to', async () => {
        const user = userEvent.setup();
        renderRoster();

        await user.type(await screen.findByLabelText('Student name'), 'Ada Lovelace');
        await user.click(screen.getByRole('radio', { name: /Email invite/ }));
        await user.click(screen.getByRole('button', { name: 'Add student' }));

        expect(screen.getByRole('status')).toHaveTextContent('Enter the student’s email address.');
        expect(provisionStudent).not.toHaveBeenCalled();
    });

    it('says who has not set up their account yet, and what everyone else types to sign in', async () => {
        listRoster.mockResolvedValue([
            student('s1', 'Ada Lovelace', { username: 'ada_lovelace', claimed_at: '2026-08-02T00:00:00Z' }),
            student('s2', 'Bo Diddley'),
            student('s3', 'Clara Schumann', {
                auth_method: 'email',
                student_email: 'clara@example.com',
                claimed_at: '2026-08-03T00:00:00Z',
            }),
        ]);
        renderRoster();

        const claimed = await screen.findByRole('button', { name: /Ada Lovelace/ });
        expect(claimed).toHaveTextContent('@ada_lovelace');
        expect(claimed).not.toHaveTextContent('Invited');
        // Nothing to type yet: the card is out but the code has not been spent.
        expect(screen.getByRole('button', { name: /Bo Diddley/ })).toHaveTextContent('Invited');
        expect(screen.getByRole('button', { name: /Clara Schumann/ })).toHaveTextContent('clara@example.com');
    });

    it('names the reset after what it does to this particular student', async () => {
        const user = userEvent.setup();
        listRoster.mockResolvedValue([student('s1', 'Bo Diddley')]);
        renderRoster();

        await user.click(await screen.findByRole('button', { name: 'Student actions' }));
        expect(screen.getByRole('menuitem', { name: 'New setup code…' })).toBeInTheDocument();
        expect(screen.queryByRole('menuitem', { name: 'Reset access…' })).not.toBeInTheDocument();
    });

    it('resets a claimed code student and prints a card carrying the username they keep', async () => {
        const user = userEvent.setup();
        listRoster.mockResolvedValue([
            student('s1', 'Ada Lovelace', { username: 'ada_lovelace', claimed_at: '2026-08-02T00:00:00Z' }),
        ]);
        resetStudentAccess.mockResolvedValue({ loginCode: 'PQRS-TUVW-XYZ2', username: 'ada_lovelace' });
        renderRoster();

        await pickRowAction(user, 'Reset access…');
        // The confirmation has to say the password stops working, not just the code.
        const confirm = await screen.findByRole('dialog', { name: 'Reset this student’s access?' });
        expect(within(confirm).getByText(/password stops working straight away/)).toBeInTheDocument();
        await user.click(within(confirm).getByRole('button', { name: 'Reset access' }));

        expect(resetStudentAccess).toHaveBeenCalledWith('s1');
        const card = await screen.findByRole('dialog', { name: 'Setup card' });
        expect(within(card).getByText('PQRS-TUVW-XYZ2')).toBeInTheDocument();
        expect(within(card).getByText('ada_lovelace')).toBeInTheDocument();
    });

    it('takes the confirmation down before the code goes up, however slow the reload is', async () => {
        // The code is shown once and stored as a hash, so the window between
        // issuing it and the roster coming back must not leave a second dialog
        // over it — Escape there would land on the card and destroy the code.
        const user = userEvent.setup();
        let releaseReload: (rows: ManagedStudentRow[]) => void = () => {};
        listRoster.mockResolvedValueOnce([student('s1', 'Bo Diddley')]).mockImplementationOnce(
            () =>
                new Promise<ManagedStudentRow[]>((resolve) => {
                    releaseReload = resolve;
                }),
        );
        resetStudentAccess.mockResolvedValue({ loginCode: 'PQRS-TUVW-XYZ2', username: null });
        renderRoster();

        await pickRowAction(user, 'New setup code…');
        await user.click(
            within(await screen.findByRole('dialog', { name: 'Issue a new setup code?' })).getByRole('button', {
                name: 'New code',
            }),
        );

        const card = await screen.findByRole('dialog', { name: 'Setup card' });
        expect(within(card).getByText('PQRS-TUVW-XYZ2')).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Issue a new setup code?' })).not.toBeInTheDocument();

        // Let the held reload land rather than ending the test mid-update.
        await act(async () => {
            releaseReload([student('s1', 'Bo Diddley')]);
        });
    });

    it('resets an email student by sending another link, and says where it went', async () => {
        const user = userEvent.setup();
        listRoster.mockResolvedValue([
            student('s1', 'Clara Schumann', {
                auth_method: 'email',
                student_email: 'clara@example.com',
                claimed_at: '2026-08-03T00:00:00Z',
            }),
        ]);
        resetStudentAccess.mockResolvedValue({ invited: true, studentEmail: 'clara@example.com' });
        renderRoster();

        await pickRowAction(user, 'Email a new sign-in link…');
        await user.click(
            within(await screen.findByRole('dialog', { name: 'Email a new sign-in link?' })).getByRole('button', {
                name: 'Send link',
            }),
        );

        expect(resetStudentAccess).toHaveBeenCalledWith('s1');
        const sent = await screen.findByRole('dialog', { name: 'Invite sent' });
        expect(within(sent).getByText('clara@example.com')).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Setup card' })).not.toBeInTheDocument();
    });

    it('offers an upgrade instead of an error when the server refuses the roster', async () => {
        // A teacher whose plan lapsed mid-session still has the page open: the
        // refusal arrives from the server, not from a client-side check.
        const user = userEvent.setup();
        provisionStudent.mockRejectedValue(
            new LimitReachedError({ code: 'limit_reached', metric: 'students', limit: 0, tier: 'free' }),
        );
        renderRoster();

        await user.type(await screen.findByLabelText('Student name'), 'Ada Lovelace');
        await user.click(screen.getByRole('button', { name: 'Add student' }));

        expect(await screen.findByText(/doesn’t include a student roster/)).toBeInTheDocument();
        // The typed name survives, so upgrading and pressing Add again costs nothing.
        expect(screen.getByLabelText('Student name')).toHaveValue('Ada Lovelace');

        await user.click(screen.getByRole('button', { name: 'See plans' }));
        expect(openPricing).toHaveBeenCalled();
    });

    it('keeps the roster and its archive action on a plan that no longer includes students', async () => {
        // Downgrading bans nobody: the students already provisioned keep signing
        // in, and archiving is the only thing that stops one — so the rows have
        // to outlive the plan that paid for them.
        const user = userEvent.setup();
        outletContext.canManageStudents = false;
        listRoster.mockResolvedValue([
            student('s1', 'Ada Lovelace', { username: 'ada_lovelace', claimed_at: '2026-08-02T00:00:00Z' }),
        ]);
        archiveStudent.mockResolvedValue(undefined);
        try {
            renderRoster();

            expect(await screen.findByRole('button', { name: /Ada Lovelace/ })).toBeInTheDocument();
            // The add form still goes: the server refuses every submission.
            expect(screen.queryByLabelText('Student name')).not.toBeInTheDocument();
            expect(screen.getByRole('status')).toHaveTextContent('Your plan doesn’t include a student roster');

            await pickRowAction(user, 'Archive…');
            await user.click(screen.getByRole('button', { name: 'Archive' }));
            expect(archiveStudent).toHaveBeenCalledWith('s1');
        } finally {
            outletContext.canManageStudents = true;
        }
    });

    it('answers a refused Restore with one notice, not a second copy of the one already up', async () => {
        // METRIC_COPY.students interpolates neither the limit nor the tier, so the
        // 402 renders the same sentence the standing notice already shows. Two of
        // them stacks two amber boxes and two `status` regions, and makes the
        // refusal invisible: the only feedback was on screen before the click.
        const user = userEvent.setup();
        outletContext.canManageStudents = false;
        listRoster.mockResolvedValue([student('s1', 'Ada Lovelace', { archived_at: '2026-08-02T00:00:00Z' })]);
        restoreStudent.mockRejectedValue(
            new LimitReachedError({ code: 'limit_reached', metric: 'students', limit: 0, tier: 'free' }),
        );
        try {
            renderRoster();

            expect(await screen.findByRole('button', { name: /Ada Lovelace/ })).toBeInTheDocument();
            expect(screen.getAllByRole('status')).toHaveLength(1);

            await pickRowAction(user, 'Restore');
            await waitFor(() => expect(restoreStudent).toHaveBeenCalledWith('s1'));

            expect(screen.getAllByRole('status')).toHaveLength(1);
            expect(screen.getAllByRole('button', { name: 'See plans' })).toHaveLength(1);
        } finally {
            outletContext.canManageStudents = true;
        }
    });

    it('does not caption the Add button "Adding…" while an unrelated action runs', async () => {
        // `busy` is one flag for every roster action, and it rightly disables this
        // form — two mutations should not overlap. The caption is the part that
        // must not be shared: a teacher archiving a student was told the page was
        // adding one.
        const user = userEvent.setup();
        let releaseArchive: () => void = () => {};
        listRoster.mockResolvedValue([student('s1', 'Ada Lovelace')]);
        archiveStudent.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    releaseArchive = resolve;
                }),
        );
        renderRoster();

        expect(await screen.findByRole('button', { name: /Ada Lovelace/ })).toBeInTheDocument();
        await pickRowAction(user, 'Archive…');
        await user.click(screen.getByRole('button', { name: 'Archive' }));

        // The archive is still in flight: the form is disabled, but it is not the
        // thing that is running.
        const add = screen.getByRole('button', { name: 'Add student' });
        expect(add).toBeDisabled();
        expect(screen.queryByRole('button', { name: 'Adding…' })).not.toBeInTheDocument();

        await act(async () => {
            releaseArchive();
        });
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
