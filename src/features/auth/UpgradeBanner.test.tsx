import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as guestUpgradeModule from '@/features/auth/guestUpgrade';
import { GuestUpgradeError } from '@/features/auth/guestUpgrade';
import { UpgradeBanner } from '@/features/auth/UpgradeBanner';

const startGuestEmailUpgrade = vi.hoisted(() => vi.fn());
const confirmGuestEmailUpgrade = vi.hoisted(() => vi.fn());
const updateUser = vi.hoisted(() => vi.fn());

vi.mock('@/features/auth/guestUpgrade', async (importOriginal) => ({
    ...(await importOriginal<typeof guestUpgradeModule>()),
    startGuestEmailUpgrade: (...args: unknown[]) => startGuestEmailUpgrade(...args),
    confirmGuestEmailUpgrade: (...args: unknown[]) => confirmGuestEmailUpgrade(...args),
}));

// The old path: if anything still reached for updateUser, this would see it.
vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({ auth: { updateUser } }),
}));

afterEach(() => {
    cleanup();
    startGuestEmailUpgrade.mockReset();
    confirmGuestEmailUpgrade.mockReset();
    updateUser.mockReset();
});

const renderBanner = (isGuest = true) =>
    render(
        <MemoryRouter>
            <UpgradeBanner isGuest={isGuest} />
        </MemoryRouter>,
    );

const fillDetails = async (user: ReturnType<typeof userEvent.setup>, email = 'ada@example.com') => {
    await user.click(screen.getByRole('button', { name: 'Add your email to keep it' }));
    await user.type(screen.getByRole('textbox', { name: 'Email' }), email);
    await user.type(screen.getByLabelText('Choose a password'), 'Correct1horse');
    await user.click(screen.getByRole('button', { name: 'Email me a code' }));
};

describe('UpgradeBanner', () => {
    it('attaches the email only after the mailed code comes back — never with updateUser', async () => {
        startGuestEmailUpgrade.mockResolvedValue(undefined);
        confirmGuestEmailUpgrade.mockResolvedValue('signed_in');
        const user = userEvent.setup();
        renderBanner();

        await fillDetails(user);
        // The trailing null is the inertness guarantee: no
        // VITE_TURNSTILE_SITE_KEY in this build, so no widget is rendered and
        // no captchaToken reaches guest-email-start — which admits a tokenless
        // request while it has no TURNSTILE_SECRET_KEY either.
        expect(startGuestEmailUpgrade).toHaveBeenCalledWith('ada@example.com', null);
        expect(confirmGuestEmailUpgrade).not.toHaveBeenCalled();
        expect(screen.getByText(/We emailed a 6-digit code to/)).toBeInTheDocument();

        await user.type(screen.getByRole('textbox', { name: 'Code from the email' }), '482913');
        await user.click(screen.getByRole('button', { name: 'Save my work' }));

        expect(confirmGuestEmailUpgrade).toHaveBeenCalledWith({
            email: 'ada@example.com',
            code: '482913',
            password: 'Correct1horse',
            captchaToken: null,
        });
        expect(screen.getByRole('status')).toHaveTextContent(/Saved\. Your work now belongs to ada@example\.com/);
        expect(updateUser).not.toHaveBeenCalled();
    });

    it('stays up to confirm after the session stops being a guest’s', async () => {
        startGuestEmailUpgrade.mockResolvedValue(undefined);
        confirmGuestEmailUpgrade.mockResolvedValue('signed_in');
        const user = userEvent.setup();
        const { rerender } = renderBanner();
        await fillDetails(user);
        await user.type(screen.getByRole('textbox', { name: 'Code from the email' }), '482913');
        await user.click(screen.getByRole('button', { name: 'Save my work' }));

        rerender(
            <MemoryRouter>
                <UpgradeBanner isGuest={false} />
            </MemoryRouter>,
        );
        expect(screen.getByRole('status')).toHaveTextContent(/Saved/);
    });

    it('says "Saved" only with a registered session, and asks for a sign-in otherwise', async () => {
        startGuestEmailUpgrade.mockResolvedValue(undefined);
        confirmGuestEmailUpgrade.mockResolvedValue('sign_in_needed');
        const user = userEvent.setup();
        renderBanner();
        await fillDetails(user);
        await user.type(screen.getByRole('textbox', { name: 'Code from the email' }), '482913');
        await user.click(screen.getByRole('button', { name: 'Save my work' }));

        const status = screen.getByRole('status');
        expect(status).not.toHaveTextContent(/^Saved/);
        expect(status).toHaveTextContent(/ada@example\.com is saved, but we couldn't sign you back in/);
        expect(screen.getByRole('link', { name: 'Sign in with it' })).toHaveAttribute('href', '/login');
    });

    it('tells the guest to sign in when the address already has an account', async () => {
        startGuestEmailUpgrade.mockRejectedValue(
            new GuestUpgradeError('An account with this email already exists. Sign in to it instead.', 'email_in_use'),
        );
        const user = userEvent.setup();
        renderBanner();
        await fillDetails(user, 'owner@example.com');

        expect(screen.getByRole('alert')).toHaveTextContent(/already exists/);
        expect(screen.getByRole('link', { name: 'Sign in instead' })).toHaveAttribute('href', '/login');
        expect(screen.queryByText(/We emailed/)).not.toBeInTheDocument();
    });

    it('checks the password before asking for a code', async () => {
        const user = userEvent.setup();
        renderBanner();
        await user.click(screen.getByRole('button', { name: 'Add your email to keep it' }));
        await user.type(screen.getByRole('textbox', { name: 'Email' }), 'ada@example.com');
        await user.type(screen.getByLabelText('Choose a password'), 'short');
        await user.click(screen.getByRole('button', { name: 'Email me a code' }));

        expect(screen.getByRole('alert')).toHaveTextContent(/at least 8 characters/);
        expect(startGuestEmailUpgrade).not.toHaveBeenCalled();
    });

    it('renders nothing for a registered account', () => {
        renderBanner(false);
        expect(screen.queryByText(/annotating as a guest/)).not.toBeInTheDocument();
    });
});
