import { callEdgeFunction } from '@/features/billing/billingApi';
import { getSupabase } from '@/lib/supabase';

/**
 * Client half of a guest attaching an email address — proven by a code mailed
 * to it before anything is attached. The server half, and why the browser no
 * longer hands the address to the auth client's updateUser, is
 * supabase/functions/_shared/guestEmail.ts.
 */

export class GuestUpgradeError extends Error {
    constructor(
        message: string,
        /** The function's code (`email_in_use`, `invalid_code`, …), or null for a network failure. */
        readonly code: string | null,
    ) {
        super(message);
        this.name = 'GuestUpgradeError';
    }
}

const UNREACHABLE = 'Could not reach Cleffy. Check your connection and try again.';

const post = async (fn: 'guest-email-start' | 'guest-email-confirm', payload: object): Promise<unknown> => {
    let response: Response;
    try {
        response = await callEdgeFunction(fn, payload);
    } catch {
        throw new GuestUpgradeError(UNREACHABLE, null);
    }
    let body: { error?: unknown; code?: unknown } = {};
    try {
        body = (await response.json()) as typeof body;
    } catch {
        // A gateway page, not JSON.
    }
    if (!response.ok) {
        throw new GuestUpgradeError(
            typeof body.error === 'string' && body.error ? body.error : 'Something went wrong. Try again.',
            typeof body.code === 'string' ? body.code : 'unknown',
        );
    }
    return body;
};

/** Mail a one-time code to `email` for the signed-in guest. */
export const startGuestEmailUpgrade = async (email: string): Promise<void> => {
    await post('guest-email-start', { email: email.trim() });
};

/**
 * Attach `email` and `password` to the guest's account once `code` matches.
 * Resolves after the session has been refreshed, so the app sees a registered
 * account (same user id, every membership and mark kept) from then on.
 */
export const confirmGuestEmailUpgrade = async (input: { email: string; code: string; password: string }) => {
    await post('guest-email-confirm', { email: input.email.trim(), code: input.code, password: input.password });
    // The access token still says is_anonymous until it is re-issued.
    const { error } = await getSupabase().auth.refreshSession();
    if (error) {
        // Attached all the same; the next scheduled refresh picks it up.
        console.warn('Session refresh after attaching an email failed', error);
    }
};
