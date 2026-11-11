import type { Session } from '@supabase/supabase-js';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as sessionModule from '@/features/auth/session';
import { AssignmentsPage, ASSIGNMENTS_REFRESH_MS } from '@/features/student/AssignmentsPage';
import type { AssignedScore } from '@/features/student/studentApi';
import { getDb } from '@/sync/db';
import type { AssignmentRow, ManagedStudentRow } from '@/types/database';

const fetchMyAssignments = vi.fn();
const fetchMyRosterProfile = vi.fn();
const fetchSignInStillValid = vi.fn();
const signOut = vi.fn();
const signOutKeepingChanges = vi.fn();
const signOutDeletedAccount = vi.fn();

vi.mock('@/features/student/studentApi', () => ({
    fetchMyAssignments: (...args: unknown[]) => fetchMyAssignments(...args),
    fetchMyRosterProfile: (...args: unknown[]) => fetchMyRosterProfile(...args),
    fetchSignInStillValid: (...args: unknown[]) => fetchSignInStillValid(...args),
}));

// userTypeOf and displayNameOf stay real: the gate below is the page's own.
vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<typeof sessionModule>()),
    useSession: () => ({ session: studentSession, loading: false, lastEvent: null }),
    signOut: (...args: unknown[]) => signOut(...args),
    signOutKeepingChanges: (...args: unknown[]) => signOutKeepingChanges(...args),
    signOutDeletedAccount: (...args: unknown[]) => signOutDeletedAccount(...args),
    syncBeforeSignOut: async () => ({ pending: 0, refused: 0 }),
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
        thumb_rev: null,
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
    auth_method: 'code',
    username: 'ada_lovelace',
    student_email: null,
    claimed_at: '2026-08-02T00:00:00Z',
    archived_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    country: null,
    age_attested_at: null,
    age_attested_min_age: null,
});

/** Stands in for the login page, showing what it was told. */
const StudentLoginStub = () => {
    const location = useLocation();
    const told = (location.state as { signedOutByTeacher?: boolean } | null)?.signedOutByTeacher;
    return <p>{told ? 'student login (signed out by teacher)' : 'student login'}</p>;
};

const renderAssignments = () =>
    render(
        <MemoryRouter initialEntries={['/assignments']}>
            <Routes>
                <Route path="/assignments" element={<AssignmentsPage />} />
                <Route path="/student" element={<StudentLoginStub />} />
            </Routes>
        </MemoryRouter>,
    );

beforeEach(() => {
    vi.clearAllMocks();
    fetchMyAssignments.mockResolvedValue([]);
    fetchMyRosterProfile.mockResolvedValue(null);
    fetchSignInStillValid.mockResolvedValue(true);
    signOut.mockResolvedValue(undefined);
    signOutKeepingChanges.mockResolvedValue(0);
    signOutDeletedAccount.mockResolvedValue(0);
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
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

    it('picks up a piece assigned while the page is open, when the student comes back to it', async () => {
        renderAssignments();
        expect(await screen.findByRole('heading', { name: 'Nothing here yet' })).toBeInTheDocument();

        fetchMyAssignments.mockResolvedValue([assigned('doc-9', 'Für Elise')]);
        await act(async () => {
            fireEvent.focus(window);
        });

        expect(await screen.findByRole('link', { name: /Für Elise/ })).toHaveAttribute('href', '/doc/doc-9');
    });

    it('re-reads the list on a timer while it stays open', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        renderAssignments();
        expect(await screen.findByRole('heading', { name: 'Nothing here yet' })).toBeInTheDocument();
        const reads = fetchMyAssignments.mock.calls.length;

        fetchMyAssignments.mockResolvedValue([assigned('doc-9', 'Für Elise')]);
        await act(async () => {
            vi.advanceTimersByTime(ASSIGNMENTS_REFRESH_MS);
        });

        expect(await screen.findByRole('link', { name: /Für Elise/ })).toBeInTheDocument();
        expect(fetchMyAssignments.mock.calls.length).toBe(reads + 1);
    });

    it('signs out, and says why, once the teacher has ended this sign-in', async () => {
        // An archived or reset student's token still reads — it just reads nothing.
        fetchMyRosterProfile.mockResolvedValue({ ...rosterRow('Ada'), archived_at: '2026-10-10T00:00:00Z' });
        fetchSignInStillValid.mockResolvedValue(false);
        renderAssignments();

        expect(await screen.findByText('student login (signed out by teacher)')).toBeInTheDocument();
        // The account is still there: what it queued here waits for its next sign-in.
        expect(signOutKeepingChanges).toHaveBeenCalled();
        expect(signOut).not.toHaveBeenCalled();
        expect(screen.queryByRole('heading', { name: 'Nothing here yet' })).not.toBeInTheDocument();
    });

    it('signs a deleted student’s leftover session out for good', async () => {
        fetchMyRosterProfile.mockResolvedValue(null);
        fetchSignInStillValid.mockResolvedValue(false);
        renderAssignments();

        expect(await screen.findByText('student login (signed out by teacher)')).toBeInTheDocument();
        expect(signOutDeletedAccount).toHaveBeenCalled();
        expect(signOutKeepingChanges).not.toHaveBeenCalled();
    });

    it('paints the cached list while the server answers', async () => {
        await getDb().assignmentsCache.put({
            userId: 'student-1',
            scores: [assigned('doc-1', 'Prelude and Fugue')],
            cachedAt: '2026-10-10T00:00:00Z',
        });
        fetchMyAssignments.mockReturnValue(new Promise(() => undefined));
        renderAssignments();

        expect(await screen.findByRole('link', { name: /Prelude and Fugue/ })).toBeInTheDocument();
        await getDb().assignmentsCache.clear();
    });

    it('drops a cached list it cannot read instead of crashing on it, and shows the server’s', async () => {
        // An older build's row, or a damaged one: painting it threw before the
        // fresh list could replace it, on every reload.
        await getDb().assignmentsCache.put({
            userId: 'student-1',
            scores: [{ assignment: null, document: null }] as never,
            cachedAt: '2026-10-10T00:00:00Z',
        });
        // Slower than IndexedDB, as on a phone: the cache is what paints first.
        fetchMyAssignments.mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve([assigned('doc-1', 'Prelude and Fugue')]), 50)),
        );
        renderAssignments();

        expect(await screen.findByRole('link', { name: /Prelude and Fugue/ })).toBeInTheDocument();
        await vi.waitFor(async () =>
            expect((await getDb().assignmentsCache.get('student-1'))?.scores[0]?.document.title).toBe(
                'Prelude and Fugue',
            ),
        );
        await getDb().assignmentsCache.clear();
    });

    it('drops an unreadable cached list even when the server cannot be reached', async () => {
        await getDb().assignmentsCache.put({
            userId: 'student-1',
            scores: 'not a list' as never,
            cachedAt: '2026-10-10T00:00:00Z',
        });
        fetchMyAssignments.mockRejectedValue(new Error('offline'));
        renderAssignments();

        expect(await screen.findByText(/Could not load your pieces/)).toBeInTheDocument();
        await vi.waitFor(async () => expect(await getDb().assignmentsCache.count()).toBe(0));
    });

    it('shows a long title whole on hover, and lets it run to two lines', async () => {
        const title = 'Piano Sonata No. 16 in C major, K 545: First Movement, Allegro';
        fetchMyAssignments.mockResolvedValue([assigned('doc-1', title)]);
        renderAssignments();

        const link = await screen.findByRole('link', { name: new RegExp(title) });
        const shown = within(link).getByText(title);
        expect(shown).toHaveAttribute('title', title);
        expect(shown).toHaveClass('line-clamp-2');
        expect(shown).not.toHaveClass('truncate');
    });

    it('keeps the list up when the sign-in check cannot reach the server', async () => {
        fetchMyAssignments.mockResolvedValue([assigned('doc-1', 'Prelude and Fugue')]);
        fetchSignInStillValid.mockResolvedValue(null);
        renderAssignments();

        expect(await screen.findByRole('link', { name: /Prelude and Fugue/ })).toBeInTheDocument();
        expect(signOut).not.toHaveBeenCalled();
    });
});
