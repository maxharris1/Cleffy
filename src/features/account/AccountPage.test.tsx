import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountPage } from '@/features/account/AccountPage';
import type * as OfflineStorageModule from '@/features/account/offlineStorage';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import type { EntitlementLimits, Entitlements } from '@/types/database';

const updateDisplayName = vi.fn();
const updatePassword = vi.fn();
const signOut = vi.fn();
const useSession = vi.fn();

const loadUsage = vi.fn();
const clearCachedEntitlements = vi.fn();
const loadEntitlements = vi.fn();
const readCachedEntitlements = vi.fn();

const createPortalSession = vi.fn();
const redirectTo = vi.fn();

const readOfflineStorage = vi.fn();
const clearOfflineStorage = vi.fn();

// The real session module reaches for a Supabase client at import time of its
// callers; only the pieces this page uses are stubbed, with displayNameOf and
// storedDisplayNameOf kept faithful so the avatar/initials assertions are real.
vi.mock('@/features/auth/session', () => ({
    useSession: () => useSession(),
    displayNameOf: (session: { user?: { email?: string; user_metadata?: Record<string, unknown> } } | null) => {
        const name = session?.user?.user_metadata?.['display_name'];
        return typeof name === 'string' ? name : (session?.user?.email ?? 'Guest');
    },
    storedDisplayNameOf: (session: { user?: { user_metadata?: Record<string, unknown> } } | null) => {
        const name = session?.user?.user_metadata?.['display_name'];
        return typeof name === 'string' ? name : '';
    },
    updateDisplayName: (...args: unknown[]) => updateDisplayName(...args),
    updatePassword: (...args: unknown[]) => updatePassword(...args),
    signOut: (...args: unknown[]) => signOut(...args),
}));

vi.mock('@/features/billing/entitlementsService', () => ({
    loadUsage: (...args: unknown[]) => loadUsage(...args),
    clearCachedEntitlements: (...args: unknown[]) => clearCachedEntitlements(...args),
    loadEntitlements: (...args: unknown[]) => loadEntitlements(...args),
    readCachedEntitlements: (...args: unknown[]) => readCachedEntitlements(...args),
}));

vi.mock('@/features/billing/billingApi', () => ({
    NoBillingAccountError: class NoBillingAccountError extends Error {},
    createPortalSession: (...args: unknown[]) => createPortalSession(...args),
    redirectTo: (...args: unknown[]) => redirectTo(...args),
}));

// Dexie stands behind this module; the page only ever sees the two functions.
vi.mock('@/features/account/offlineStorage', async () => {
    const actual = await vi.importActual<typeof OfflineStorageModule>('@/features/account/offlineStorage');
    return {
        formatMegabytes: actual.formatMegabytes,
        readOfflineStorage: (...args: unknown[]) => readOfflineStorage(...args),
        clearOfflineStorage: (...args: unknown[]) => clearOfflineStorage(...args),
    };
});

vi.mock('@/features/billing/StudioSeats', () => ({
    StudioSeats: () => <div data-testid="studio-seats" />,
}));

vi.mock('@/features/billing/PricingDialog', () => ({
    PricingDialog: () => <div data-testid="pricing-dialog" />,
}));

const FREE_LIMITS: EntitlementLimits = {
    cloud_scores: 3,
    omr_runs: 3,
    vision_reads: 5,
    smart_imports: 2,
    pdf_exports: 1,
    students: 3,
};

const entitlements = (limits: Partial<EntitlementLimits> = {}): Entitlements => ({
    user_id: 'teacher-1',
    tier: 'free',
    status: null,
    source: 'none',
    current_period_end: null,
    limits: { ...FREE_LIMITS, ...limits },
});

const sessionFor = (displayName?: string) => ({
    user: {
        id: 'teacher-1',
        email: 'ada@example.com',
        created_at: '2026-01-14T10:00:00Z',
        user_metadata: displayName === undefined ? {} : { display_name: displayName },
    },
});

const outletContext: LibraryOutletContext = {
    userId: 'teacher-1',
    uploadPct: null,
    uploading: false,
    onUpload: vi.fn(),
    onImportImslp: vi.fn(),
    uploadError: null,
    clearUploadError: vi.fn(),
    uploadLimit: null,
    tier: 'free',
    openPricing: vi.fn(),
};

const ContextFrame = () => <Outlet context={outletContext} />;

const renderAccount = () =>
    render(
        <MemoryRouter initialEntries={['/account']}>
            <Routes>
                <Route element={<ContextFrame />}>
                    <Route path="/account" element={<AccountPage />} />
                </Route>
            </Routes>
        </MemoryRouter>,
    );

/** Wait past the first paint: entitlements, usage and storage all resolve async. */
const renderSettled = async () => {
    const result = renderAccount();
    expect(await screen.findByRole('heading', { name: 'Account' })).toBeInTheDocument();
    return result;
};

beforeEach(() => {
    vi.clearAllMocks();
    useSession.mockReturnValue({ session: sessionFor(), loading: false, lastEvent: null });
    loadEntitlements.mockResolvedValue(entitlements());
    readCachedEntitlements.mockResolvedValue(null);
    loadUsage.mockResolvedValue({ omr_runs: 2 });
    readOfflineStorage.mockResolvedValue({ scoreCount: 4, bytes: 12_582_912 });
    clearOfflineStorage.mockResolvedValue(undefined);
    updateDisplayName.mockResolvedValue(undefined);
    updatePassword.mockResolvedValue(undefined);
    clearCachedEntitlements.mockResolvedValue(undefined);
    signOut.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('AccountPage', () => {
    it('shows the email and an avatar built from it when no name is set', async () => {
        await renderSettled();

        // Exactly once: with no name to show, the address IS the headline, and
        // repeating it under an "Email" label would just be the same fact twice.
        expect(screen.getAllByText('ada@example.com')).toHaveLength(1);
        // initialsOf falls back to the local part of the address.
        expect(screen.getByText('AD')).toBeInTheDocument();
        // Locale decides the month's spelling; the year is the part under test.
        expect(screen.getByText(/^Member since .*2026$/)).toBeInTheDocument();
    });

    it('prefers the stored display name for the avatar and seeds the field with it', async () => {
        useSession.mockReturnValue({ session: sessionFor('Ada Lovelace'), loading: false, lastEvent: null });
        await renderSettled();

        expect(screen.getByText('AL')).toBeInTheDocument();
        expect(screen.getByLabelText('Display name')).toHaveValue('Ada Lovelace');
    });

    it('saves a display name through the session helper', async () => {
        const user = userEvent.setup();
        await renderSettled();

        const save = screen.getByRole('button', { name: 'Save name' });
        expect(save).toBeDisabled();

        await user.type(screen.getByLabelText('Display name'), 'Ada Lovelace');
        expect(save).toBeEnabled();
        await user.click(save);

        expect(updateDisplayName).toHaveBeenCalledExactlyOnceWith('Ada Lovelace');
        expect(await screen.findByText('Name saved.')).toBeInTheDocument();
    });

    it('refuses a mismatched password without calling the session helper', async () => {
        const user = userEvent.setup();
        await renderSettled();

        await user.type(screen.getByLabelText('New password'), 'correct-horse');
        await user.type(screen.getByLabelText('Confirm new password'), 'correct-hoarse');
        await user.click(screen.getByRole('button', { name: 'Change password' }));

        expect(await screen.findByText('Those two passwords do not match.')).toBeInTheDocument();
        expect(updatePassword).not.toHaveBeenCalled();
    });

    it('refuses a password under the minimum length', async () => {
        const user = userEvent.setup();
        await renderSettled();

        await user.type(screen.getByLabelText('New password'), 'short');
        await user.type(screen.getByLabelText('Confirm new password'), 'short');
        await user.click(screen.getByRole('button', { name: 'Change password' }));

        expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument();
        expect(updatePassword).not.toHaveBeenCalled();
    });

    it('changes the password once and clears both fields', async () => {
        const user = userEvent.setup();
        await renderSettled();

        const next = screen.getByLabelText('New password');
        const confirm = screen.getByLabelText('Confirm new password');
        await user.type(next, 'correct-horse');
        await user.type(confirm, 'correct-horse');
        await user.click(screen.getByRole('button', { name: 'Change password' }));

        expect(updatePassword).toHaveBeenCalledExactlyOnceWith('correct-horse');
        expect(await screen.findByText('Password changed.')).toBeInTheDocument();
        expect(next).toHaveValue('');
        expect(confirm).toHaveValue('');
    });

    it('meters a capped allowance and writes "unlimited" with no bar for an uncapped one', async () => {
        loadEntitlements.mockResolvedValue(entitlements({ omr_runs: -1 }));
        await renderSettled();

        expect(await screen.findByText('unlimited')).toBeInTheDocument();
        // Three capped metered rows remain; the unlimited one contributes no bar.
        await waitFor(() => expect(screen.getAllByRole('progressbar')).toHaveLength(3));
        expect(
            screen.queryByRole('progressbar', { name: 'Play-along analyses used this month' }),
        ).not.toBeInTheDocument();
        expect(screen.getByRole('progressbar', { name: 'AI fingering reads used this month' })).toBeInTheDocument();
    });

    it('fills a meter in proportion to what was used', async () => {
        await renderSettled();

        // omr_runs: 2 of 3.
        const bar = await screen.findByRole('progressbar', { name: 'Play-along analyses used this month' });
        expect(bar).toHaveAttribute('aria-valuenow', '67');
        expect(screen.getByText('2 of 3 used this month')).toBeInTheDocument();
    });

    it('reports what this device is holding', async () => {
        await renderSettled();
        expect(await screen.findByText(/4 scores downloaded to this device, using about 12\.0 MB/)).toBeInTheDocument();
    });

    it('does not clear downloads until the confirmation is accepted', async () => {
        const user = userEvent.setup();
        await renderSettled();

        const remove = await screen.findByRole('button', { name: 'Remove downloaded scores' });
        await waitFor(() => expect(remove).toBeEnabled());
        await user.click(remove);

        expect(await screen.findByText('Remove downloaded scores?')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(clearOfflineStorage).not.toHaveBeenCalled();

        await user.click(remove);
        readOfflineStorage.mockResolvedValue({ scoreCount: 0, bytes: 0 });
        await user.click(screen.getByRole('button', { name: 'Remove' }));

        expect(clearOfflineStorage).toHaveBeenCalledOnce();
        expect(await screen.findByText('Downloaded scores removed.')).toBeInTheDocument();
        expect(screen.getByText('No scores are downloaded to this device yet.')).toBeInTheDocument();
    });

    it('drops the cached plan before signing out', async () => {
        const user = userEvent.setup();
        await renderSettled();

        await user.click(screen.getByRole('button', { name: 'Sign out' }));

        expect(clearCachedEntitlements).toHaveBeenCalledWith('teacher-1');
        expect(signOut).toHaveBeenCalledOnce();
    });
});
