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
 * Attach `email` and `password` to the guest's account once `code` matches,
 * then sign in with them. The admin API that attaches them also deletes every
 * session the user has (GoTrue logs a user out everywhere when an admin sets
 * their password), so the guest's own session is dead from that moment: its
 * refresh token is gone, and edge functions answer its still-unexpired access
 * token — which says is_anonymous — with session_not_found. Signing in with
 * the password just attached gives a fresh session for the same user id, so
 * memberships, marks and this account's outbox all carry over.
 *
 * Resolves `'signed_in'` only once that new session is a registered one;
 * `'sign_in_needed'` when the email is attached but the sign-in failed, and
 * the user has to sign in themselves before the old session lapses.
 */
export const confirmGuestEmailUpgrade = async (input: {
    email: string;
    code: string;
    password: string;
}): Promise<'signed_in' | 'sign_in_needed'> => {
    const typed = input.email.trim();
    const body = (await post('guest-email-confirm', { email: typed, code: input.code, password: input.password })) as {
        email?: unknown;
    };
    // The address as the server stored it (normalised), else as typed.
    const email = typeof body.email === 'string' && body.email ? body.email : typed;
    try {
        const { data, error } = await getSupabase().auth.signInWithPassword({ email, password: input.password });
        if (!error && data.session && !data.session.user.is_anonymous) {
            return 'signed_in';
        }
        console.warn('Sign-in after attaching an email failed', error);
    } catch (err) {
        console.warn('Sign-in after attaching an email failed', err);
    }
    return 'sign_in_needed';
};
