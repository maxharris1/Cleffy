import { cancellableSubscription, sha256Hex } from '../_shared/billingCancelStore.ts';
import { emailOfUser, enqueueBillingMail } from '../_shared/billingMail.ts';
import { drainInBackground, sendBillingEmailWithinBudget } from '../_shared/billingMailWorker.ts';
import * as billingTerms from '../_shared/billingTerms.ts';
import { handleCancel, type LiveSubscription } from '../_shared/cancelFlow.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { logError } from '../_shared/errorReporting.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/rateLimit.ts';
import { resendIdempotencyKey } from '../_shared/resendDelivery.ts';
import { appOrigin, modeForRequest, slotForPrice, stripeClient, type StripeMode } from '../_shared/stripe.ts';
import { liveSubscriptionOf, type StripeSubscriptionLike } from '../_shared/stripeEvents.ts';

/**
 * Signed-out cancellation: /cancel's email lookup, its one-time link, and the
 * "Cancel now" button. The flow and its reasoning are in _shared/cancelFlow.ts;
 * this file is only what it runs against. Deployed with verify_jwt = false
 * (supabase/config.toml): the person cancelling may not be able to sign in at
 * all, and the emailed token -- not a session -- is the credential.
 */

const admin = () => {
    const client = serviceClient();
    if (!client) {
        throw new Error('Billing is not configured');
    }
    return client;
};

const stripeFor = (mode: StripeMode) => {
    const stripe = stripeClient(mode);
    if (!stripe) {
        throw new Error('Billing is not configured');
    }
    return stripe;
};

/**
 * What the cancel page needs of a Stripe subscription (cancelFlow.ts
 * LiveSubscription): stripeEvents.ts liveSubscriptionOf, the rule the webhook
 * mirrors with -- a `cancel_at` later than the period end is not cancelling.
 */
const liveOf = (sub: StripeSubscriptionLike): LiveSubscription => liveSubscriptionOf(sub);

Deno.serve((req) =>
    handleCancel(req, {
        json: jsonResponse,
        options: optionsResponse,
        clientKey,
        checkRateLimit,
        modeForRequest,
        appOrigin,
        sha256Hex,
        // Every well-formed address is written down and answered the same; the
        // lookup and the send happen in the worker (cancelFlow.ts).
        queueCancelLink: (request, mode) => enqueueBillingMail('cancel_link', null, mode, { ...request }),
        sendQueued: drainInBackground,
        emailOfUser,
        cancellableSubscription,
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
        // Used or expired is the database's answer, on its own clock
        // (read_cancel_link_token, migration 20261020160600): it answers only
        // for a link that is neither.
        readToken: async (hash) => {
            const { data, error } = await admin().rpc('read_cancel_link_token', { p_hash: hash });
            if (error) {
                throw new Error(`could not read the cancel link: ${error.message}`);
            }
            if (data === null) {
                return null;
            }
            const { user_id: userId, mode } = data as { user_id?: unknown; mode?: unknown };
            if (typeof userId !== 'string' || (mode !== 'live' && mode !== 'test')) {
                throw new Error(`read_cancel_link_token answered ${JSON.stringify(data)}`);
            }
            return { userId, mode };
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
        liveSubscription: async (subscriptionId, mode) => {
            try {
                return liveOf(await stripeFor(mode).subscriptions.retrieve(subscriptionId));
            } catch (err) {
                if ((err as { code?: string }).code === 'resource_missing') {
                    return null;
                }
                throw err;
            }
        },
        cancelAtPeriodEnd: async (subscriptionId, mode) =>
            liveOf(
                await stripeFor(mode).subscriptions.update(subscriptionId, {
                    cancel_at_period_end: true,
                    metadata: { cancelled_via: 'cleffy_cancel_page' },
                }),
            ),
        // The refund request to support, inside the billingConfirmation share.
        sendEmail: sendBillingEmailWithinBudget,
        idempotencyKey: resendIdempotencyKey,
        terms: billingTerms,
        planNameForPrice: (priceId) => {
            const slot = priceId ? slotForPrice(priceId) : null;
            return slot ? billingTerms.PLAN_NAMES[slot] : null;
        },
        now: () => Date.now(),
        logError: (code, err) => logError('billing-cancel', err, { code }),
    }),
);
