import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const syncBeforeSignOut = vi.hoisted(() => vi.fn<() => Promise<SignOutSyncResult>>());

vi.mock('@/features/auth/session', () => ({ syncBeforeSignOut }));

import type { SignOutSyncResult } from '@/features/auth/session';
import { useGuardedSignOut } from '@/features/auth/useGuardedSignOut';

const Harness = ({ doSignOut }: { doSignOut: () => Promise<void> }) => {
    const { requestSignOut, checking, dialog } = useGuardedSignOut(doSignOut);
    return (
        <>
            <button type="button" onClick={() => void requestSignOut()} disabled={checking}>
                {checking ? 'Saving changes…' : 'Sign out'}
            </button>
            {dialog}
        </>
    );
};

beforeEach(() => {
    syncBeforeSignOut.mockReset();
});

afterEach(() => {
    cleanup();
});

describe('useGuardedSignOut', () => {
    it('signs out straight away when everything is synced', async () => {
        const user = userEvent.setup();
        syncBeforeSignOut.mockResolvedValue({ pending: 0, refused: 0 });
        const doSignOut = vi.fn(async () => undefined);
        render(<Harness doSignOut={doSignOut} />);

        await user.click(screen.getByRole('button', { name: 'Sign out' }));

        await waitFor(() => expect(doSignOut).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('warns about unsynced changes and lets the user stay signed in', async () => {
        const user = userEvent.setup();
        syncBeforeSignOut.mockResolvedValue({ pending: 3, refused: 0 });
        const doSignOut = vi.fn(async () => undefined);
        render(<Harness doSignOut={doSignOut} />);

        await user.click(screen.getByRole('button', { name: 'Sign out' }));

        const dialog = await screen.findByRole('dialog', { name: 'Sign out with unsynced changes?' });
        expect(dialog).toHaveTextContent('You have 3 unsynced changes');
        await user.click(screen.getByRole('button', { name: 'Stay signed in' }));

        expect(doSignOut).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('signs out anyway when the user confirms', async () => {
        const user = userEvent.setup();
        syncBeforeSignOut.mockResolvedValue({ pending: 1, refused: 0 });
        const doSignOut = vi.fn(async () => undefined);
        render(<Harness doSignOut={doSignOut} />);

        await user.click(screen.getByRole('button', { name: 'Sign out' }));
        expect(await screen.findByRole('dialog')).toHaveTextContent('You have 1 unsynced change ');
        await user.click(screen.getByRole('button', { name: 'Sign out anyway' }));

        expect(doSignOut).toHaveBeenCalledTimes(1);
    });

    it('shows progress while the pre-sign-out upload runs', async () => {
        const user = userEvent.setup();
        let finish: (r: SignOutSyncResult) => void = () => undefined;
        syncBeforeSignOut.mockReturnValue(new Promise<SignOutSyncResult>((resolve) => (finish = resolve)));
        const doSignOut = vi.fn(async () => undefined);
        render(<Harness doSignOut={doSignOut} />);

        await user.click(screen.getByRole('button', { name: 'Sign out' }));
        expect(screen.getByRole('button', { name: 'Saving changes…' })).toBeDisabled();

        finish({ pending: 0, refused: 0 });
        await waitFor(() => expect(doSignOut).toHaveBeenCalledTimes(1));
    });

    it('tells the user about changes the server refused, even when nothing is left pending', async () => {
        const user = userEvent.setup();
        syncBeforeSignOut.mockResolvedValue({ pending: 0, refused: 2 });
        const doSignOut = vi.fn(async () => undefined);
        render(<Harness doSignOut={doSignOut} />);

        await user.click(screen.getByRole('button', { name: 'Sign out' }));

        const dialog = await screen.findByRole('dialog', { name: 'Some changes could not be saved' });
        expect(dialog).toHaveTextContent('2 changes to your marks were refused by the server');
        expect(doSignOut).not.toHaveBeenCalled();
        // Nothing more to lose by leaving: a plain Sign out, not "anyway".
        await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
        expect(doSignOut).toHaveBeenCalledTimes(1);
    });

    it('mentions refused changes alongside the unsynced ones', async () => {
        const user = userEvent.setup();
        syncBeforeSignOut.mockResolvedValue({ pending: 1, refused: 1 });
        render(<Harness doSignOut={vi.fn(async () => undefined)} />);

        await user.click(screen.getByRole('button', { name: 'Sign out' }));

        const dialog = await screen.findByRole('dialog', { name: 'Sign out with unsynced changes?' });
        expect(dialog).toHaveTextContent('You have 1 unsynced change');
        expect(dialog).toHaveTextContent('1 change to your marks was refused by the server');
    });
});
