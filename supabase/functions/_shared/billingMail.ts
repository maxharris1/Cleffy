import type { OutboxKind } from './billingOutbox.ts';
import type { BillingEmail } from './billingTerms.ts';
import { logError } from './errorReporting.ts';
import { serviceClient } from './rateLimit.ts';
import type { StripeMode } from './stripe.ts';

/**
 * The Deno half of the billing emails (billingTerms.ts builds them): sending
 * through Resend, writing mail into the durable outbox (billingOutbox.ts), and
 * finding the address and storefront to write to.
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

/**
 * Writes a mail into billing_mail_outbox (migration 20261020160200), once per
 * (kind, dedupeKey); billingMailWorker.ts sends it. Throws when it cannot be
 * written, so the caller fails the event or the request rather than losing it.
 */
export const enqueueBillingMail = async (
    kind: OutboxKind,
    dedupeKey: string | null,
    mode: StripeMode,
    payload: Record<string, unknown>,
): Promise<void> => {
    const admin = serviceClient();
    if (!admin) {
        throw new Error('Billing is not configured');
    }
    const { error } = await admin.rpc('enqueue_billing_mail', {
        p_kind: kind,
        p_dedupe_key: dedupeKey,
        p_mode: mode,
        p_payload: payload,
    });
    if (error) {
        throw new Error(`could not queue the ${kind} mail: ${error.message}`);
    }
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
