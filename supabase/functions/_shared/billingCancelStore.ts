import type { ConfirmationDeps } from './billingOutbox.ts';
import type { CancelDeps, CancellableSubscription, CancelLinkDeps } from './cancelFlow.ts';
import { CANCELLABLE_STATUSES } from './cancelFlow.ts';
import { mailLimit } from './mailBudget.ts';
import { serviceClient } from './rateLimit.ts';
import type { StripeMode } from './stripe.ts';

/**
 * The database half of the signed-out cancel flow, shared by billing-cancel
 * (which answers the person) and the billing mail worker (which decides
 * whether their address gets a link, after the answer has gone -- see
 * cancelFlow.ts deliverCancelLink).
 */

const env = (name: string): string | undefined => Deno.env.get(name);

const admin = () => {
    const client = serviceClient();
    if (!client) {
        throw new Error('Billing is not configured');
    }
    return client;
};

export const sha256Hex = async (value: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const base64url = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

/**
 * The cancel link's token for one outbox row: HMAC-SHA256 of the row id under
 * the server-side secret, base64url -- 256 bits nobody without the secret can
 * produce, like the random token it replaces, but the SAME on every retry of
 * the row. That keeps the email byte-identical across retries, so Resend
 * answers a retry under the row's Idempotency-Key from the first attempt
 * instead of a 409 (resendDelivery.ts), and a link that did go out is the link
 * that works. Only its SHA-256 is stored; the token exists only in the email.
 */
export const cancelLinkToken = async (secret: string, rowId: string): Promise<string> => {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`billing-cancel-link:${rowId}`));
    return base64url(new Uint8Array(mac));
};

export const cancelSecret = (): string | null =>
    Deno.env.get('BILLING_CANCEL_SECRET') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || null;

export const cancelLinkMailBudget = (): CancelLinkDeps['mailBudget'] => ({
    hour: mailLimit('billingCancelLink', 'hour', env),
    day: mailLimit('billingCancelLink', 'day', env),
});

/** The purchase and cancellation confirmations' share (billingOutbox.ts sendWithinBudget). */
export const confirmationMailBudget = (): ConfirmationDeps['mailBudget'] => ({
    hour: mailLimit('billingConfirmation', 'hour', env),
    day: mailLimit('billingConfirmation', 'day', env),
});

export const userForEmail = async (email: string): Promise<string | null> => {
    const { data, error } = await admin().rpc('billing_user_for_email', { p_email: email });
    if (error) {
        throw new Error(`billing_user_for_email failed: ${error.message}`);
    }
    return typeof data === 'string' ? data : null;
};

export const cancellableSubscription = async (
    userId: string,
    mode: StripeMode,
): Promise<CancellableSubscription | null> => {
    const { data, error } = await admin()
        .from('subscriptions')
        .select('stripe_subscription_id, price_id, status, current_period_end, cancel_at_period_end')
        .eq('user_id', userId)
        .eq('mode', mode)
        .in('status', CANCELLABLE_STATUSES)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) {
        throw new Error(`could not read the subscription: ${error.message}`);
    }
    return data
        ? {
              subscriptionId: data.stripe_subscription_id,
              priceId: data.price_id,
              status: data.status,
              periodEnd: data.current_period_end,
              cancelAtPeriodEnd: data.cancel_at_period_end,
          }
        : null;
};

/**
 * The link's token, saved through save_cancel_link_token_v2 (migrations
 * 20261020160300, 20261020160400 and 20261020160500): only by the worker holding the row's
 * lease, with the row's own expiry -- set once, when the link was asked for --
 * and INSERT ... ON CONFLICT (token_hash) DO NOTHING, so a retry of the row,
 * or two at once, never moves the expiry an earlier save stored or touches its
 * used_at. A link deleted before (tombstoned) is never saved again, and one
 * with under two minutes left on the database's clock is refused; the answer
 * carries the seconds left on that clock, which is what the send goes on.
 */
export const saveToken: CancelLinkDeps['saveToken'] = async ({ hash, userId, outboxId, claimToken }) => {
    // No cleanup here any more: deleting this account's old tokens while one's
    // row was still retrying is how a spent link came back (Codex round 4,
    // major on #62). The cron tick removes a token once it has expired and its
    // row can no longer retry, and the table's trigger allows nothing sooner.
    const { data, error } = await admin().rpc('save_cancel_link_token_v2', {
        p_outbox_id: outboxId,
        p_claim: claimToken,
        p_hash: hash,
        p_user: userId,
    });
    if (error) {
        throw new Error(`could not save the cancel link: ${error.message}`);
    }
    const answer = (data as { answer?: unknown } | null)?.answer;
    const remaining = (data as { remaining_seconds?: unknown } | null)?.remaining_seconds;
    if (
        (answer !== 'saved' && answer !== 'expired' && answer !== 'spent' && answer !== 'not_held') ||
        typeof remaining !== 'number' ||
        !Number.isFinite(remaining)
    ) {
        throw new Error(`save_cancel_link_token_v2 answered ${JSON.stringify(data)}`);
    }
    return { answer, remainingSeconds: remaining };
};

/**
 * Spends a cancel link through consume_cancel_link_token (migration
 * 20261020160700): one statement, under the link's history locks, that sets
 * used_at only where the link is unused AND unexpired on the database's clock
 * at that moment. Anything else is refused with its reason -- `expired`,
 * `used` or `not_found` -- and writes nothing. cancelFlow.ts calls Stripe, or
 * mails support, only after `consumed`.
 */
export const consumeToken: CancelDeps['consumeToken'] = async (hash) => {
    const { data, error } = await admin().rpc('consume_cancel_link_token', { p_hash: hash });
    if (error) {
        throw new Error(`could not spend the cancel link: ${error.message}`);
    }
    const answer = (data as { answer?: unknown } | null)?.answer;
    if (answer !== 'consumed' && answer !== 'expired' && answer !== 'used' && answer !== 'not_found') {
        throw new Error(`consume_cancel_link_token answered ${JSON.stringify(data)}`);
    }
    return answer;
};
