import { requireUser } from './auth.ts';
import { jsonResponse, optionsResponse } from './cors.ts';
import { logError } from './errorReporting.ts';
import type { GuestCaller, GuestEmailMessage } from './guestEmail.ts';
import { checkRateLimit, clientKey, serviceClient } from './rateLimit.ts';

/**
 * What guest-email-start and guest-email-confirm run against — the Deno half
 * of _shared/guestEmail.ts, which holds the control flow and says why.
 */

const RESEND_API = 'https://api.resend.com';

/**
 * The sender. Auth mail already goes out through Resend as noreply@cleffy.io
 * (DEPLOY.md §7), so the same verified domain and address are the default;
 * GUEST_EMAIL_FROM overrides it per project.
 */
const mailFrom = (): string => Deno.env.get('GUEST_EMAIL_FROM') ?? 'Cleffy <noreply@cleffy.io>';

export const common = {
    json: jsonResponse,
    options: optionsResponse,
    clientKey,
    checkRateLimit,
    authenticate: async (req: Request): Promise<GuestCaller | Response> => {
        const auth = await requireUser(req);
        return auth.ok ? { userId: auth.caller.userId, isAnonymous: auth.caller.isAnonymous } : auth.response;
    },
    /**
     * GUEST_EMAIL_SECRET when set, otherwise the service-role key, which never
     * leaves the server either (the same fallback LOGIN_THROTTLE_SECRET uses).
     * Rotating it only voids codes that are in flight.
     */
    secret: (): string | null =>
        Deno.env.get('GUEST_EMAIL_SECRET') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || null,
    logError: (message: string, err?: unknown) => logError('guest-email', err ?? new Error(message), { code: message }),
};

export const deletePending = async (userId: string): Promise<void> => {
    const admin = serviceClient();
    if (!admin) {
        return;
    }
    const { error } = await admin.from('guest_email_verifications').delete().eq('user_id', userId);
    if (error) {
        console.error(`could not clear the pending guest email for ${userId}: ${error.message}`);
    }
};

export const sendEmail = async (
    to: string,
    message: GuestEmailMessage,
): Promise<'sent' | 'failed' | 'unconfigured'> => {
    const apiKey = Deno.env.get('RESEND_API_KEY');
    if (!apiKey) {
        return 'unconfigured';
    }
    try {
        const res = await fetch(`${RESEND_API}/emails`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: mailFrom(), to: [to], ...message }),
        });
        if (!res.ok) {
            // The status and Resend's reason, never the address or the code.
            logError('guest-email-start', new Error(`resend returned ${res.status}`), {
                code: 'send_failed',
                detail: (await res.text()).slice(0, 300),
            });
            return 'failed';
        }
        return 'sent';
    } catch (err) {
        logError('guest-email-start', err, { code: 'send_failed' });
        return 'failed';
    }
};
