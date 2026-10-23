import {
    cancellableSubscription,
    consumeToken,
    keepRefundRequest,
    refundRequestOf,
    releaseTokenIfDeletionPending,
    sha256Hex,
} from '../_shared/billingCancelStore.ts';
import { emailOfUser, enqueueBillingMail } from '../_shared/billingMail.ts';
import { drainInBackground, sendBillingEmailWithinBudget } from '../_shared/billingMailWorker.ts';
import * as billingTerms from '../_shared/billingTerms.ts';
import { handleCancel, type LiveSubscription } from '../_shared/cancelFlow.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { accountDeletionPending } from '../_shared/deletionPending.ts';
import { logError } from '../_shared/errorReporting.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/rateLimit.ts';
import { resendIdempotencyKey } from '../_shared/resendDelivery.ts';
import { appOrigin, modeForRequest, slotForPrice, stripeClient, type StripeMode } from '../_shared/stripe.ts';
import { liveSubscriptionOf, type StripeSubscriptionLike } from '../_shared/stripeEvents.ts';
import { readCappedJson } from '../_shared/readCappedJson.ts';

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
        readJson: readCappedJson,
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
        // for a link that is neither. With the refund request kept for it, if
        // one is (migration 20261022160000; Codex r3 on #73).
        readToken: async (hash) => {
            const { data, error } = await admin().rpc('read_cancel_link_token', { p_hash: hash });
            if (error) {
                throw new Error(`could not read the cancel link: ${error.message}`);
            }
            if (data === null) {
                return null;
            }
            const {
                user_id: userId,
                mode,
                refund_request: kept,
            } = data as { user_id?: unknown; mode?: unknown; refund_request?: unknown };
            const refundRequest = kept == null ? null : refundRequestOf(kept);
            if (
                typeof userId !== 'string' ||
                (mode !== 'live' && mode !== 'test') ||
                (kept != null && !refundRequest)
            ) {
                throw new Error(`read_cancel_link_token answered ${JSON.stringify(data)}`);
            }
            return { userId, mode, refundRequest };
        },
        // Spent only while unused and unexpired on the database's clock, in one
        // statement (consume_cancel_link_token, migration 20261020160700), and
        // before any Stripe call: cancelFlow.ts goes on only after `consumed`.
        consumeToken,
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
        // Launch-fix item 16, decision 70(1): while the account is being
        // deleted the link leaves Stripe alone and stays unspent, and only the
        // refund request goes out (cancelFlow.ts deletionPendingCancel). The
        // one predicate (../_shared/deletionPending.ts); a failed check is
        // `unknown`, answered with a 503.
        accountDeletionPending: async (userId) => {
            const pending = await accountDeletionPending(admin(), userId);
            if (!pending.ok) {
                console.error(`could not check whether ${userId} is being deleted: ${pending.message}`);
                return 'unknown';
            }
            return pending.pending ? 'pending' : 'clear';
        },
        // Asked once the link is spent, after Stripe's read and after a
        // Stripe failure (decision 72(1)): a deletion that began since the
        // check above gets the link back unspent, in one statement under the
        // deletion's lock (release_cancel_link_token_for_deletion, migration
        // 20261022160000).
        releaseTokenIfDeletionPending,
        // The refund request kept with the link the first time it goes, so a
        // later press sends the same email whatever the account's email or plan
        // has become (keep_cancel_link_refund_request, migration 20261022160000;
        // Codex r2 finding 2 on #73).
        keepRefundRequest,
        now: () => Date.now(),
        logError: (code, err) => logError('billing-cancel', err, { code }),
    }),
);
