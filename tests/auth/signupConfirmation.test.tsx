import { AuthApiError } from '@supabase/supabase-js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isEmailNotConfirmed, mapAuthError } from '../../src/features/auth/authErrors';
import { LoginPage } from '../../src/features/auth/LoginPage';
import { RegisterPage } from '../../src/features/auth/RegisterPage';

/**
 * Sign-up with email confirmation ON, end to end through the pages — the state
 * production moved to on 2026-10-12 when `mailer_autoconfirm` was turned off.
 *
 * What was broken before this: the confirmation link lives one hour
 * (`mailer_otp_exp = 3600`), and once it died there was no way forward.
 * Signing up again answers "an account with this email already exists, try
 * signing in"; signing in answered GoTrue's `email_not_confirmed`, which had no
 * entry in authErrors.ts and so surfaced as the generic "Could not sign in." —
 * indistinguishable from a wrong password. A new user who read their mail an
 * hour late was stuck, with nothing on screen telling them why or what to do.
 *
 * These tests pin the way out: the error names the email, and a resend sits on
 * both screens a stuck user can actually reach.
 */

const signInWithPassword = vi.hoisted(() => vi.fn());
const signUpWithPassword = vi.hoisted(() => vi.fn());
const requestPasswordReset = vi.hoisted(() => vi.fn());
const resendSignUpConfirmation = vi.hoisted(() => vi.fn());

vi.mock('@/features/auth/session', () => ({
    useSession: () => ({ session: null, loading: false }),
    isRegisteredSession: () => false,
    signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
    signUpWithPassword: (...args: unknown[]) => signUpWithPassword(...args),
    requestPasswordReset: (...args: unknown[]) => requestPasswordReset(...args),
    resendSignUpConfirmation: (...args: unknown[]) => resendSignUpConfirmation(...args),
}));

beforeEach(() => {
    resendSignUpConfirmation.mockResolvedValue(undefined);
});

afterEach(() => {
    cleanup();
    signInWithPassword.mockReset();
    signUpWithPassword.mockReset();
    requestPasswordReset.mockReset();
    resendSignUpConfirmation.mockReset();
});

const EMAIL = 'teacher@example.com';
const PASSWORD = 'letters4ever';

const renderRegister = () =>
    render(
        <MemoryRouter initialEntries={['/register']}>
            <Routes>
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/library" element={<p>library</p>} />
            </Routes>
        </MemoryRouter>,
    );

const renderLogin = () =>
    render(
        <MemoryRouter initialEntries={['/login']}>
            <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/library" element={<p>library</p>} />
            </Routes>
        </MemoryRouter>,
    );

const signUp = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText('Email'), EMAIL);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Confirm password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
};

const logIn = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText('Email'), EMAIL);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Log in' }));
};

/** GoTrue's refusal for an account whose address is not confirmed yet. */
const notConfirmed = () => new AuthApiError('Email not confirmed', 400, 'email_not_confirmed');

describe('after signing up with confirmation on', () => {
    it('stays on "Check your email" instead of assuming a session, and says the link expires', async () => {
        // signUp resolves with user but no session when confirmations are on;
        // signUpWithPassword reports that as needsEmailConfirmation. Nothing
        // else in the app calls it, so nothing else assumed otherwise.
        signUpWithPassword.mockResolvedValue({ needsEmailConfirmation: true });
        const user = userEvent.setup();
        renderRegister();
        await signUp(user);

        expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument();
        expect(screen.getByText(new RegExp(EMAIL))).toBeInTheDocument();
        expect(screen.queryByText('library')).not.toBeInTheDocument();
        // The hour matters enough to say: it is the whole reason the resend
        // below has to exist.
        expect(screen.getByText(/expires after an hour/i)).toBeInTheDocument();
    });

    it('still signs straight in when confirmation is off, as the local stack has it', async () => {
        // The other half of the same branch — `enable_confirmations = false`
        // locally — so this change cannot have broken the dev loop.
        signUpWithPassword.mockResolvedValue({ needsEmailConfirmation: false });
        const user = userEvent.setup();
        renderRegister();
        await signUp(user);

        expect(await screen.findByText('library')).toBeInTheDocument();
    });

    it('can send the confirmation email again, and says so once, from the sign-up screen', async () => {
        signUpWithPassword.mockResolvedValue({ needsEmailConfirmation: true });
        const user = userEvent.setup();
        renderRegister();
        await signUp(user);

        await user.click(await screen.findByRole('button', { name: 'Send the email again' }));

        expect(resendSignUpConfirmation).toHaveBeenCalledExactlyOnceWith(EMAIL, null);
        // One send per screen, the way the forgot-password form is one submit
        // per screen: a button somebody can click forty times while they wait
        // is a mail bill, and this is the budget the auth-mail reserve exists
        // to protect.
        expect(await screen.findByText(/Sent\./)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Send the email again' })).not.toBeInTheDocument();
    });

    it('reports a resend failure only when the reason is the same for every address', async () => {
        // Same discipline as the forgot-password form. GoTrue's /resend
        // refuses an address with nothing pending and accepts one with a
        // confirmation outstanding, so a button that reported its failures
        // would answer "does this address have an unconfirmed account?".
        signUpWithPassword.mockResolvedValue({ needsEmailConfirmation: true });
        resendSignUpConfirmation.mockRejectedValue(
            new AuthApiError('Email address is invalid', 422, 'email_address_invalid'),
        );
        const user = userEvent.setup();
        renderRegister();
        await signUp(user);
        await user.click(await screen.findByRole('button', { name: 'Send the email again' }));

        // Address-specific: answered exactly like a success.
        expect(await screen.findByText(/Sent\./)).toBeInTheDocument();
        cleanup();

        // Address-independent (the per-IP limiter in front of the endpoint):
        // safe to name, and the person needs to know to wait.
        resendSignUpConfirmation.mockRejectedValue(
            new AuthApiError('Request rate limit reached', 429, 'over_request_rate_limit'),
        );
        const second = userEvent.setup();
        renderRegister();
        await signUp(second);
        await second.click(await screen.findByRole('button', { name: 'Send the email again' }));

        expect(await screen.findByText(/Wait a few minutes/)).toBeInTheDocument();
        // Still offered, because waiting and retrying is the advice.
        expect(screen.getByRole('button', { name: 'Send the email again' })).toBeInTheDocument();
    });
});

describe('logging in before confirming', () => {
    it('says the email is what is missing, not that the password was wrong', async () => {
        signInWithPassword.mockRejectedValue(notConfirmed());
        const user = userEvent.setup();
        renderLogin();
        await logIn(user);

        const message = await screen.findByText(/Confirm your email address first/i);
        expect(message).toBeInTheDocument();
        // The old behaviour, and what made this unactionable: the generic
        // fallback, identical to a mistyped password.
        expect(screen.queryByText('Could not sign in.')).not.toBeInTheDocument();
        expect(screen.queryByText('Email or password is incorrect.')).not.toBeInTheDocument();
    });

    it('offers the resend there, closing the loop a dead link used to leave', async () => {
        signInWithPassword.mockRejectedValue(notConfirmed());
        const user = userEvent.setup();
        renderLogin();
        await logIn(user);

        const resend = await screen.findByRole('button', { name: 'Send the email again' });
        await user.click(resend);
        await waitFor(() => expect(resendSignUpConfirmation).toHaveBeenCalledExactlyOnceWith(EMAIL, null));
    });

    it('offers it for no other sign-in failure — it would be a hint about the address', async () => {
        // `email_not_confirmed` is reachable only by someone who already holds
        // the password (GoTrue checks the credential before the flag), so
        // acting on it visibly reveals nothing. A wrong password is the usual
        // invalid_credentials, and nothing appears.
        signInWithPassword.mockRejectedValue(new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'));
        const user = userEvent.setup();
        renderLogin();
        await logIn(user);

        expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Send the email again' })).not.toBeInTheDocument();
    });
});

describe('the error mapping itself', () => {
    it('reads email_not_confirmed from a thrown error and from a redirect description alike', () => {
        // Two shapes reach this: an AuthApiError with a code from the client,
        // and a bare `error_description` sentence out of the address bar,
        // which carries no code at all (authUrlError.ts).
        expect(isEmailNotConfirmed(notConfirmed())).toBe(true);
        expect(isEmailNotConfirmed('Email not confirmed')).toBe(true);
        expect(mapAuthError(notConfirmed(), 'fallback')).toMatch(/Confirm your email address first/i);
        expect(mapAuthError('Email not confirmed', 'fallback')).toMatch(/Confirm your email address first/i);
    });

    it('does not fire for anything else', () => {
        for (const err of [
            new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
            new AuthApiError('User already registered', 422, 'user_already_exists'),
            'Email link is invalid or has expired',
            '',
            null,
        ]) {
            expect(isEmailNotConfirmed(err), String(err)).toBe(false);
        }
    });

    it('still names an expired email link, which is how a dead confirm link arrives', () => {
        // GoTrue redirects a dead signup link to redirect_to with
        // `error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`.
        // AuthCallbackPage reads that itself and maps it through here.
        expect(mapAuthError('Email link is invalid or has expired', 'fallback')).toBe(
            'This link has expired. Request a new one.',
        );
        expect(mapAuthError({ code: 'otp_expired' }, 'fallback')).toBe('This link has expired. Request a new one.');
    });
});
