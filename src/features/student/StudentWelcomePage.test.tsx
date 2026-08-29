import type { Session } from '@supabase/supabase-js';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as sessionModule from '@/features/auth/session';
import { StudentWelcomePage } from '@/features/student/StudentWelcomePage';

const updatePassword = vi.fn();
const rpc = vi.fn();

let session: Session | null = null;

vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<typeof sessionModule>()),
    useSession: () => ({ session, loading: false, lastEvent: null }),
    updatePassword: (...args: unknown[]) => updatePassword(...args),
}));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({ rpc: (...args: unknown[]) => rpc(...args) }),
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

    it('greets the student by the name their teacher gave them', () => {
        renderWelcome();
        expect(screen.getByText(/Hi Ada Lovelace/)).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Choose your password' })).toBeInTheDocument();
    });

    it('will not save a password the student did not type the same way twice', async () => {
        const user = userEvent.setup();
        renderWelcome();

        await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
        await user.type(screen.getByLabelText('Confirm password'), 'hunter2hunter3');
        await user.click(screen.getByRole('button', { name: 'Save password' }));

        expect(screen.getByRole('status')).toHaveTextContent('Passwords do not match.');
        expect(updatePassword).not.toHaveBeenCalled();
    });

    it('sets the password, marks the roster row claimed, and opens the assignments', async () => {
        const user = userEvent.setup();
        renderWelcome();

        await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
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

        await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
        await user.type(screen.getByLabelText('Confirm password'), 'hunter2hunter2');
        await user.click(screen.getByRole('button', { name: 'Save password' }));

        // Their password is already changed: being stopped here would be a lie
        // about an account that works.
        expect(await screen.findByText('your pieces')).toBeInTheDocument();
    });
});
