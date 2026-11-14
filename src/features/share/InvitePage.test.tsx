import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetTurnstileLoaderForTests, type TurnstileRenderOptions } from '@/features/auth/turnstile';
import { InvitePage } from '@/features/share/InvitePage';
import { passAgeScreen } from '@/test/ageScreen';
import type * as InviteApiModule from '@/features/share/inviteApi';

const peekInvite = vi.hoisted(() => vi.fn());
const acceptInvite = vi.hoisted(() => vi.fn());
const signInWithPassword = vi.hoisted(() => vi.fn());
const signOut = vi.hoisted(() => vi.fn());

const auth = vi.hoisted(() => {
    let state: { session: unknown; loading: boolean } = { session: null, loading: false };
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set: (next: { session: unknown; loading: boolean }) => {
            state = next;
            listeners.forEach((listener) => listener());
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
});

vi.mock('@/features/auth/session', () => ({
    useSession: () => useSyncExternalStore(auth.subscribe, auth.get),
    isRegisteredSession: (session: { user: { is_anonymous?: boolean } } | null) =>
        Boolean(session && !session.user.is_anonymous),
    signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
    signOut: () => signOut(),
}));

vi.mock('@/features/share/inviteApi', async (importOriginal) => ({
    ...(await importOriginal<typeof InviteApiModule>()),
    peekInvite: (...args: unknown[]) => peekInvite(...args),
    acceptInvite: (...args: unknown[]) => acceptInvite(...args),
}));

const TOKEN = 'a'.repeat(43);
const HEADLINE = 'Max Harris invited you to Für Elise as an editor';
const member = { access_token: 'member-jwt', user: { id: 'u1', is_anonymous: false } };

const renderInvite = () =>
    render(
        <MemoryRouter initialEntries={[`/invite#${TOKEN}`]}>
            <Routes>
                <Route path="/invite" element={<InvitePage />} />
                <Route path="/doc/:id" element={<p>score open</p>} />
            </Routes>
        </MemoryRouter>,
    );

beforeEach(() => {
    auth.set({ session: null, loading: false });
    peekInvite.mockResolvedValue({
        kind: 'pending',
        invite: { title: 'Für Elise', inviterName: 'Max Harris', role: 'editor', emailMasked: 'j***@e***.com' },
    });
    signInWithPassword.mockResolvedValue(undefined);
    signOut.mockImplementation(() => {
        auth.set({ session: null, loading: false });
        return Promise.resolve();
    });
});

afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetTurnstileLoaderForTests();
    delete (window as { turnstile?: unknown }).turnstile;
    document.getElementById('cf-turnstile-script')?.remove();
});

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

describe('InvitePage', () => {
    it.each([
        ['expired', 'This invite expired. Ask the owner to send a new one.'],
        ['used', 'This invite was already used.'],
        ['cancelled', 'The owner cancelled this invite.'],
        ['invalid', "This invite doesn't work. Check you copied all of the link."],
    ])('says why a %s invite cannot be used', async (state, message) => {
        peekInvite.mockResolvedValue({ kind: 'dead', state });
        renderInvite();
        expect(await screen.findByText(message)).toBeTruthy();
    });

    it('accepts for the signed-in invitee and opens the score', async () => {
        auth.set({ session: member, loading: false });
        acceptInvite.mockResolvedValue({ kind: 'ok', documentId: 'doc-1', email: null });
        renderInvite();
        expect(await screen.findByText(HEADLINE)).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Accept and open' }));
        expect(await screen.findByText('score open')).toBeTruthy();
        expect(acceptInvite).toHaveBeenCalledWith(TOKEN, 'member-jwt');
    });

    it('asks someone signed in as another account to sign out', async () => {
        auth.set({ session: member, loading: false });
        acceptInvite.mockResolvedValue({ kind: 'email_mismatch' });
        renderInvite();
        await userEvent.click(await screen.findByRole('button', { name: 'Accept and open' }));
        expect(await screen.findByText('This invite is for j***@e***.com. Sign out to accept it.')).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
        expect(signOut).toHaveBeenCalledTimes(1);
        expect(await screen.findByRole('button', { name: 'Continue' })).toBeTruthy();
    });

    it('asks an existing account to sign in, then accepts', async () => {
        acceptInvite.mockResolvedValueOnce({ kind: 'sign_in_required' });
        renderInvite();
        await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
        expect(await screen.findByText(/You already have an account/)).toBeTruthy();
        expect(screen.queryByLabelText('Birth year')).toBeNull();
    });

    it('takes someone new through the age screen and a password, then signs in with the returned email', async () => {
        acceptInvite
            .mockResolvedValueOnce({ kind: 'age_check_missing' })
            .mockResolvedValueOnce({ kind: 'ok', documentId: 'doc-1', email: 'jo@example.org' });
        renderInvite();
        await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
        await passAgeScreen();
        expect(await screen.findByText('Choose a password')).toBeTruthy();
        const email = screen.getByLabelText('Email') as HTMLInputElement;
        expect(email.value).toBe('j***@e***.com');
        expect(email.readOnly).toBe(true);
        await userEvent.type(screen.getByLabelText('Password'), 'a-long-passphrase-1');
        await userEvent.type(screen.getByLabelText(/Confirm/i), 'a-long-passphrase-1');
        await userEvent.click(screen.getByRole('button', { name: 'Create account and open' }));
        expect(await screen.findByText('score open')).toBeTruthy();
        expect(acceptInvite).toHaveBeenLastCalledWith(TOKEN, null, {
            password: 'a-long-passphrase-1',
            ageGate: expect.objectContaining({ country: 'US', source: 'self' }),
        });
        expect(signInWithPassword).toHaveBeenCalledWith('jo@example.org', 'a-long-passphrase-1', null);
    });

    it('sends nothing more when the age screen refuses, so no account is made', async () => {
        acceptInvite.mockResolvedValueOnce({ kind: 'age_check_missing' });
        renderInvite();
        await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
        await passAgeScreen('US', String(new Date().getFullYear() - 5));
        expect(screen.queryByText('Choose a password')).toBeNull();
        expect(acceptInvite).toHaveBeenCalledTimes(1);
    });

    it('shows a weak password refusal and stays on the form', async () => {
        acceptInvite
            .mockResolvedValueOnce({ kind: 'age_check_missing' })
            .mockResolvedValueOnce({ kind: 'weak_password', message: 'Choose a longer password.' });
        renderInvite();
        await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
        await passAgeScreen();
        await userEvent.type(await screen.findByLabelText('Password'), 'short-pass-123');
        await userEvent.type(screen.getByLabelText(/Confirm/i), 'short-pass-123');
        await userEvent.click(screen.getByRole('button', { name: 'Create account and open' }));
        expect(await screen.findByText('Choose a longer password.')).toBeTruthy();
        expect(signInWithPassword).not.toHaveBeenCalled();
    });

    describe('with Turnstile on', () => {
        it('signs an existing account in with the solved token', async () => {
            const rendered = withTurnstile();
            acceptInvite.mockResolvedValueOnce({ kind: 'sign_in_required' });
            renderInvite();
            await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
            await userEvent.type(await screen.findByLabelText('Email'), 'jo@example.org');
            await userEvent.type(screen.getByLabelText('Password'), 'a-long-passphrase-1');
            await waitFor(() => expect(rendered).toHaveLength(1));
            rendered[0]!.callback('cf-login');
            await userEvent.click(screen.getByRole('button', { name: 'Sign in and accept' }));
            await waitFor(() =>
                expect(signInWithPassword).toHaveBeenCalledWith('jo@example.org', 'a-long-passphrase-1', 'cf-login'),
            );
        });

        it('signs a new account in with the solved token after accepting', async () => {
            const rendered = withTurnstile();
            acceptInvite
                .mockResolvedValueOnce({ kind: 'age_check_missing' })
                .mockResolvedValueOnce({ kind: 'ok', documentId: 'doc-1', email: 'jo@example.org' });
            renderInvite();
            await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
            await passAgeScreen();
            expect(await screen.findByText('Choose a password')).toBeTruthy();
            await userEvent.type(screen.getByLabelText('Password'), 'a-long-passphrase-1');
            await userEvent.type(screen.getByLabelText(/Confirm/i), 'a-long-passphrase-1');
            await waitFor(() => expect(rendered).toHaveLength(1));
            rendered[0]!.callback('cf-signup');
            await userEvent.click(screen.getByRole('button', { name: 'Create account and open' }));
            expect(await screen.findByText('score open')).toBeTruthy();
            expect(signInWithPassword).toHaveBeenCalledWith('jo@example.org', 'a-long-passphrase-1', 'cf-signup');
        });
    });
});
