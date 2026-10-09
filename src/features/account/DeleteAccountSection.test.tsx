import type { Session } from '@supabase/supabase-js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as AccountDeletionModule from '@/features/account/accountDeletion';
import { DeleteAccountSection } from '@/features/account/DeleteAccountSection';

const requestAccountDeletion = vi.fn();
const clearLocalAccountData = vi.fn();

vi.mock('@/features/account/accountDeletion', async () => {
    const actual = await vi.importActual<typeof AccountDeletionModule>('@/features/account/accountDeletion');
    return {
        ...actual,
        requestAccountDeletion: (...args: unknown[]) => requestAccountDeletion(...args),
        clearLocalAccountData: (...args: unknown[]) => clearLocalAccountData(...args),
    };
});

const sessionFor = (appMetadata: Record<string, unknown> = {}): Session =>
    ({
        user: { id: 'teacher-1', email: 'teacher@example.com', app_metadata: appMetadata, user_metadata: {} },
    }) as unknown as Session;

/** The dialog links to /forgot-password, so it renders inside a router as on the Account page. */
const renderSection = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

const openDialog = async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete account…' }));
    return user;
};

describe('DeleteAccountSection', () => {
    beforeEach(() => {
        requestAccountDeletion.mockReset().mockResolvedValue(undefined);
        clearLocalAccountData.mockReset().mockResolvedValue(undefined);
    });

    afterEach(cleanup);

    it('lists the consequences before anything can be deleted', async () => {
        renderSection(<DeleteAccountSection session={sessionFor()} onDeleted={vi.fn()} />);
        await openDialog();
        const dialog = screen.getByRole('dialog', { name: 'Delete your account?' });
        expect(dialog).toHaveTextContent('subscription is cancelled immediately');
        expect(dialog).toHaveTextContent('Student accounts you created are deleted');
        expect(dialog).toHaveTextContent('cannot be undone');
    });

    it('will not submit until DELETE is typed and a password entered', async () => {
        renderSection(<DeleteAccountSection session={sessionFor()} onDeleted={vi.fn()} />);
        const user = await openDialog();
        const submit = screen.getByRole('button', { name: 'Delete my account' });
        expect(submit).toBeDisabled();

        await user.type(screen.getByLabelText('Type DELETE to confirm'), 'delete');
        await user.type(screen.getByLabelText('Your password'), 'pw');
        expect(submit).toBeDisabled();

        await user.clear(screen.getByLabelText('Type DELETE to confirm'));
        await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
        expect(submit).toBeEnabled();
        expect(requestAccountDeletion).not.toHaveBeenCalled();
    });

    it('deletes, clears this device, then leaves — in that order', async () => {
        const order: string[] = [];
        requestAccountDeletion.mockImplementation(async () => {
            order.push('server');
        });
        clearLocalAccountData.mockImplementation(async () => {
            order.push('device');
        });
        const onDeleted = vi.fn(() => order.push('leave'));
        renderSection(<DeleteAccountSection session={sessionFor()} onDeleted={onDeleted} />);
        const user = await openDialog();
        await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
        await user.type(screen.getByLabelText('Your password'), 'correct horse');
        await user.click(screen.getByRole('button', { name: 'Delete my account' }));

        await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
        expect(requestAccountDeletion).toHaveBeenCalledWith('correct horse');
        expect(order).toEqual(['server', 'device', 'leave']);
    });

    it('keeps the account and the device untouched when the server refuses', async () => {
        const { AccountDeletionError } = await vi.importActual<typeof AccountDeletionModule>(
            '@/features/account/accountDeletion',
        );
        requestAccountDeletion.mockRejectedValue(
            new AccountDeletionError('That password is not correct.', 'reauthentication_failed', 403),
        );
        const onDeleted = vi.fn();
        renderSection(<DeleteAccountSection session={sessionFor()} onDeleted={onDeleted} />);
        const user = await openDialog();
        await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
        await user.type(screen.getByLabelText('Your password'), 'wrong');
        await user.click(screen.getByRole('button', { name: 'Delete my account' }));

        expect(await screen.findByText('That password is not correct.')).toBeInTheDocument();
        // Someone who never had a password (an upgraded share-link guest) is
        // told how to get one, right beside the error.
        const hint = screen.getByText(/Never set a password, or forgotten it\?/);
        expect(hint.previousElementSibling).toHaveTextContent('That password is not correct.');
        expect(screen.getByRole('link', { name: 'Reset it' })).toHaveAttribute('href', '/forgot-password');
        expect(screen.getAllByRole('link', { name: 'Reset it' })).toHaveLength(1);
        expect(clearLocalAccountData).not.toHaveBeenCalled();
        expect(onDeleted).not.toHaveBeenCalled();
        // Still open, ready for another try.
        expect(screen.getByRole('button', { name: 'Delete my account' })).toBeEnabled();
    });

    it('offers a password reset to an account that may never have had a password', async () => {
        renderSection(<DeleteAccountSection session={sessionFor()} onDeleted={vi.fn()} />);
        await openDialog();
        expect(screen.getByRole('dialog')).toHaveTextContent('Never set a password, or forgotten it?');
        expect(screen.getByRole('link', { name: 'Reset it' })).toHaveAttribute('href', '/forgot-password');
    });

    it('closes without deleting when the person keeps their account', async () => {
        renderSection(<DeleteAccountSection session={sessionFor()} onDeleted={vi.fn()} />);
        const user = await openDialog();
        await user.click(screen.getByRole('button', { name: 'Keep my account' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(requestAccountDeletion).not.toHaveBeenCalled();
    });

    it('explains to a provisioned student that their teacher manages the account', () => {
        renderSection(<DeleteAccountSection session={sessionFor({ user_type: 'student' })} onDeleted={vi.fn()} />);
        expect(screen.getByText(/Your teacher manages this account/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Delete account…' })).not.toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'support@cleffy.io' })).toHaveAttribute(
            'href',
            'mailto:support@cleffy.io',
        );
    });
});
