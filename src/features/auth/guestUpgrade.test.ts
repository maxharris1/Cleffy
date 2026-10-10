import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmGuestEmailUpgrade, GuestUpgradeError, startGuestEmailUpgrade } from '@/features/auth/guestUpgrade';

const callEdgeFunction = vi.hoisted(() => vi.fn());
const signInWithPassword = vi.hoisted(() => vi.fn());
const refreshSession = vi.hoisted(() => vi.fn());

vi.mock('@/features/billing/billingApi', () => ({
    callEdgeFunction: (...args: unknown[]) => callEdgeFunction(...args),
}));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({ auth: { signInWithPassword, refreshSession } }),
}));

const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
    callEdgeFunction.mockReset();
    signInWithPassword.mockReset();
    refreshSession.mockReset();
});

const sessionFor = (isAnonymous: boolean) => ({
    data: { session: { user: { id: 'u1', is_anonymous: isAnonymous } }, user: { id: 'u1' } },
    error: null,
});

describe('guest email upgrade client', () => {
    it('asks the start function to mail a code, and nothing else', async () => {
        callEdgeFunction.mockResolvedValue(reply(200, { sent: true, expiresInSec: 900 }));
        await startGuestEmailUpgrade(' ada@example.com ');
        expect(callEdgeFunction).toHaveBeenCalledWith('guest-email-start', { email: 'ada@example.com' });
        expect(signInWithPassword).not.toHaveBeenCalled();
    });

    it('confirms, then signs in with the new password — the attach ended the guest’s session', async () => {
        // The admin API deletes every session of a user whose password it sets,
        // so refreshing the guest's session can never work: only a sign-in can.
        callEdgeFunction.mockResolvedValue(reply(200, { ok: true, email: 'ada@example.com' }));
        signInWithPassword.mockResolvedValue(sessionFor(false));
        refreshSession.mockResolvedValue({
            data: {},
            error: { message: 'Invalid Refresh Token: Refresh Token Not Found' },
        });
        const outcome = await confirmGuestEmailUpgrade({
            email: ' Ada@Example.com ',
            code: '482913',
            password: 'Correct1horse',
        });
        expect(callEdgeFunction).toHaveBeenCalledWith('guest-email-confirm', {
            email: 'Ada@Example.com',
            code: '482913',
            password: 'Correct1horse',
        });
        // With the address as the server stored it.
        expect(signInWithPassword).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'Correct1horse' });
        expect(refreshSession).not.toHaveBeenCalled();
        expect(outcome).toBe('signed_in');
    });

    it('is signed in only when the new session is a registered one', async () => {
        callEdgeFunction.mockResolvedValue(reply(200, { ok: true, email: 'ada@example.com' }));
        const input = { email: 'ada@example.com', code: '482913', password: 'Correct1horse' };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        signInWithPassword.mockResolvedValue(sessionFor(true));
        await expect(confirmGuestEmailUpgrade(input)).resolves.toBe('sign_in_needed');

        signInWithPassword.mockResolvedValue({
            data: { session: null, user: null },
            error: { message: 'Invalid login credentials' },
        });
        await expect(confirmGuestEmailUpgrade(input)).resolves.toBe('sign_in_needed');

        signInWithPassword.mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(confirmGuestEmailUpgrade(input)).resolves.toBe('sign_in_needed');
        warn.mockRestore();
    });

    it('carries the server’s refusal and code, and signs in to nothing', async () => {
        callEdgeFunction.mockResolvedValue(
            reply(409, {
                error: 'An account with this email already exists. Sign in to it instead.',
                code: 'email_in_use',
            }),
        );
        const failure = confirmGuestEmailUpgrade({ email: 'a@example.com', code: '111111', password: 'Correct1horse' });
        await expect(failure).rejects.toBeInstanceOf(GuestUpgradeError);
        await expect(failure).rejects.toMatchObject({ code: 'email_in_use' });
        expect(signInWithPassword).not.toHaveBeenCalled();
    });

    it('says the network failed when the request never got an answer', async () => {
        callEdgeFunction.mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(startGuestEmailUpgrade('a@example.com')).rejects.toMatchObject({
            code: null,
            message: expect.stringMatching(/Could not reach Cleffy/),
        });
    });
});
