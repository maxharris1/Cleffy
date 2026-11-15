import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LINK_GUEST_GATE } from '@/features/auth/ageCheck';
import { ShareLinkPage } from '@/features/share/ShareLinkPage';
import { deadLinkMessage, tokenFromHash } from '@/features/share/shareLinkText';
import type * as ShareServiceModule from '@/features/share/shareService';
import type * as LinkSessionModule from '@/features/share/linkSession';

const peekShareLink = vi.hoisted(() => vi.fn());
const redeemShareLink = vi.hoisted(() => vi.fn());
const requestShareSession = vi.hoisted(() => vi.fn());
const signInAnonymouslyWithName = vi.hoisted(() => vi.fn());
const requestAccountDeletion = vi.hoisted(() => vi.fn());
const forgetLocalSession = vi.hoisted(() => vi.fn());

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

vi.mock('@/features/share/shareService', async (importOriginal) => ({
    ...(await importOriginal<typeof ShareServiceModule>()),
    peekShareLink: (...args: unknown[]) => peekShareLink(...args),
    redeemShareLink: (...args: unknown[]) => redeemShareLink(...args),
}));

vi.mock('@/features/share/linkSession', async (importOriginal) => ({
    ...(await importOriginal<typeof LinkSessionModule>()),
    requestShareSession: (...args: unknown[]) => requestShareSession(...args),
}));

vi.mock('@/features/share/LinkViewerPage', () => ({
    LinkViewerPage: ({ first }: { first: { doc: { title: string } } }) => <p>viewer of {first.doc.title}</p>,
}));

vi.mock('@/features/account/accountDeletion', () => ({
    requestAccountDeletion: (...args: unknown[]) => requestAccountDeletion(...args),
    forgetLocalSession: () => forgetLocalSession(),
}));

const TOKEN = 'abcdefghijklmnopqrstuv';
const guestSession = { user: { id: 'guest-1', is_anonymous: true } };
const memberSession = { user: { id: 'teacher-1', is_anonymous: false } };

const renderAt = (entry: string) =>
    render(
        <MemoryRouter initialEntries={[entry]}>
            <Routes>
                <Route path="/s" element={<ShareLinkPage />} />
                <Route path="/join/:token" element={<ShareLinkPage />} />
                <Route path="/doc/:id" element={<p>member viewer</p>} />
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
    peekShareLink.mockResolvedValue({ valid: true, role: 'editor' });
    requestAccountDeletion.mockResolvedValue(undefined);
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('deadLinkMessage and tokenFromHash', () => {
    it('words each dead state', () => {
        expect(deadLinkMessage('revoked')).toBe('The owner turned off this link.');
        expect(deadLinkMessage('expired', '2026-11-20T12:00:00Z')).toBe(
            'This link expired on 20 Nov 2026. Ask the owner to renew it.',
        );
        expect(deadLinkMessage('invalid')).toBe("This link doesn't work. Check you copied all of it.");
        expect(deadLinkMessage('unavailable')).toBe("This score isn't available right now.");
    });

    it('reads the token from the fragment only', () => {
        expect(tokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
        expect(tokenFromHash('#')).toBeNull();
        expect(tokenFromHash('#a b')).toBeNull();
    });
});

describe('ShareLinkPage', () => {
    it('redeems a signed-in visitor as a member (D3), owner included', async () => {
        auth.set({ session: memberSession, loading: false });
        renderAt(`/s#${TOKEN}`);
        expect(await screen.findByText('member viewer')).toBeTruthy();
        expect(redeemShareLink).toHaveBeenCalledWith(TOKEN);
        expect(requestShareSession).not.toHaveBeenCalled();
    });

    it('opens a view link straight into the score: no age screen, no name, no account', async () => {
        requestShareSession.mockResolvedValue({
            kind: 'viewer',
            jwt: 'j',
            exp: 1,
            doc: { id: 'd1', title: 'Für Elise', page_count: 1, content_rev: 0 },
            pdfUrl: 'u',
            linkExpiresAt: null,
        });
        renderAt(`/s#${TOKEN}`);
        expect(await screen.findByText('viewer of Für Elise')).toBeTruthy();
        expect(screen.queryByText(/birth/i)).toBeNull();
        expect(screen.queryByLabelText(/name/i)).toBeNull();
        expect(signInAnonymouslyWithName).not.toHaveBeenCalled();
        expect(redeemShareLink).not.toHaveBeenCalled();
    });

    it.each([
        [{ kind: 'dead', state: 'revoked', expiredAt: null }, 'The owner turned off this link.'],
        [
            { kind: 'dead', state: 'expired', expiredAt: '2026-11-20T12:00:00Z' },
            'This link expired on 20 Nov 2026. Ask the owner to renew it.',
        ],
        [{ kind: 'dead', state: 'unavailable', expiredAt: null }, "This score isn't available right now."],
        [{ kind: 'failed' }, "This score isn't available right now."],
    ])('shows a dead link (%o) with no score', async (answer, message) => {
        requestShareSession.mockResolvedValue(answer);
        renderAt(`/s#${TOKEN}`);
        expect(await screen.findByText(message)).toBeTruthy();
        expect(screen.queryByText(/viewer of/)).toBeNull();
    });

    it('says a link with no general or older link behind it does not work', async () => {
        requestShareSession.mockResolvedValue({ kind: 'dead', state: 'invalid', expiredAt: null });
        peekShareLink.mockResolvedValue({ valid: false });
        renderAt(`/s#${TOKEN}`);
        expect(await screen.findByText("This link doesn't work. Check you copied all of it.")).toBeTruthy();
    });

    it('shows a countdown and Try now when busy, and tries again', async () => {
        requestShareSession
            .mockResolvedValueOnce({ kind: 'busy', retryAfterSec: 30 })
            .mockResolvedValueOnce({ kind: 'dead', state: 'revoked', expiredAt: null });
        renderAt(`/s#${TOKEN}`);
        expect(await screen.findByText(/Trying again in 30 s/)).toBeTruthy();
        await userEvent.click(screen.getByRole('button', { name: 'Try now' }));
        expect(await screen.findByText('The owner turned off this link.')).toBeTruthy();
        expect(requestShareSession).toHaveBeenCalledTimes(2);
    });

    it('lets an editor-link visitor in with no name, as a link guest, with no age screen', async () => {
        requestShareSession.mockResolvedValue({ kind: 'editor', linkExpiresAt: null });
        renderAt(`/s#${TOKEN}`);
        expect(await screen.findByText('Join to edit')).toBeTruthy();
        expect(screen.getByLabelText('Your name (optional)')).toBeTruthy();
        expect(screen.queryByText(/birth/i)).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: 'Continue without a name' }));
        expect(await screen.findByText('member viewer')).toBeTruthy();
        expect(signInAnonymouslyWithName).toHaveBeenCalledWith(undefined, null, LINK_GUEST_GATE);
    });

    it('sends the typed name with Continue', async () => {
        requestShareSession.mockResolvedValue({ kind: 'editor', linkExpiresAt: null });
        renderAt(`/s#${TOKEN}`);
        await userEvent.type(await screen.findByLabelText('Your name (optional)'), '  Sam ');
        await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
        expect(await screen.findByText('member viewer')).toBeTruthy();
        expect(signInAnonymouslyWithName).toHaveBeenCalledWith('Sam', null, LINK_GUEST_GATE);
    });

    it('offers an older (legacy) link the same card, labelled with its role', async () => {
        requestShareSession.mockResolvedValue({ kind: 'dead', state: 'invalid', expiredAt: null });
        peekShareLink.mockResolvedValue({ valid: true, role: 'viewer' });
        renderAt(`/join/${TOKEN}`);
        expect(await screen.findByText('Join to view')).toBeTruthy();
    });

    it('deletes the guest it made when the link died before the redeem', async () => {
        requestShareSession
            .mockResolvedValueOnce({ kind: 'editor', linkExpiresAt: null })
            .mockResolvedValueOnce({ kind: 'dead', state: 'revoked', expiredAt: null });
        redeemShareLink.mockRejectedValue(new Error('invalid_link'));
        renderAt(`/s#${TOKEN}`);
        await userEvent.click(await screen.findByRole('button', { name: 'Continue without a name' }));
        expect(await screen.findByText('The owner turned off this link.')).toBeTruthy();
        expect(requestAccountDeletion).toHaveBeenCalledTimes(1);
        expect(forgetLocalSession).toHaveBeenCalledTimes(1);
    });

    it('moves a /join/<token> path into the fragment', async () => {
        const replace = vi.spyOn(window.history, 'replaceState');
        requestShareSession.mockResolvedValue({ kind: 'editor', linkExpiresAt: null });
        renderAt(`/join/${TOKEN}`);
        await act(async () => undefined);
        expect(replace.mock.calls[0]?.slice(1)).toEqual(['', `/s#${TOKEN}`]);
        replace.mockRestore();
    });
});
