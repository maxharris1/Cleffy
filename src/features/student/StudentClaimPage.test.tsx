import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as sessionModule from '@/features/auth/session';
import { StudentClaimPage } from '@/features/student/StudentClaimPage';
import { StudentAuthError } from '@/features/student/studentApi';
import type * as studentApiModule from '@/features/student/studentApi';

const claimStudentAccount = vi.fn();

// Spread the real module rather than replacing it: the page branches on
// `instanceof StudentAuthError`, so the class the test throws has to be the very
// class the page imports.
vi.mock('@/features/student/studentApi', async (importOriginal) => ({
    ...(await importOriginal<typeof studentApiModule>()),
    claimStudentAccount: (...args: unknown[]) => claimStudentAccount(...args),
}));

vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<typeof sessionModule>()),
    useSession: () => ({ session: null, loading: false, lastEvent: null }),
}));

const renderClaim = () =>
    render(
        <MemoryRouter initialEntries={['/student/claim']}>
            <Routes>
                <Route path="/student/claim" element={<StudentClaimPage />} />
                <Route path="/student" element={<p>sign in</p>} />
                <Route path="/assignments" element={<p>your pieces</p>} />
            </Routes>
        </MemoryRouter>,
    );

/** Through step one with a code of the right shape, onto the credential step. */
const enterCode = async (user: ReturnType<typeof userEvent.setup>, code = 'ABCD-EFGH-JKMN') => {
    await user.type(screen.getByLabelText('Setup code'), code);
    await user.click(screen.getByRole('button', { name: 'Next' }));
};

const fillCredentials = async (
    user: ReturnType<typeof userEvent.setup>,
    username = 'ada_lovelace',
    password = 'hunter2hunter2',
    confirm = password,
) => {
    await user.type(screen.getByLabelText('Username'), username);
    await user.type(screen.getByLabelText('Password'), password);
    await user.type(screen.getByLabelText('Confirm password'), confirm);
};

beforeEach(() => {
    vi.clearAllMocks();
    claimStudentAccount.mockResolvedValue('Ada Lovelace');
});

afterEach(() => {
    cleanup();
});

describe('StudentClaimPage', () => {
    it('refuses an incomplete code without asking the server about it', async () => {
        const user = userEvent.setup();
        renderClaim();

        await user.type(screen.getByLabelText('Setup code'), 'ABCD');
        await user.click(screen.getByRole('button', { name: 'Next' }));

        expect(screen.getByRole('status')).toHaveTextContent('That doesn’t look like a complete code');
        // Checking a code with the server before the student has committed to a
        // credential is exactly the oracle student-claim refuses to be.
        expect(claimStudentAccount).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Setup code')).toBeInTheDocument();
    });

    it('spends the code, the username and the password in one call, then opens the assignments', async () => {
        const user = userEvent.setup();
        renderClaim();

        await enterCode(user);
        await fillCredentials(user);
        await user.click(screen.getByRole('button', { name: 'Create my account' }));

        // Code verbatim (the function folds dashes); username normalized, because
        // that spelling is the one the student was just shown.
        expect(claimStudentAccount).toHaveBeenCalledWith({
            code: 'ABCD-EFGH-JKMN',
            username: 'ada_lovelace',
            password: 'hunter2hunter2',
        });
        expect(await screen.findByText('your pieces')).toBeInTheDocument();
    });

    it('normalizes a username typed in capitals and says so before it is claimed', async () => {
        const user = userEvent.setup();
        renderClaim();

        await enterCode(user);
        await fillCredentials(user, 'Ada_Lovelace');
        expect(screen.getByText(/You will sign in as/)).toHaveTextContent('ada_lovelace');

        await user.click(screen.getByRole('button', { name: 'Create my account' }));
        expect(claimStudentAccount).toHaveBeenCalledWith(expect.objectContaining({ username: 'ada_lovelace' }));
    });

    it('blocks an invalid username and a short password client-side', async () => {
        const user = userEvent.setup();
        renderClaim();

        await enterCode(user);
        await fillCredentials(user, 'no');
        await user.click(screen.getByRole('button', { name: 'Create my account' }));
        expect(screen.getByRole('status')).toHaveTextContent('3-20 lowercase letters, numbers and underscores');
        expect(claimStudentAccount).not.toHaveBeenCalled();

        await user.clear(screen.getByLabelText('Username'));
        await user.type(screen.getByLabelText('Username'), 'ada_lovelace');
        await user.clear(screen.getByLabelText('Password'));
        await user.clear(screen.getByLabelText('Confirm password'));
        await user.type(screen.getByLabelText('Password'), 'short');
        await user.type(screen.getByLabelText('Confirm password'), 'short');
        await user.click(screen.getByRole('button', { name: 'Create my account' }));

        expect(screen.getByRole('status')).toHaveTextContent('at least 8 characters');
        expect(claimStudentAccount).not.toHaveBeenCalled();
    });

    it('keeps everything typed when the server says the username is taken', async () => {
        const user = userEvent.setup();
        claimStudentAccount.mockRejectedValue(new StudentAuthError('That username is taken', 'username_taken'));
        renderClaim();

        await enterCode(user);
        await fillCredentials(user);
        await user.click(screen.getByRole('button', { name: 'Create my account' }));

        expect(await screen.findByText('That username is taken')).toBeInTheDocument();
        expect(screen.getByLabelText('Username')).toHaveValue('ada_lovelace');
        expect(screen.getByLabelText('Password')).toHaveValue('hunter2hunter2');
    });

    it('returns to the code step with the code still typed when the code is refused', async () => {
        const user = userEvent.setup();
        claimStudentAccount.mockRejectedValue(new StudentAuthError('That code did not work', 'invalid_code'));
        renderClaim();

        await enterCode(user);
        await fillCredentials(user);
        await user.click(screen.getByRole('button', { name: 'Create my account' }));

        expect(await screen.findByText('That code did not work')).toBeInTheDocument();
        expect(screen.getByLabelText('Setup code')).toHaveValue('ABCD-EFGH-JKMN');
    });

    it('sends them to sign in when the claim landed but the session did not', async () => {
        const user = userEvent.setup();
        claimStudentAccount.mockRejectedValue(
            new StudentAuthError('Your account is set up — sign in with your new username.', 'claimed_sign_in_failed'),
        );
        renderClaim();

        await enterCode(user);
        await fillCredentials(user);
        await user.click(screen.getByRole('button', { name: 'Create my account' }));

        // The code is spent: nothing here may suggest trying again.
        expect(await screen.findByText('Your account is set up — sign in with your new username.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Create my account' })).not.toBeInTheDocument();
        await user.click(screen.getByRole('link', { name: 'Go to sign in' }));
        expect(await screen.findByText('sign in')).toBeInTheDocument();
    });
});
