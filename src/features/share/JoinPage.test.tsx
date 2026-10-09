import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JoinPage } from '@/features/share/JoinPage';

const peekShareLink = vi.hoisted(() => vi.fn());
const redeemShareLink = vi.hoisted(() => vi.fn());
const signInAnonymouslyWithName = vi.hoisted(() => vi.fn());
const requestAccountDeletion = vi.hoisted(() => vi.fn());
const forgetLocalSession = vi.hoisted(() => vi.fn());

/** A session store the page can watch change, as useSession's subscribers do. */
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
    signInAnonymouslyWithName: (...args: unknown[]) => signInAnonymouslyWithName(...args),
}));

vi.mock('@/features/share/shareService', () => ({
    peekShareLink: (...args: unknown[]) => peekShareLink(...args),
    redeemShareLink: (...args: unknown[]) => redeemShareLink(...args),
}));

vi.mock('@/features/account/accountDeletion', () => ({
    requestAccountDeletion: (...args: unknown[]) => requestAccountDeletion(...args),
    forgetLocalSession: () => forgetLocalSession(),
}));

const guestSession = { user: { id: 'guest-1', is_anonymous: true } };
const DEAD = /invalid, expired, or was revoked/;

const renderJoin = () =>
    render(
        <MemoryRouter initialEntries={['/join/tok']}>
            <Routes>
                <Route path="/join/:token" element={<JoinPage />} />
                <Route path="/doc/:id" element={<p>viewer</p>} />
            </Routes>
        </MemoryRouter>,
    );

beforeEach(() => {
    auth.set({ session: null, loading: false });
    signInAnonymouslyWithName.mockImplementation(() => {
        auth.set({ session: guestSession, loading: false });
        return Promise.resolve();
    });
    redeemShareLink.mockResolvedValue({ documentId: 'doc-1', role: 'editor' });
    requestAccountDeletion.mockResolvedValue(undefined);
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('JoinPage', () => {
    it('reports a dead link before asking a name, and creates nobody', async () => {
        peekShareLink.mockResolvedValue({ valid: false });
        renderJoin();
        expect(await screen.findByText(DEAD)).toBeInTheDocument();
        expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
        expect(peekShareLink).toHaveBeenCalledWith('tok');
        expect(signInAnonymouslyWithName).not.toHaveBeenCalled();
        expect(redeemShareLink).not.toHaveBeenCalled();
    });

    it('asks a name for a live link, signs the guest in, and opens the score', async () => {
        peekShareLink.mockResolvedValue({ valid: true, role: 'editor' });
        renderJoin();
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText('Your name'), 'Sharon');
        await user.click(screen.getByRole('button', { name: 'Join' }));
        expect(await screen.findByText('viewer')).toBeInTheDocument();
        expect(signInAnonymouslyWithName).toHaveBeenCalledWith('Sharon');
        expect(redeemShareLink).toHaveBeenCalledWith('tok');
    });

    it('checks again on Join: a link revoked while the name was typed creates nobody', async () => {
        peekShareLink.mockResolvedValueOnce({ valid: true, role: 'viewer' }).mockResolvedValueOnce({ valid: false });
        renderJoin();
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText('Your name'), 'Sharon');
        await user.click(screen.getByRole('button', { name: 'Join' }));
        expect(await screen.findByText(DEAD)).toBeInTheDocument();
        expect(peekShareLink).toHaveBeenCalledTimes(2);
        expect(signInAnonymouslyWithName).not.toHaveBeenCalled();
    });

    it('falls back to the old flow when the link cannot be checked', async () => {
        // Offline, or a backend that predates peek_share_link: redeem decides.
        peekShareLink.mockResolvedValue(null);
        renderJoin();
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText('Your name'), 'Sharon');
        await user.click(screen.getByRole('button', { name: 'Join' }));
        expect(await screen.findByText('viewer')).toBeInTheDocument();
    });

    it('deletes the guest it just made when the link dies between the check and the redeem', async () => {
        peekShareLink.mockResolvedValue({ valid: true, role: 'editor' });
        redeemShareLink.mockRejectedValue(new Error('invalid_link'));
        renderJoin();
        const user = userEvent.setup();
        await user.type(await screen.findByLabelText('Your name'), 'Sharon');
        await user.click(screen.getByRole('button', { name: 'Join' }));
        expect(await screen.findByText(DEAD)).toBeInTheDocument();
        expect(requestAccountDeletion).toHaveBeenCalledWith();
        expect(forgetLocalSession).toHaveBeenCalled();
        // A full page load out: the deleted guest is still this tab's in-memory session.
        const home = screen.getByRole('link', { name: 'Back to home' });
        expect(home).toHaveAttribute('href', '/');
        // A plain <a>, not a router <Link> (which renders data-discover).
        expect(home).not.toHaveAttribute('data-discover');
    });

    it('never deletes an existing session the link was opened with', async () => {
        auth.set({ session: guestSession, loading: false });
        redeemShareLink.mockRejectedValue(new Error('invalid_link'));
        renderJoin();
        expect(await screen.findByText(DEAD)).toBeInTheDocument();
        expect(requestAccountDeletion).not.toHaveBeenCalled();
        expect(forgetLocalSession).not.toHaveBeenCalled();
        // A session is redeemed with directly; it needs no check first.
        expect(peekShareLink).not.toHaveBeenCalled();
    });

    it('waits for the check before offering the name field', async () => {
        let answer: (value: unknown) => void = () => undefined;
        peekShareLink.mockReturnValue(
            new Promise((resolve) => {
                answer = resolve;
            }),
        );
        renderJoin();
        expect(screen.getByText('Checking the link…')).toBeInTheDocument();
        expect(screen.queryByLabelText('Your name')).not.toBeInTheDocument();
        await act(async () => {
            answer({ valid: true, role: 'viewer' });
            await Promise.resolve();
        });
        expect(await screen.findByLabelText('Your name')).toBeInTheDocument();
    });
});
