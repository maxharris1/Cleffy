import { afterEach, describe, expect, it, vi } from 'vitest';

import { CancelError, confirmCancel } from '@/features/billing/cancelApi';

vi.mock('@/lib/supabase', () => ({
    requireSupabaseConfig: () => ({ url: 'https://project.test', anonKey: 'anon-key' }),
}));

const answer = (body: unknown, status: number) =>
    vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
            new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
        );

const NOTHING_TO_CANCEL = {
    error: 'There is no active subscription on this account to cancel.',
    code: 'nothing_to_cancel',
};

describe('confirmCancel', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a subscription Stripe had already ended still reports the refund request that went (decision 72(1))', async () => {
        answer({ ...NOTHING_TO_CANCEL, refundRequested: true, refundRequestFailed: false }, 404);
        await expect(confirmCancel('tok-123', true)).resolves.toEqual({
            cancelled: false,
            alreadyEnded: true,
            refundRequested: true,
            refundRequestFailed: false,
        });
    });

    it('and one that could not be sent, so the page tells the buyer to write in', async () => {
        answer({ ...NOTHING_TO_CANCEL, refundRequested: false, refundRequestFailed: true }, 404);
        await expect(confirmCancel('tok-123', true)).resolves.toMatchObject({
            alreadyEnded: true,
            refundRequestFailed: true,
        });
    });

    it('with no refund asked for, nothing to cancel is the refusal it always was', async () => {
        answer({ ...NOTHING_TO_CANCEL, refundRequested: false, refundRequestFailed: false }, 404);
        const refused = confirmCancel('tok-123', false);
        await expect(refused).rejects.toBeInstanceOf(CancelError);
        await expect(refused).rejects.toMatchObject({ code: 'nothing_to_cancel', refund: undefined });
    });
});
