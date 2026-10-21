import type { ConfirmationDeps } from './billingOutbox.ts';
import type { CancellableSubscription, CancelLinkDeps } from './cancelFlow.ts';
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

/** 32 random bytes, base64url: what the link carries and nothing ever stores. */
export const newToken = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
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

export const saveToken: CancelLinkDeps['saveToken'] = async ({ hash, userId, mode, expiresAt }) => {
    const client = admin();
    // Spent and long-expired links are worth nothing; clear this account's
    // before adding another, so the table cannot grow.
    await client
        .from('billing_cancel_tokens')
        .delete()
        .eq('user_id', userId)
        .lt('expires_at', new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    const { error } = await client
        .from('billing_cancel_tokens')
        .insert({ token_hash: hash, user_id: userId, mode, expires_at: expiresAt });
    if (error) {
        throw new Error(`could not save the cancel link: ${error.message}`);
    }
};
