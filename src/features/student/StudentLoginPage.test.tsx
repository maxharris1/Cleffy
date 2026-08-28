import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as sessionModule from '@/features/auth/session';
import { StudentLoginPage } from '@/features/student/StudentLoginPage';

const loginStudent = vi.fn();

vi.mock('@/features/student/studentApi', () => ({
    loginStudent: (...args: unknown[]) => loginStudent(...args),
}));

// Nobody is signed in on this page by definition — it is the page that gets a
// student a session. userTypeOf stays real so that contract is exercised.
vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<typeof sessionModule>()),
    useSession: () => ({ session: null, loading: false, lastEvent: null }),
}));

const renderLogin = () =>
    render(
        <MemoryRouter initialEntries={['/student']}>
            <Routes>
                <Route path="/student" element={<StudentLoginPage />} />
                <Route path="/assignments" element={<p>your pieces</p>} />
            </Routes>
        </MemoryRouter>,
    );

beforeEach(() => {
    vi.clearAllMocks();
    loginStudent.mockResolvedValue('Ada Lovelace');
});

afterEach(() => {
    cleanup();
});

describe('StudentLoginPage', () => {
    it('takes one identifier and a password, and points at the ways in it does not own', () => {
        renderLogin();
        expect(screen.getByLabelText('Username or email')).toBeInTheDocument();
        expect(screen.getByLabelText('Password')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: /setup code/ })).toHaveAttribute('href', '/student/claim');
        expect(screen.getByRole('link', { name: /Forgot your password/ })).toHaveAttribute('href', '/forgot-password');
        expect(screen.getByRole('link', { name: 'I am a teacher' })).toHaveAttribute('href', '/login');
        // A student account exists because a teacher made it; there is nothing to register.
        expect(screen.queryByRole('link', { name: /Create one/ })).not.toBeInTheDocument();
    });

    it('sends the identifier exactly as typed and opens the assignments', async () => {
        const user = userEvent.setup();
        renderLogin();

        await user.type(screen.getByLabelText('Username or email'), '  Ada_Lovelace ');
        await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
        await user.click(screen.getByRole('button', { name: 'Open my music' }));

        // Unnormalized on purpose: the server folds case and space itself.
        expect(loginStudent).toHaveBeenCalledWith('  Ada_Lovelace ', 'hunter2hunter2');
        expect(await screen.findByText('your pieces')).toBeInTheDocument();
    });

    it('asks for both fields instead of calling the server with nothing', async () => {
        const user = userEvent.setup();
        renderLogin();

        await user.type(screen.getByLabelText('Username or email'), 'ada_lovelace');
        await user.click(screen.getByRole('button', { name: 'Open my music' }));

        expect(screen.getByRole('status')).toHaveTextContent('Type your username and password.');
        expect(loginStudent).not.toHaveBeenCalled();
    });

    it('shows the failure verbatim and stays on the page', async () => {
        const user = userEvent.setup();
        loginStudent.mockRejectedValue(new Error('That username and password did not work'));
        renderLogin();

        await user.type(screen.getByLabelText('Username or email'), 'ada_lovelace');
        await user.type(screen.getByLabelText('Password'), 'wrongpassword');
        await user.click(screen.getByRole('button', { name: 'Open my music' }));

        expect(await screen.findByText('That username and password did not work')).toBeInTheDocument();
        expect(screen.queryByText('your pieces')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Open my music' })).toBeEnabled();
    });

    it('disables the form while the sign-in is in flight', async () => {
        const user = userEvent.setup();
        loginStudent.mockReturnValue(new Promise(() => undefined));
        renderLogin();

        await user.type(screen.getByLabelText('Username or email'), 'ada_lovelace');
        await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
        await user.click(screen.getByRole('button', { name: 'Open my music' }));

        expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();
        expect(screen.getByLabelText('Username or email')).toBeDisabled();
        expect(screen.getByLabelText('Password')).toBeDisabled();
    });
});
