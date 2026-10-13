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

/**
 * Mail a one-time code to `email` for the signed-in guest.
 *
 * `captchaToken` is our own function's gate, not GoTrue's: guest-email-start
 * verifies it against Cloudflare itself (supabase/functions/_shared/turnstile.ts)
 * because this is the one send path that is entirely ours — anybody with a
 * share link can reach it, and every call it admits is an email. Null on a
 * build with no site key, and the function admits that case unchanged, so this
 * flow is untouched until both keys are set.
 */
export const startGuestEmailUpgrade = async (email: string, captchaToken?: string | null): Promise<void> => {
    await post('guest-email-start', { email: email.trim(), ...(captchaToken ? { captchaToken } : {}) });
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
    /**
     * For the sign-in at the end, not for the attach: the code is what proves
     * the address, and guest-email-confirm asks for no captcha. This token is
     * needed because the sign-in is GoTrue's password grant, which the
     * project-wide captcha setting covers — and because the attach has already
     * destroyed this user's sessions by then, a refused sign-in here leaves a
     * guest with their work saved and no way into it until they sign in by
     * hand. Null on a build with no site key, and then nothing is sent.
     */
    captchaToken?: string | null;
}): Promise<'signed_in' | 'sign_in_needed'> => {
    const typed = input.email.trim();
    const body = (await post('guest-email-confirm', { email: typed, code: input.code, password: input.password })) as {
        email?: unknown;
    };
    // The address as the server stored it (normalised), else as typed.
    const email = typeof body.email === 'string' && body.email ? body.email : typed;
    try {
        const { data, error } = await getSupabase().auth.signInWithPassword({
            email,
            password: input.password,
            ...(input.captchaToken ? { options: { captchaToken: input.captchaToken } } : {}),
        });
        if (!error && data.session && !data.session.user.is_anonymous) {
            return 'signed_in';
        }
        console.warn('Sign-in after attaching an email failed', error);
    } catch (err) {
        console.warn('Sign-in after attaching an email failed', err);
    }
    return 'sign_in_needed';
};
