import { requireUser } from './auth.ts';
import { jsonResponse, optionsResponse } from './cors.ts';
import { accountDeletionPending } from './deletionPending.ts';
import { logError } from './errorReporting.ts';
import type { GuestCaller, GuestEmailMessage } from './guestEmail.ts';
import { checkRateLimit, clientKey, serviceClient } from './rateLimit.ts';
import { type ResendResult, sendViaResend } from './resendDelivery.ts';
import { readCappedJson } from './readCappedJson.ts';

/**
 * What guest-email-start and guest-email-confirm run against — the Deno half
 * of _shared/guestEmail.ts, which holds the control flow and says why.
 */

/**
 * The sender. Auth mail already goes out through Resend as noreply@cleffy.io
 * (DEPLOY.md §7), so the same verified domain and address are the default;
 * GUEST_EMAIL_FROM overrides it per project.
 */
const mailFrom = (): string => Deno.env.get('GUEST_EMAIL_FROM') ?? 'Cleffy <noreply@cleffy.io>';

export const common = {
    json: jsonResponse,
    readJson: readCappedJson,
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
    /**
     * Launch-fix item 16, decision 70(1): no new guest email verification while
     * the account is being deleted (guestEmail.ts deletionRefusal). The one
     * predicate (deletionPending.ts); a failed check is `unknown`, refused.
     */
    accountDeletionPending: async (userId: string): Promise<'clear' | 'pending' | 'unknown'> => {
        const admin = serviceClient();
        if (!admin) {
            return 'unknown';
        }
        const pending = await accountDeletionPending(admin, userId);
        if (!pending.ok) {
            console.error(`could not check whether ${userId} is being deleted: ${pending.message}`);
            return 'unknown';
        }
        return pending.pending ? 'pending' : 'clear';
    },
    logError: (message: string, err?: unknown) => logError('guest-email', err ?? new Error(message), { code: message }),
};

/** guest_email_taken, asked by start before mailing and by confirm before attaching. */
export const emailTaken = async (email: string): Promise<boolean | null> => {
    const admin = serviceClient();
    if (!admin) {
        return null;
    }
    const { data, error } = await admin.rpc('guest_email_taken', { p_email: email });
    if (error || typeof data !== 'boolean') {
        console.error(`guest_email_taken failed: ${error?.message ?? 'no answer'}`);
        return null;
    }
    return data;
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

/**
 * One guest code through Resend (resendDelivery.ts), under the Idempotency-Key
 * guestEmail.ts derived for this code, placed as `sent`, `rejected` or
 * `unknown` -- which decides whether the reservations are handed back.
 */
export const sendEmail = async (
    to: string,
    message: GuestEmailMessage,
    idempotencyKey: string,
): Promise<ResendResult> => {
    const result = await sendViaResend({
        apiKey: Deno.env.get('RESEND_API_KEY'),
        idempotencyKey,
        email: { from: mailFrom(), to: [to], ...message },
    });
    if (result.outcome !== 'sent' && result.reason !== 'unconfigured') {
        // The outcome, status and Resend's reason, never the address or the code.
        logError('guest-email-start', new Error(`resend ${result.outcome}: ${result.reason}`), {
            code: `send_${result.outcome}`,
            detail: result.detail ?? result.errorName ?? '',
        });
    }
    return result;
};
