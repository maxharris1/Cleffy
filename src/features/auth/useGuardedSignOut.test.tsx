import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const syncBeforeSignOut = vi.hoisted(() => vi.fn<() => Promise<number>>());

vi.mock('@/features/auth/session', () => ({ syncBeforeSignOut }));

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
        syncBeforeSignOut.mockResolvedValue(0);
        const doSignOut = vi.fn(async () => undefined);
        render(<Harness doSignOut={doSignOut} />);

        await user.click(screen.getByRole('button', { name: 'Sign out' }));

        await waitFor(() => expect(doSignOut).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('warns about unsynced changes and lets the user stay signed in', async () => {
        const user = userEvent.setup();
        syncBeforeSignOut.mockResolvedValue(3);
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
        syncBeforeSignOut.mockResolvedValue(1);
        const doSignOut = vi.fn(async () => undefined);
        render(<Harness doSignOut={doSignOut} />);

        await user.click(screen.getByRole('button', { name: 'Sign out' }));
        expect(await screen.findByRole('dialog')).toHaveTextContent('You have 1 unsynced change ');
        await user.click(screen.getByRole('button', { name: 'Sign out anyway' }));

        expect(doSignOut).toHaveBeenCalledTimes(1);
    });

    it('shows progress while the pre-sign-out upload runs', async () => {
        const user = userEvent.setup();
        let finish: (n: number) => void = () => undefined;
        syncBeforeSignOut.mockReturnValue(new Promise<number>((resolve) => (finish = resolve)));
        const doSignOut = vi.fn(async () => undefined);
        render(<Harness doSignOut={doSignOut} />);

        await user.click(screen.getByRole('button', { name: 'Sign out' }));
        expect(screen.getByRole('button', { name: 'Saving changes…' })).toBeDisabled();

        finish(0);
        await waitFor(() => expect(doSignOut).toHaveBeenCalledTimes(1));
    });
});
