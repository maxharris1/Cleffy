import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmGuestEmailUpgrade, GuestUpgradeError, startGuestEmailUpgrade } from '@/features/auth/guestUpgrade';

const callEdgeFunction = vi.hoisted(() => vi.fn());
const refreshSession = vi.hoisted(() => vi.fn());

vi.mock('@/features/billing/billingApi', () => ({
    callEdgeFunction: (...args: unknown[]) => callEdgeFunction(...args),
}));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({ auth: { refreshSession } }),
}));

const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
    callEdgeFunction.mockReset();
    refreshSession.mockReset();
});

describe('guest email upgrade client', () => {
    it('asks the start function to mail a code, and nothing else', async () => {
        callEdgeFunction.mockResolvedValue(reply(200, { sent: true, expiresInSec: 900 }));
        await startGuestEmailUpgrade(' ada@example.com ');
        expect(callEdgeFunction).toHaveBeenCalledWith('guest-email-start', { email: 'ada@example.com' });
        expect(refreshSession).not.toHaveBeenCalled();
    });

    it('confirms with the code and password, then refreshes the session so it is no longer a guest’s', async () => {
        callEdgeFunction.mockResolvedValue(reply(200, { ok: true, email: 'ada@example.com' }));
        refreshSession.mockResolvedValue({ data: {}, error: null });
        await confirmGuestEmailUpgrade({ email: 'ada@example.com', code: '482913', password: 'Correct1horse' });
        expect(callEdgeFunction).toHaveBeenCalledWith('guest-email-confirm', {
            email: 'ada@example.com',
            code: '482913',
            password: 'Correct1horse',
        });
        expect(refreshSession).toHaveBeenCalledTimes(1);
    });

    it('carries the server’s refusal and code, and refreshes nothing', async () => {
        callEdgeFunction.mockResolvedValue(
            reply(409, {
                error: 'An account with this email already exists. Sign in to it instead.',
                code: 'email_in_use',
            }),
        );
        const failure = confirmGuestEmailUpgrade({ email: 'a@example.com', code: '111111', password: 'Correct1horse' });
        await expect(failure).rejects.toBeInstanceOf(GuestUpgradeError);
        await expect(failure).rejects.toMatchObject({ code: 'email_in_use' });
        expect(refreshSession).not.toHaveBeenCalled();
    });

    it('says the network failed when the request never got an answer', async () => {
        callEdgeFunction.mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(startGuestEmailUpgrade('a@example.com')).rejects.toMatchObject({
            code: null,
            message: expect.stringMatching(/Could not reach Cleffy/),
        });
    });
});
