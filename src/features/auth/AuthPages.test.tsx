import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LoginPage } from '@/features/auth/LoginPage';
import { RegisterPage } from '@/features/auth/RegisterPage';

const signInWithPassword = vi.hoisted(() => vi.fn());

vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: null, loading: false }),
    isRegisteredSession: () => false,
    signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
    signUpWithPassword: vi.fn(),
}));

afterEach(() => {
    cleanup();
    signInWithPassword.mockReset();
});

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
    });
});
