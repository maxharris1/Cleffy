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
const deleteStudent = vi.fn();
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
    deleteStudent: (...args: unknown[]) => deleteStudent(...args),
    attestationFor: (country: string, countryName: string) => ({ country, countryName, attested: true }),
    attestationProblem: (country: string, confirmed: boolean) =>
        !country
            ? 'Choose the country the student lives in.'
            : !confirmed
              ? 'Confirm the student meets the minimum age for their country.'
              : null,
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
    country: null,
    age_attested_at: null,
    age_attested_min_age: null,
    ...overrides,
});

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
};

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

/** The age attestation, as the add form and the restore dialog both ask it. */
const attest = async (user: ReturnType<typeof userEvent.setup>, scope: HTMLElement = document.body) => {
    await user.selectOptions(within(scope).getByLabelText('Student’s country'), 'DE');
    await user.click(within(scope).getByRole('checkbox', { name: /at least 16 years old/ }));
};

const ATTESTED = { country: 'DE', countryName: 'Germany', attested: true };

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

    it('gives an assigned score’s title its own line on a phone, with the full title on hover', async () => {
        // At 390px the title shared a row with the due date, the Edit/View
        // switch and Unassign, and a real title read "Sona…".
        const user = userEvent.setup();
        listRoster.mockResolvedValue([
            student('s1', 'Ada Lovelace', { username: 'ada_lovelace', claimed_at: '2026-08-02T00:00:00Z' }),
        ]);
        const title = 'Piano Sonata No. 14 in C-sharp minor, Op. 27 No. 2 (Moonlight)';
        listAssignmentsForStudents.mockResolvedValue(
            new Map([['s1-user', [rosterAssignment('doc-1', title, 's1-user')]]]),
        );
        renderRoster();

        await user.click(await screen.findByRole('button', { name: /Ada Lovelace/ }));
        const link = await screen.findByRole('link', { name: title });
        expect(link).toHaveAttribute('title', title);
        expect(link.className).toMatch(/(^| )basis-full( |$)/);
        expect(link.className).toMatch(/(^| )sm:flex-1( |$)/);
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
        await attest(user);
        await user.click(screen.getByRole('button', { name: 'Add student' }));

        expect(provisionStudent).toHaveBeenCalledWith('Ada Lovelace', {
            parentEmail: 'parent@example.com',
            method: 'code',
            attestation: ATTESTED,
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
        await attest(user);
        await user.click(screen.getByRole('button', { name: 'Add student' }));

        // The parent's address stays independent of the student's own.
        expect(provisionStudent).toHaveBeenCalledWith('Ada Lovelace', {
            parentEmail: undefined,
            method: 'email',
            studentEmail: 'ada@example.com',
            attestation: ATTESTED,
        });
        const sent = await screen.findByRole('dialog', { name: 'Invite sent' });
        expect(within(sent).getByText('ada@example.com')).toBeInTheDocument();
        expect(within(sent).getByText(/Archive this student and add them again/)).toBeInTheDocument();
    });

    it('will not add a student until the teacher vouches for their age', async () => {
        const user = userEvent.setup();
        renderRoster();

        await user.type(await screen.findByLabelText('Student name'), 'Ada Lovelace');
        await user.click(screen.getByRole('button', { name: 'Add student' }));
        expect(screen.getByRole('status')).toHaveTextContent('Choose the country the student lives in.');

        await user.selectOptions(screen.getByLabelText('Student’s country'), 'FR');
        // The sentence names that country's age, not a fixed one.
        expect(screen.getByRole('checkbox', { name: /at least 15 years old/ })).not.toBeChecked();
        await user.click(screen.getByRole('button', { name: 'Add student' }));
        expect(screen.getByRole('status')).toHaveTextContent(
            'Confirm the student meets the minimum age for their country.',
        );
        expect(provisionStudent).not.toHaveBeenCalled();
    });

    it('restores only with a fresh attestation, starting from the country on file', async () => {
        const user = userEvent.setup();
        restoreStudent.mockResolvedValue(undefined);
        listRoster.mockResolvedValue([
            student('s1', 'Ada Lovelace', {
                archived_at: '2026-08-02T00:00:00Z',
                country: 'DE',
                age_attested_at: '2026-08-01T00:00:00Z',
                age_attested_min_age: 16,
            }),
        ]);
        renderRoster();

        await pickRowAction(user, 'Restore…');
        const dialog = await screen.findByRole('dialog', { name: 'Restore this student?' });
        expect(within(dialog).getByLabelText('Student’s country')).toHaveValue('DE');
        await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
        expect(within(dialog).getByRole('status')).toHaveTextContent('Confirm the student meets the minimum age');
        expect(restoreStudent).not.toHaveBeenCalled();

        await user.click(within(dialog).getByRole('checkbox', { name: /at least 16 years old/ }));
        await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
        await waitFor(() => expect(restoreStudent).toHaveBeenCalledWith('s1', ATTESTED));
    });

    it('deletes a student only after a warning that says what goes with them', async () => {
        const user = userEvent.setup();
        deleteStudent.mockResolvedValue(undefined);
        listRoster.mockResolvedValueOnce([student('s1', 'Ada Lovelace')]).mockResolvedValue([]);
        renderRoster();

        await pickRowAction(user, 'Delete student…');
        const dialog = await screen.findByRole('dialog', { name: 'Delete this student?' });
        expect(dialog).toHaveTextContent(/every mark they made on your scores/);
        expect(dialog).toHaveTextContent(/can’t be undone/);
        expect(deleteStudent).not.toHaveBeenCalled();

        await user.click(within(dialog).getByRole('button', { name: 'Delete student' }));
        await waitFor(() => expect(deleteStudent).toHaveBeenCalledWith('s1'));
        expect(await screen.findByText(/No students yet/)).toBeInTheDocument();
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
        // ...and the devices already signed in, which student-provision now ends too.
        expect(within(confirm).getByText(/any device they are signed in on is signed out/)).toBeInTheDocument();
        // They may claim the new code into a different username.
        expect(within(confirm).queryByText(/keep their username/)).not.toBeInTheDocument();
        await user.click(within(confirm).getByRole('button', { name: 'Reset access' }));

        expect(resetStudentAccess).toHaveBeenCalledWith('s1');
        const card = await screen.findByRole('dialog', { name: 'Setup card' });
        expect(within(card).getByText('PQRS-TUVW-XYZ2')).toBeInTheDocument();
        expect(within(card).getByText('ada_lovelace')).toBeInTheDocument();
    });

    it('tells the teacher a failed reset holds the student’s card for up to 10 minutes', async () => {
        const user = userEvent.setup();
        listRoster.mockResolvedValue([
            student('s1', 'Ada Lovelace', { username: 'ada_lovelace', claimed_at: '2026-08-02T00:00:00Z' }),
        ]);
        resetStudentAccess.mockRejectedValue(
            new Error(
                'The reset did not finish. The student’s current card is held for up to 10 minutes, so it cannot be used meanwhile. Try the reset again.',
            ),
        );
        renderRoster();

        await pickRowAction(user, 'Reset access…');
        const confirm = await screen.findByRole('dialog', { name: 'Reset this student’s access?' });
        await user.click(within(confirm).getByRole('button', { name: 'Reset access' }));

        expect(await screen.findByText(/held for up to 10 minutes/)).toBeInTheDocument();
        expect(screen.queryByRole('dialog', { name: 'Setup card' })).not.toBeInTheDocument();
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
        await attest(user);
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

    it('rewrites the roster snapshot after an action so a remount does not resurrect the old roster', async () => {
        const user = userEvent.setup();
        const active = student('s1', 'Ada Lovelace', { username: 'ada_lovelace', claimed_at: '2026-08-02T00:00:00Z' });
        const archived = { ...active, archived_at: '2026-08-30T00:00:00Z' };
        listRoster.mockResolvedValueOnce([active]).mockResolvedValueOnce([archived]);
        listAssignmentsForStudents.mockResolvedValue(
            new Map([['s1-user', [rosterAssignment('doc-1', 'Prelude and Fugue', 's1-user')]]]),
        );
        archiveStudent.mockResolvedValue(undefined);
        try {
            renderRoster();
            expect(await screen.findByRole('button', { name: /Ada Lovelace/ })).toBeInTheDocument();
            await waitFor(async () => {
                const row = await getDb().rosterCache.get('teacher-1');
                expect(row?.students[0]?.archived_at).toBeNull();
            });

            await pickRowAction(user, 'Archive…');
            await user.click(screen.getByRole('button', { name: 'Archive' }));

            await waitFor(async () => {
                const row = await getDb().rosterCache.get('teacher-1');
                expect(row?.students[0]?.archived_at).toBe('2026-08-30T00:00:00Z');
                // The counts ride along; the snapshot is not blanked by the rewrite.
                expect(row?.assignmentCounts).toEqual([['s1-user', 1]]);
            });
        } finally {
            await getDb().rosterCache.clear();
        }
    });

    it('does not let a late mount listRoster resurrect a student archived after cache paint', async () => {
        const user = userEvent.setup();
        const active = student('s1', 'Ada Lovelace', { username: 'ada_lovelace', claimed_at: '2026-08-02T00:00:00Z' });
        const archived = { ...active, archived_at: '2026-08-30T00:00:00Z' };
        await getDb().rosterCache.put({
            userId: 'teacher-1',
            students: [active],
            assignmentCounts: [],
            cachedAt: '2026-08-29T00:00:00Z',
        });
        const mountRoster = deferred<ManagedStudentRow[]>();
        listRoster.mockReturnValueOnce(mountRoster.promise).mockResolvedValueOnce([archived]);
        listAssignmentsForStudents.mockResolvedValue(new Map());
        archiveStudent.mockResolvedValue(undefined);
        try {
            renderRoster();
            expect(await screen.findByRole('button', { name: /Ada Lovelace/ })).toBeInTheDocument();

            await pickRowAction(user, 'Archive…');
            await user.click(screen.getByRole('button', { name: 'Archive' }));
            expect(archiveStudent).toHaveBeenCalledWith('s1');
            await waitFor(() =>
                expect(screen.getByRole('button', { name: /Ada Lovelace/ })).toHaveTextContent('Archived'),
            );

            await act(async () => {
                mountRoster.resolve([active]);
            });
            await new Promise((r) => setTimeout(r, 20));
            expect(screen.getByRole('button', { name: /Ada Lovelace/ })).toHaveTextContent('Archived');
        } finally {
            await getDb().rosterCache.clear();
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

            await pickRowAction(user, 'Restore…');
            const dialog = await screen.findByRole('dialog', { name: 'Restore this student?' });
            await attest(user, dialog);
            await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
            await waitFor(() => expect(restoreStudent).toHaveBeenCalledWith('s1', ATTESTED));

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
