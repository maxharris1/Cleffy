import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CancelApi from '@/features/billing/cancelApi';
import { CancelPage } from '@/features/billing/CancelPage';

const requestCancelLink = vi.fn();
const peekCancel = vi.fn();
const confirmCancel = vi.fn();

vi.mock('@/features/billing/cancelApi', async (importOriginal) => ({
    ...(await importOriginal<typeof CancelApi>()),
    requestCancelLink: (...args: unknown[]) => requestCancelLink(...args),
    peekCancel: (...args: unknown[]) => peekCancel(...args),
    confirmCancel: (...args: unknown[]) => confirmCancel(...args),
}));

const renderAt = (path: string) =>
    render(
        <MemoryRouter initialEntries={[path]}>
            <CancelPage />
        </MemoryRouter>,
    );

describe('CancelPage', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(cleanup);

    it('asks for an email without a sign-in, and answers neutrally', async () => {
        const user = userEvent.setup();
        requestCancelLink.mockResolvedValue({ sent: true });
        renderAt('/cancel');

        await user.type(screen.getByLabelText('Email'), 'ada@example.com');
        await user.click(screen.getByRole('button', { name: 'Email me a cancel link' }));

        expect(requestCancelLink).toHaveBeenCalledWith('ada@example.com');
        expect(await screen.findByText(/If ada@example.com has a Cleffy subscription/)).toBeInTheDocument();
    });

    it('cancels from the emailed link, with the optional refund request', async () => {
        const user = userEvent.setup();
        peekCancel.mockResolvedValue({
            email: 'a•••@example.com',
            plan: 'Teacher',
            status: 'active',
            periodEnd: '2026-11-20T20:00:00.000Z',
            alreadyCancelling: false,
            refundEligible: true,
        });
        confirmCancel.mockResolvedValue({
            cancelled: true,
            cancelledAt: '2026-10-20T20:00:00.000Z',
            endsAt: '2026-11-20T20:00:00.000Z',
            refundRequested: true,
            refundRequestFailed: false,
        });
        renderAt('/cancel?token=tok-123');

        expect(await screen.findByText('Cleffy Teacher')).toBeInTheDocument();
        await user.click(screen.getByRole('checkbox', { name: /request a full refund/ }));
        await user.click(screen.getByRole('button', { name: 'Cancel now' }));

        expect(confirmCancel).toHaveBeenCalledWith('tok-123', true);
        expect(await screen.findByRole('heading', { name: 'Your subscription is cancelled' })).toBeInTheDocument();
        expect(screen.getByText(/passed your refund request/)).toBeInTheDocument();
    });

    it('falls back to the email form for a spent or expired link', async () => {
        const { CancelError } = await import('@/features/billing/cancelApi');
        peekCancel.mockRejectedValue(new CancelError('This cancellation link has expired.', 'link_invalid'));
        renderAt('/cancel?token=old');

        expect(await screen.findByText('This cancellation link has expired.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Email me a cancel link' })).toBeInTheDocument();
    });
});
