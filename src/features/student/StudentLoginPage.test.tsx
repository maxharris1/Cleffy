import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as sessionModule from '@/features/auth/session';
import { StudentLoginPage } from '@/features/student/StudentLoginPage';

const loginWithCode = vi.fn();

vi.mock('@/features/student/studentApi', () => ({
    loginWithCode: (...args: unknown[]) => loginWithCode(...args),
}));

// Nobody is signed in on this page by definition — it is the page that gets a
// student a session. userTypeOf stays real so that contract is exercised.
vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<typeof sessionModule>()),
    useSession: () => ({ session: null, loading: false, lastEvent: null }),
}));

const renderLogin = () =>
    render(
        <MemoryRouter initialEntries={['/student']}>
            <Routes>
                <Route path="/student" element={<StudentLoginPage />} />
                <Route path="/assignments" element={<p>your pieces</p>} />
            </Routes>
        </MemoryRouter>,
    );

beforeEach(() => {
    vi.clearAllMocks();
    loginWithCode.mockResolvedValue('Ada Lovelace');
});

afterEach(() => {
    cleanup();
});

describe('StudentLoginPage', () => {
    it('offers one field and one button, and no teacher account controls', () => {
        renderLogin();
        expect(screen.getByLabelText('Your code')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Open my music' })).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /Create one/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: /Forgot password/ })).not.toBeInTheDocument();
    });

    it('sends the code exactly as typed and opens the assignments', async () => {
        const user = userEvent.setup();
        renderLogin();

        await user.type(screen.getByLabelText('Your code'), 'abcd-efgh-jklm');
        await user.click(screen.getByRole('button', { name: 'Open my music' }));

        // Unnormalized on purpose: the function folds case and dashes itself.
        expect(loginWithCode).toHaveBeenCalledWith('abcd-efgh-jklm');
        expect(await screen.findByText('your pieces')).toBeInTheDocument();
    });

    it('asks for a code instead of calling the server with nothing', async () => {
        const user = userEvent.setup();
        renderLogin();

        await user.click(screen.getByRole('button', { name: 'Open my music' }));

        // Same words as the page's subtitle, so match the announced error itself.
        expect(screen.getByRole('status')).toHaveTextContent('Type the code your teacher gave you.');
        expect(loginWithCode).not.toHaveBeenCalled();
    });

    it('shows the failure verbatim and stays on the page', async () => {
        const user = userEvent.setup();
        loginWithCode.mockRejectedValue(new Error('Could not reach Cleffy. Check the internet connection.'));
        renderLogin();

        await user.type(screen.getByLabelText('Your code'), 'ABCD-EFGH-JKLM');
        await user.click(screen.getByRole('button', { name: 'Open my music' }));

        expect(await screen.findByText('Could not reach Cleffy. Check the internet connection.')).toBeInTheDocument();
        expect(screen.queryByText('your pieces')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Open my music' })).toBeEnabled();
    });

    it('disables the button while the code is in flight', async () => {
        const user = userEvent.setup();
        loginWithCode.mockReturnValue(new Promise(() => undefined));
        renderLogin();

        await user.type(screen.getByLabelText('Your code'), 'ABCD-EFGH-JKLM');
        await user.click(screen.getByRole('button', { name: 'Open my music' }));

        expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();
        expect(screen.getByLabelText('Your code')).toBeDisabled();
    });
});
