import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as sessionModule from '@/features/auth/session';
import { resetTurnstileLoaderForTests, type TurnstileRenderOptions } from '@/features/auth/turnstile';
import { discardedChangesNotice, keptChangesNotice } from '@/features/student/keptChangesNotice';
import { ACCOUNT_DELETED, SIGNED_OUT_BY_TEACHER, StudentLoginPage } from '@/features/student/StudentLoginPage';

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

const renderLogin = (state?: unknown) =>
    render(
        <MemoryRouter initialEntries={[{ pathname: '/student', state }]}>
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
    vi.unstubAllEnvs();
    resetTurnstileLoaderForTests();
    delete (window as { turnstile?: unknown }).turnstile;
    document.getElementById('cf-turnstile-script')?.remove();
});

/**
 * Turnstile switched on with a stubbed `window.turnstile`, the harness
 * tests/auth/turnstileField.test.tsx uses. Cloudflare's always-passes test site
 * key; `rendered` collects the widgets in mount order.
 */
const withTurnstile = () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
    const rendered: TurnstileRenderOptions[] = [];
    Object.assign(window, {
        turnstile: {
            render: (_host: HTMLElement, options: TurnstileRenderOptions) => {
                rendered.push(options);
                return `widget-${rendered.length}`;
            },
            remove: () => undefined,
            reset: () => undefined,
        },
    });
    return rendered;
};

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

        // Unnormalized on purpose: the server folds case and space itself. The
        // third argument is the Turnstile token, null on a build with no site
        // key — which is this one, and every build until Max sets one.
        expect(loginStudent).toHaveBeenCalledWith('  Ada_Lovelace ', 'hunter2hunter2', null);
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

    it('says why when the teacher ended the sign-in, and only then', () => {
        renderLogin({ signedOutByTeacher: true });
        expect(screen.getByRole('status')).toHaveTextContent(SIGNED_OUT_BY_TEACHER);
        cleanup();

        renderLogin();
        expect(screen.queryByText(SIGNED_OUT_BY_TEACHER)).not.toBeInTheDocument();
    });

    it('says the changes that sign-out kept are still on this device', () => {
        renderLogin({ signedOutByTeacher: true, keptChanges: 3 });
        expect(screen.getByRole('status')).toHaveTextContent(keptChangesNotice(3));
        expect(keptChangesNotice(3)).toMatch(/^3 changes .* kept on this device/);
        cleanup();

        renderLogin({ signedOutByTeacher: true, keptChanges: 0 });
        expect(screen.getByRole('status')).not.toHaveTextContent('kept on this device');
    });

    it('keeps saying where the kept changes are after a sign-in fails, beside the reason it failed', async () => {
        const user = userEvent.setup();
        const archived =
            "Your teacher has archived this account, so it can't sign in for now. Ask your teacher to restore it.";
        loginStudent.mockRejectedValue(new Error(archived));
        renderLogin({ signedOutByTeacher: true, keptChanges: 1 });

        await user.type(screen.getByLabelText('Username or email'), 'ada_lovelace');
        await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
        await user.click(screen.getByRole('button', { name: 'Open my music' }));

        expect(await screen.findByText(archived)).toBeInTheDocument();
        expect(screen.getByText(new RegExp(SIGNED_OUT_BY_TEACHER.slice(0, 40)))).toHaveTextContent(
            keptChangesNotice(1),
        );
    });

    it('says a deleted account is gone, and promises nothing about its changes', () => {
        renderLogin({ signedOutByTeacher: true, keptChanges: 0, accountDeleted: true, discardedChanges: 2 });
        const status = screen.getByRole('status');
        expect(status).toHaveTextContent(ACCOUNT_DELETED);
        expect(status).toHaveTextContent(discardedChangesNotice(2));
        expect(status).not.toHaveTextContent(SIGNED_OUT_BY_TEACHER);
        expect(status).not.toHaveTextContent('saved when you sign in');
        cleanup();

        renderLogin({ signedOutByTeacher: true, keptChanges: 0, accountDeleted: true, discardedChanges: 0 });
        expect(screen.getByRole('status')).toHaveTextContent(ACCOUNT_DELETED);
        expect(screen.getByRole('status')).not.toHaveTextContent('removed from this device');
    });
});

describe('StudentLoginPage with Turnstile on', () => {
    // Why the widget belongs here at all: both halves of the roster sign in
    // through a password grant — an email-method student at GoTrue directly, a
    // username student through student-login, which calls the same grant
    // server-side with whatever token the caller sent. GoTrue's captcha is
    // project-wide, so without this, switching it on refuses every child at the
    // sign-in box (QA round 4 review of #57).
    it('renders nothing at all without a site key, which is every build today', () => {
        renderLogin();
        expect(screen.queryByTestId('turnstile-field')).not.toBeInTheDocument();
    });

    it('sends the solved token with the credential', async () => {
        const rendered = withTurnstile();
        const user = userEvent.setup();
        renderLogin();
        await waitFor(() => expect(rendered).toHaveLength(1));
        expect(rendered[0]).toMatchObject({ action: 'student-login' });
        rendered[0]!.callback('cf-token');

        await user.type(screen.getByLabelText('Username or email'), 'ada_lovelace');
        await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
        await user.click(screen.getByRole('button', { name: 'Open my music' }));

        expect(loginStudent).toHaveBeenCalledWith('ada_lovelace', 'hunter2hunter2', 'cf-token');
    });

    it('asks for the check last, after the fields, and sends nothing without it', async () => {
        withTurnstile();
        const user = userEvent.setup();
        renderLogin();

        // A child who left a field empty hears about the field first.
        await user.click(screen.getByRole('button', { name: 'Open my music' }));
        expect(screen.getByRole('status')).toHaveTextContent('Type your username and password.');

        await user.type(screen.getByLabelText('Username or email'), 'ada_lovelace');
        await user.type(screen.getByLabelText('Password'), 'hunter2hunter2');
        await user.click(screen.getByRole('button', { name: 'Open my music' }));

        expect(screen.getByRole('status')).toHaveTextContent('Finish the “I’m human” check');
        expect(loginStudent).not.toHaveBeenCalled();
    });

    it('puts up a fresh challenge after a refused sign-in', async () => {
        // The token is spent the moment it is redeemed, whatever became of the
        // password beside it, so a retry with the same one fails the captcha
        // rather than the credential.
        loginStudent.mockRejectedValue(new Error('That username and password did not work'));
        const rendered = withTurnstile();
        const user = userEvent.setup();
        renderLogin();
        await waitFor(() => expect(rendered).toHaveLength(1));
        rendered[0]!.callback('cf-token');

        await user.type(screen.getByLabelText('Username or email'), 'ada_lovelace');
        await user.type(screen.getByLabelText('Password'), 'wrong-password-1');
        await user.click(screen.getByRole('button', { name: 'Open my music' }));

        expect(await screen.findByText('That username and password did not work')).toBeInTheDocument();
        await waitFor(() => expect(rendered).toHaveLength(2));
    });
});
