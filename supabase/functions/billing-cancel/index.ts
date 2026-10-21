import { emailOfUser, sendBillingEmail } from '../_shared/billingMail.ts';
import * as billingTerms from '../_shared/billingTerms.ts';
import { CANCELLABLE_STATUSES, handleCancel } from '../_shared/cancelFlow.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { logError } from '../_shared/errorReporting.ts';
import { mailLimit } from '../_shared/mailBudget.ts';
import { checkRateLimit, clientKey, refundRateLimit, serviceClient } from '../_shared/rateLimit.ts';
import { appOrigin, modeForRequest, slotForPrice, stripeClient } from '../_shared/stripe.ts';

/**
 * Signed-out cancellation: /cancel's email lookup, its one-time link, and the
 * "Cancel now" button. The flow and its reasoning are in _shared/cancelFlow.ts;
 * this file is only what it runs against. Deployed with verify_jwt = false
 * (supabase/config.toml): the person cancelling may not be able to sign in at
 * all, and the emailed token -- not a session -- is the credential.
 */

const env = (name: string): string | undefined => Deno.env.get(name);

const admin = () => {
    const client = serviceClient();
    if (!client) {
        throw new Error('Billing is not configured');
    }
    return client;
};

const sha256Hex = async (value: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** 32 random bytes, base64url: what the link carries and nothing ever stores. */
const newToken = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
};

Deno.serve((req) =>
    handleCancel(req, {
        json: jsonResponse,
        options: optionsResponse,
        clientKey,
        checkRateLimit,
        refundRateLimit,
        mailBudget: {
            hour: mailLimit('billingCancelLink', 'hour', env),
            day: mailLimit('billingCancelLink', 'day', env),
        },
        modeForRequest,
        appOrigin,
        sha256Hex,
        secret: () => Deno.env.get('BILLING_CANCEL_SECRET') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || null,
        newToken,
        userForEmail: async (email) => {
            const { data, error } = await admin().rpc('billing_user_for_email', { p_email: email });
            if (error) {
                throw new Error(`billing_user_for_email failed: ${error.message}`);
            }
            return typeof data === 'string' ? data : null;
        },
        emailOfUser,
        cancellableSubscription: async (userId, mode) => {
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
        },
        firstPurchaseAt: async (userId, mode) => {
            const { data, error } = await admin()
                .from('subscriptions')
                .select('created_at')
                .eq('user_id', userId)
                .eq('mode', mode)
                .order('created_at', { ascending: true })
                .limit(1)
                .maybeSingle();
            if (error) {
                throw new Error(`could not read the first purchase: ${error.message}`);
            }
            return data?.created_at ? Date.parse(data.created_at) : null;
        },
        saveToken: async ({ hash, userId, mode, expiresAt }) => {
            const client = admin();
            // Spent and long-expired links are worth nothing; clear this
            // account's before adding another, so the table cannot grow.
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
        },
        readToken: async (hash) => {
            const { data, error } = await admin()
                .from('billing_cancel_tokens')
                .select('user_id, mode, expires_at, used_at')
                .eq('token_hash', hash)
                .maybeSingle();
            if (error) {
                throw new Error(`could not read the cancel link: ${error.message}`);
            }
            return data
                ? { userId: data.user_id, mode: data.mode, expiresAt: data.expires_at, usedAt: data.used_at }
                : null;
        },
        consumeToken: async (hash, nowIso) => {
            const { data, error } = await admin()
                .from('billing_cancel_tokens')
                .update({ used_at: nowIso })
                .eq('token_hash', hash)
                .is('used_at', null)
                .select('token_hash');
            if (error) {
                throw new Error(`could not spend the cancel link: ${error.message}`);
            }
            return (data ?? []).length > 0;
        },
        cancelAtPeriodEnd: async (subscriptionId, mode) => {
            const stripe = stripeClient(mode);
            if (!stripe) {
                throw new Error('Billing is not configured');
            }
            const updated = await stripe.subscriptions.update(subscriptionId, {
                cancel_at_period_end: true,
                metadata: { cancelled_via: 'cleffy_cancel_page' },
            });
            const seconds =
                (updated as unknown as { current_period_end?: number }).current_period_end ??
                updated.items?.data?.[0]?.current_period_end ??
                null;
            return { endsAt: typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null };
        },
        sendEmail: sendBillingEmail,
        terms: billingTerms,
        planNameForPrice: (priceId) => {
            const slot = priceId ? slotForPrice(priceId) : null;
            return slot ? billingTerms.PLAN_NAMES[slot] : null;
        },
        now: () => Date.now(),
        logError: (code, err) => logError('billing-cancel', err, { code }),
    }),
);
