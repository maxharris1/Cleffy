import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JoinPage } from '@/features/share/JoinPage';

const useSession = vi.fn();
const signInAnonymouslyWithName = vi.fn();
const redeemShareLink = vi.fn();

vi.mock('@/features/auth/session', () => ({
    useSession: () => useSession(),
    isRegisteredSession: () => false,
    signInAnonymouslyWithName: (...args: unknown[]) => signInAnonymouslyWithName(...args),
}));

vi.mock('@/features/share/shareService', () => ({
    redeemShareLink: (...args: unknown[]) => redeemShareLink(...args),
}));

const renderJoin = () =>
    render(
        <MemoryRouter initialEntries={['/join/token-1']}>
            <Routes>
                <Route path="/join/:token" element={<JoinPage />} />
            </Routes>
        </MemoryRouter>,
    );

beforeEach(() => {
    vi.clearAllMocks();
    useSession.mockReturnValue({ session: null, loading: false, lastEvent: null });
});

afterEach(cleanup);

describe('JoinPage', () => {
    it('keeps the name field after a validation error', async () => {
        renderJoin();
        await userEvent.click(screen.getByRole('button', { name: 'Join' }));
        expect(screen.getByText('Enter your name so collaborators know who you are.')).toBeInTheDocument();
        expect(screen.getByLabelText('Your name')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
    });

    it('keeps a retry when redeeming an existing session fails', async () => {
        useSession.mockReturnValue({
            session: { user: { id: 'u1' } },
            loading: false,
            lastEvent: null,
        });
        redeemShareLink.mockRejectedValue(new Error('invalid_link'));
        renderJoin();
        expect(
            await screen.findByText('This link is invalid, expired, or was revoked. Ask for a new one.'),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Back to home' })).toBeInTheDocument();
        expect(screen.queryByText(/could not join/i)).toBeNull();
    });

    it('retries redeem without leaking a vendor message', async () => {
        useSession.mockReturnValue({
            session: { user: { id: 'u1' } },
            loading: false,
            lastEvent: null,
        });
        redeemShareLink
            .mockRejectedValueOnce(new Error('invalid_link'))
            .mockRejectedValueOnce(new Error('upstream 503'));
        renderJoin();
        await screen.findByRole('button', { name: 'Try again' });
        await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(redeemShareLink).toHaveBeenCalledTimes(2));
        expect(screen.getByText('Could not join this score. Check your connection and try again.')).toBeInTheDocument();
        expect(screen.queryByText(/upstream 503/)).toBeNull();
    });
});
