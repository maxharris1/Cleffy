import type { Session } from '@supabase/supabase-js';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as sessionModule from '@/features/auth/session';
import { StudentWelcomePage } from '@/features/student/StudentWelcomePage';

const updatePassword = vi.fn();
const rpc = vi.fn();
/** The `managed_students` row the page reads back for whoever is signed in. */
const rosterRow = vi.fn();
let queriedUserId: string | null = null;

let session: Session | null = null;

vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<typeof sessionModule>()),
    useSession: () => ({ session, loading: false, lastEvent: null }),
    updatePassword: (...args: unknown[]) => updatePassword(...args),
}));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        rpc: (...args: unknown[]) => rpc(...args),
        from: () => ({
            select: () => ({
                eq: (_column: string, value: string) => {
                    queriedUserId = value;
                    return { is: () => ({ maybeSingle: () => rosterRow() }) };
                },
            }),
        }),
    }),
}));

// What supabase-js has already hydrated out of the invite link's fragment by the
// time this page renders — display_name is set by student-provision, and so is
// the app_metadata flag, on the invited auth user before the mail goes out.
const invitedSession = {
    user: {
        id: 'student-1',
        app_metadata: { user_type: 'student' },
        user_metadata: { display_name: 'Ada Lovelace' },
    },
} as unknown as Session;

// Whoever was already signed in on this browser when the link was opened. Not a
// hypothetical: a dead invite link leaves the stored session exactly as it was.
const teacherSession = {
    user: { id: 'teacher-1', app_metadata: {}, user_metadata: { display_name: 'Ms Teacher' } },
} as unknown as Session;

// The harder half of the same hazard: an elder sibling, taught by the same
// teacher, signed in on the same iPad. `user_type` cannot tell them apart —
// only their roster row can.
const siblingSession = {
    user: {
        id: 'student-2',
        app_metadata: { user_type: 'student' },
        user_metadata: { display_name: 'Byron Lovelace' },
    },
} as unknown as Session;

const renderWelcome = () =>
    render(
        <MemoryRouter initialEntries={['/student/welcome']}>
            <Routes>
                <Route path="/student/welcome" element={<StudentWelcomePage />} />
                <Route path="/student" element={<p>sign in</p>} />
                <Route path="/assignments" element={<p>your pieces</p>} />
            </Routes>
        </MemoryRouter>,
    );

const order: string[] = [];

beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    session = invitedSession;
    queriedUserId = null;
    // Provisioned and invited, no password chosen yet — the one state this page
    // is for.
    rosterRow.mockResolvedValue({ data: { claimed_at: null }, error: null });
    updatePassword.mockImplementation(async () => {
        order.push('password');
    });
    rpc.mockImplementation(async () => {
        order.push('claimed');
        return { data: null, error: null };
    });
});

afterEach(() => {
    cleanup();
});

describe('StudentWelcomePage', () => {
    it('explains a link that no longer works and points at the only door left', () => {
        session = null;
        renderWelcome();

        expect(
            screen.getByText('That link has expired or was already used — ask your teacher to send a new one.'),
        ).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/student');
        expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    });

    it('refuses to set a password on a session the invite link did not create', () => {
        // The form below writes onto the CURRENT session, so a link that failed
        // to hydrate must not fall through to whoever this browser already had:
        // that is the teacher's password being replaced by their pupil.
        session = teacherSession;
        renderWelcome();

        expect(
            screen.getByText('That link has expired or was already used — ask your teacher to send a new one.'),
        ).toBeInTheDocument();
        expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
        expect(updatePassword).not.toHaveBeenCalled();
    });

    it('refuses to set a password on a sibling who is already signed in here', async () => {
        // The teacher case above is the easy half. This one carries user_type
        // 'student' and would pass any check the flag can make, so what has to
        // separate them is that Byron already chose a password: his row is
        // claimed, and this page is only ever for a row that is not.
        session = siblingSession;
        rosterRow.mockResolvedValue({ data: { claimed_at: '2026-08-02T00:00:00Z' }, error: null });
        renderWelcome();

        expect(
            await screen.findByText('That link has expired or was already used — ask your teacher to send a new one.'),
        ).toBeInTheDocument();
        expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
        expect(updatePassword).not.toHaveBeenCalled();
        // Read for whoever is actually signed in, never for the invitee the link
        // named — that identity is the whole thing in question.
        expect(queriedUserId).toBe('student-2');
    });

    it('refuses rather than guesses when the roster row cannot be read', async () => {
        // Failing open here would be the same password overwrite, reached by a
        // dropped request instead of a stale session. A reload is the cost.
        rosterRow.mockResolvedValue({ data: null, error: { message: 'network down' } });
        renderWelcome();

        expect(
            await screen.findByText('That link has expired or was already used — ask your teacher to send a new one.'),
        ).toBeInTheDocument();
        expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    });

    it('greets the student by the name their teacher gave them', async () => {
        renderWelcome();
        expect(await screen.findByText(/Hi Ada Lovelace/)).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Choose your password' })).toBeInTheDocument();
    });

    it('will not save a password the student did not type the same way twice', async () => {
        const user = userEvent.setup();
        renderWelcome();

        await user.type(await screen.findByLabelText('Password'), 'hunter2hunter2');
        await user.type(screen.getByLabelText('Confirm password'), 'hunter2hunter3');
        await user.click(screen.getByRole('button', { name: 'Save password' }));

        expect(screen.getByRole('status')).toHaveTextContent('Passwords do not match.');
        expect(updatePassword).not.toHaveBeenCalled();
    });

    it('sets the password, marks the roster row claimed, and opens the assignments', async () => {
        const user = userEvent.setup();
        renderWelcome();

        await user.type(await screen.findByLabelText('Password'), 'hunter2hunter2');
        await user.type(screen.getByLabelText('Confirm password'), 'hunter2hunter2');
        await user.click(screen.getByRole('button', { name: 'Save password' }));

        expect(await screen.findByText('your pieces')).toBeInTheDocument();
        expect(updatePassword).toHaveBeenCalledWith('hunter2hunter2');
        expect(rpc).toHaveBeenCalledWith('mark_student_claimed');
        // The badge can only be honest after the password exists, never before.
        expect(order).toEqual(['password', 'claimed']);
    });

    it('lets the student in even when the roster badge could not be updated', async () => {
        const user = userEvent.setup();
        rpc.mockRejectedValue(new Error('network down'));
        renderWelcome();

        await user.type(await screen.findByLabelText('Password'), 'hunter2hunter2');
        await user.type(screen.getByLabelText('Confirm password'), 'hunter2hunter2');
        await user.click(screen.getByRole('button', { name: 'Save password' }));

        // Their password is already changed: being stopped here would be a lie
        // about an account that works.
        expect(await screen.findByText('your pieces')).toBeInTheDocument();
    });
});
