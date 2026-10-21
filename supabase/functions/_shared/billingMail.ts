import type { BillingEmail } from './billingTerms.ts';
import { logError } from './errorReporting.ts';
import { serviceClient } from './rateLimit.ts';
import type { StripeMode } from './stripe.ts';

/**
 * The Deno half of the billing emails (billingTerms.ts builds them): sending
 * through Resend, sending each confirmation at most once, and finding the
 * address and storefront to write to.
 */

const RESEND_API = 'https://api.resend.com';

/** Same verified domain as auth mail (DEPLOY.md §7); replies go to a human. */
const mailFrom = (): string => Deno.env.get('BILLING_EMAIL_FROM') ?? 'Cleffy <noreply@cleffy.io>';

export type SendOutcome = 'sent' | 'failed' | 'unconfigured';

export const sendBillingEmail = async (
    to: string,
    message: BillingEmail,
    options: { replyTo?: string; tag: string },
): Promise<SendOutcome> => {
    const apiKey = Deno.env.get('RESEND_API_KEY');
    if (!apiKey) {
        console.log(`billing mail (${options.tag}) not sent: RESEND_API_KEY is not set`);
        return 'unconfigured';
    }
    try {
        const res = await fetch(`${RESEND_API}/emails`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: mailFrom(),
                to: [to],
                reply_to: options.replyTo ?? 'support@cleffy.io',
                subject: message.subject,
                text: message.text,
                html: message.html,
            }),
        });
        if (!res.ok) {
            // The status and Resend's reason, never the address.
            logError('billing-mail', new Error(`resend returned ${res.status}`), {
                code: `${options.tag}_send_failed`,
                detail: (await res.text()).slice(0, 300),
            });
            return 'failed';
        }
        return 'sent';
    } catch (err) {
        logError('billing-mail', err, { code: `${options.tag}_send_failed` });
        return 'failed';
    }
};

export type NoticeKind = 'purchase_confirmation' | 'cancellation_confirmation';

/**
 * Takes the one-time right to send a notice (billing_notices' primary key), or
 * answers false because it has already been taken. Throws when the table cannot
 * be reached, so the caller sends nothing rather than possibly twice.
 */
export const claimNotice = async (kind: NoticeKind, objectId: string): Promise<boolean> => {
    const admin = serviceClient();
    if (!admin) {
        throw new Error('Billing is not configured');
    }
    const { error } = await admin.from('billing_notices').insert({ kind, stripe_object_id: objectId });
    if (!error) {
        return true;
    }
    if (error.code === '23505') {
        return false;
    }
    throw new Error(`could not claim the ${kind} notice: ${error.message}`);
};

/** Gives a claim back when the mail did not go out, so a later delivery may try again. */
export const releaseNotice = async (kind: NoticeKind, objectId: string): Promise<void> => {
    const admin = serviceClient();
    await admin?.from('billing_notices').delete().eq('kind', kind).eq('stripe_object_id', objectId);
};

/** The account's sign-in address, or null (deleted, or an account with none). */
export const emailOfUser = async (userId: string): Promise<string | null> => {
    const admin = serviceClient();
    if (!admin) {
        return null;
    }
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) {
        throw new Error(`could not read the account email: ${error.message}`);
    }
    return data.user?.email ?? null;
};

/**
 * The storefront a mode's customers buy from, for links in mail sent without a
 * request to read an Origin from (the webhook). Live is always cleffy.io; the
 * sandbox honours APP_URL so local and preview mail links somewhere useful.
 */
export const storefrontOrigin = (mode: StripeMode): string => {
    if (mode === 'live') {
        return 'https://cleffy.io';
    }
    const configured = Deno.env.get('APP_URL')?.trim();
    return configured ? configured.replace(/\/+$/, '') : 'https://dev.cleffy.io';
};
