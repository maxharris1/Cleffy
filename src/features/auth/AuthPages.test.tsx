import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoginPage } from '@/features/auth/LoginPage';
import { RegisterPage } from '@/features/auth/RegisterPage';

const signInWithPassword = vi.hoisted(() => vi.fn());
const signUpWithPassword = vi.hoisted(() => vi.fn());

vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: null, loading: false }),
    isRegisteredSession: () => false,
    signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
    signUpWithPassword: (...args: unknown[]) => signUpWithPassword(...args),
}));

afterEach(() => {
    cleanup();
    signInWithPassword.mockReset();
    signUpWithPassword.mockReset();
});

const renderRegister = () =>
    render(
        <MemoryRouter initialEntries={['/register']}>
            <Routes>
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/library" element={<p>library</p>} />
            </Routes>
        </MemoryRouter>,
    );

describe('Auth pages', () => {
    it('renders login form with links to register and forgot password', () => {
        render(
            <MemoryRouter initialEntries={['/login']}>
                <Routes>
                    <Route path="/login" element={<LoginPage />} />
                </Routes>
            </MemoryRouter>,
        );
        expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute('href', '/forgot-password');
        expect(screen.getByRole('link', { name: 'Create one' })).toHaveAttribute('href', '/register');
        expect(screen.getByRole('main')).toHaveClass('safe-brand-shell');
    });

    it('honors next=/library after a successful sign-in', async () => {
        signInWithPassword.mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(
            <MemoryRouter initialEntries={['/login?next=/library']}>
                <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/library" element={<p>library</p>} />
                </Routes>
            </MemoryRouter>,
        );
        await user.type(screen.getByLabelText('Email'), 'teacher@cleffy.local');
        await user.type(screen.getByLabelText('Password'), 'cleffy-local-test');
        await user.click(screen.getByRole('button', { name: 'Log in' }));
        expect(signInWithPassword).toHaveBeenCalledWith('teacher@cleffy.local', 'cleffy-local-test');
        expect(await screen.findByText('library')).toBeInTheDocument();
    });

    it('rejects an open-redirect next and still lands on the library', async () => {
        signInWithPassword.mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(
            <MemoryRouter initialEntries={['/login?next=https://evil.example']}>
                <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/library" element={<p>library</p>} />
                </Routes>
            </MemoryRouter>,
        );
        await user.type(screen.getByLabelText('Email'), 'teacher@cleffy.local');
        await user.type(screen.getByLabelText('Password'), 'cleffy-local-test');
        await user.click(screen.getByRole('button', { name: 'Log in' }));
        expect(await screen.findByText('library')).toBeInTheDocument();
    });

    it('honors next=/assignments after a successful sign-in', async () => {
        signInWithPassword.mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(
            <MemoryRouter initialEntries={['/login?next=/assignments']}>
                <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/assignments" element={<p>assignments</p>} />
                </Routes>
            </MemoryRouter>,
        );
        await user.type(screen.getByLabelText('Email'), 'teacher@cleffy.local');
        await user.type(screen.getByLabelText('Password'), 'cleffy-local-test');
        await user.click(screen.getByRole('button', { name: 'Log in' }));
        expect(await screen.findByText('assignments')).toBeInTheDocument();
    });

    it('renders register form with link to login', () => {
        render(
            <MemoryRouter initialEntries={['/register']}>
                <Routes>
                    <Route path="/register" element={<RegisterPage />} />
                </Routes>
            </MemoryRouter>,
        );
        expect(screen.getByRole('heading', { name: 'Create account' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
        expect(screen.getByRole('main')).toHaveClass('safe-brand-shell');
        expect(screen.getByText(/By creating an account you agree to the/)).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Terms of Service' })).toHaveAttribute('href', '/terms');
        expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
    });

    it('holds a new password to the account policy before calling sign-up', async () => {
        const user = userEvent.setup();
        renderRegister();
        expect(screen.getByText('At least 8 characters, with a letter and a number.')).toBeInTheDocument();

        await user.type(screen.getByLabelText('Email'), 'teacher@example.com');
        await user.type(screen.getByLabelText('Password'), 'sixsix');
        await user.type(screen.getByLabelText('Confirm password'), 'sixsix');
        await user.click(screen.getByRole('button', { name: 'Create account' }));
        expect(await screen.findByText('Password must be at least 8 characters.')).toBeInTheDocument();

        await user.clear(screen.getByLabelText('Password'));
        await user.clear(screen.getByLabelText('Confirm password'));
        await user.type(screen.getByLabelText('Password'), 'lettersonly');
        await user.type(screen.getByLabelText('Confirm password'), 'lettersonly');
        await user.click(screen.getByRole('button', { name: 'Create account' }));
        expect(
            await screen.findByText('Password must include at least one letter and one number.'),
        ).toBeInTheDocument();
        expect(signUpWithPassword).not.toHaveBeenCalled();

        await user.clear(screen.getByLabelText('Password'));
        await user.clear(screen.getByLabelText('Confirm password'));
        await user.type(screen.getByLabelText('Password'), 'letters4ever');
        await user.type(screen.getByLabelText('Confirm password'), 'letters4ever');
        signUpWithPassword.mockResolvedValue({ needsEmailConfirmation: false });
        await user.click(screen.getByRole('button', { name: 'Create account' }));
        expect(signUpWithPassword).toHaveBeenCalledExactlyOnceWith('teacher@example.com', 'letters4ever');
    });

    it('never applies the new-password policy at sign-in, so older short passwords still log in', async () => {
        signInWithPassword.mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(
            <MemoryRouter initialEntries={['/login']}>
                <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route path="/library" element={<p>library</p>} />
                </Routes>
            </MemoryRouter>,
        );
        expect(screen.queryByText('At least 8 characters, with a letter and a number.')).not.toBeInTheDocument();
        await user.type(screen.getByLabelText('Email'), 'teacher@example.com');
        await user.type(screen.getByLabelText('Password'), 'abcdef');
        await user.click(screen.getByRole('button', { name: 'Log in' }));
        expect(signInWithPassword).toHaveBeenCalledExactlyOnceWith('teacher@example.com', 'abcdef');
    });
});
