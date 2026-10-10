import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RequireRegistered } from '@/features/auth/AuthGates';
import { AuthLinkErrorNotice } from '@/features/auth/AuthLinkErrorNotice';
import {
    captureAuthUrlError,
    parseAuthUrlError,
    resetAuthUrlErrorForTests,
    withoutAuthErrorParams,
} from '@/features/auth/authUrlError';

vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: null, loading: false }),
    isRegisteredSession: () => false,
    userTypeOf: () => null,
}));

vi.mock('@/features/install/installSurface', () => ({
    isStandaloneDisplay: () => false,
}));

/** Where GoTrue sends an expired or already-used reset link. */
const EXPIRED_RESET = {
    pathname: '/update-password',
    search: '',
    hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
};

const fakeHistory = () => ({ state: { idx: 0 }, replaceState: vi.fn() });

afterEach(() => {
    cleanup();
    resetAuthUrlErrorForTests();
});

describe('parseAuthUrlError', () => {
    it('reads the error from the fragment (implicit flow) and the query (PKCE)', () => {
        expect(parseAuthUrlError(EXPIRED_RESET)).toEqual({
            code: 'otp_expired',
            description: 'Email link is invalid or has expired',
            path: '/update-password',
        });
        expect(
            parseAuthUrlError({
                pathname: '/login',
                search: '?error=access_denied&error_code=otp_expired&error_description=x',
                hash: '',
            }),
        ).toMatchObject({ code: 'otp_expired', path: '/login' });
    });

    it('ignores URLs with no auth error, a bare ?error= included', () => {
        expect(
            parseAuthUrlError({ pathname: '/update-password', search: '', hash: '#access_token=a&type=recovery' }),
        ).toBeNull();
        expect(parseAuthUrlError({ pathname: '/account', search: '?checkout=cancelled&error=1', hash: '' })).toBeNull();
    });
});

describe('withoutAuthErrorParams', () => {
    it('drops only the error keys', () => {
        expect(withoutAuthErrorParams(EXPIRED_RESET)).toBe('/update-password');
        expect(
            withoutAuthErrorParams({ pathname: '/login', search: '?next=%2Flibrary&error_code=otp_expired', hash: '' }),
        ).toBe('/login?next=%2Flibrary');
        expect(withoutAuthErrorParams({ pathname: '/login', search: '?next=x', hash: '' })).toBeNull();
    });

    it('leaves a part without error keys exactly as it was', () => {
        expect(withoutAuthErrorParams({ pathname: '/help', search: '?error_code=otp_expired', hash: '#section' })).toBe(
            '/help#section',
        );
        expect(withoutAuthErrorParams({ pathname: '/help', search: '?q=a b&x', hash: '#error_code=otp_expired' })).toBe(
            '/help?q=a b&x',
        );
    });
});

describe('captureAuthUrlError', () => {
    it('keeps the error and cleans the address bar', () => {
        const history = fakeHistory();
        expect(captureAuthUrlError(EXPIRED_RESET, history)).toMatchObject({ code: 'otp_expired' });
        expect(history.replaceState).toHaveBeenCalledWith({ idx: 0 }, '', '/update-password');
    });

    it('leaves the pages that explain the error themselves alone', () => {
        const history = fakeHistory();
        expect(captureAuthUrlError({ ...EXPIRED_RESET, pathname: '/auth/callback' }, history)).toBeNull();
        expect(captureAuthUrlError({ ...EXPIRED_RESET, pathname: '/student/welcome' }, history)).toBeNull();
        expect(history.replaceState).not.toHaveBeenCalled();
    });
});

describe('AuthLinkErrorNotice', () => {
    it('explains an expired reset link on the sign-in page the gate redirected to', async () => {
        captureAuthUrlError(EXPIRED_RESET, fakeHistory());
        const user = userEvent.setup();
        render(
            <MemoryRouter initialEntries={['/update-password']}>
                <Routes>
                    <Route
                        path="/update-password"
                        element={<RequireRegistered fallback="/login">{() => <p>form</p>}</RequireRegistered>}
                    />
                    <Route path="/login" element={<h1>Log in</h1>} />
                    <Route path="/forgot-password" element={<h1>Reset your password</h1>} />
                </Routes>
                <AuthLinkErrorNotice />
            </MemoryRouter>,
        );

        // The gate still redirects (no session) — but the reason now survives it.
        expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument();
        const dialog = screen.getByRole('dialog', { name: 'This reset link has expired or was already used' });
        expect(dialog).toBeInTheDocument();

        await user.click(screen.getByRole('link', { name: 'Request a new link' }));
        expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('shows nothing when no link failed, and goes away when dismissed', async () => {
        const user = userEvent.setup();
        const { rerender } = render(
            <MemoryRouter>
                <AuthLinkErrorNotice />
            </MemoryRouter>,
        );
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

        act(() => {
            captureAuthUrlError(
                { pathname: '/', search: '', hash: '#error=server_error&error_description=Something' },
                fakeHistory(),
            );
        });
        rerender(
            <MemoryRouter>
                <AuthLinkErrorNotice />
            </MemoryRouter>,
        );
        expect(screen.getByRole('dialog', { name: 'That link didn’t work' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Not now' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});
