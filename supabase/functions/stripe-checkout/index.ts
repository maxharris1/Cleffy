import { rejectAnonymous, rejectStudent, requireUser } from '../_shared/auth.ts';
import { CHECKOUT_ATTEMPT_STALE_AFTER, handleCheckout } from '../_shared/checkoutFlow.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { logError } from '../_shared/errorReporting.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/rateLimit.ts';
import {
    appOrigin,
    customerSubscriptionStatuses,
    expireCheckoutSession,
    expireOpenCheckoutSessions,
    modeForRequest,
    readCheckoutSession,
    resolvePrice,
    stripeClient,
    subscriptionStatusOf,
    type StripeMode,
} from '../_shared/stripe.ts';
import { holdsRunningSubscription } from '../_shared/stripeEvents.ts';

/**
 * Creates a Stripe Checkout session for a subscription price and maps
 * auth.uid() to a Stripe customer, creating the customer on first upgrade.
 *
 * Every decision — who may buy, at what price, against which Stripe account,
 * and how a double-submit is kept to ONE charge (QA round 4, D1) — lives in
 * _shared/checkoutFlow.ts, where the vitest suite drives it against a fake
 * Stripe that models open sessions. This file is only what it runs against.
 */

/** One row of begin_checkout_attempt's answer, as PostgREST returns it. */
interface CheckoutAttemptRow {
    holder: string | null;
    attempt_id: string | null;
    price_id: string | null;
    session_id: string | null;
}

/**
 * The two clients every Stripe-touching dep needs. Throwing is the right
 * failure here: `billingConfigured` below has already answered a 500 for a mode
 * we cannot serve, so reaching this means the configuration changed underneath
 * the request, and the flow turns a throw into a refusal rather than a session.
 */
const billing = (mode: StripeMode) => {
    const stripe = stripeClient(mode);
    const admin = serviceClient();
    if (!stripe || !admin) {
        throw new Error('Billing is not configured');
    }
    return { stripe, admin };
};

Deno.serve((req) =>
    handleCheckout(req, {
        json: jsonResponse,
        options: optionsResponse,
        clientKey,
        checkRateLimit,
        authenticate: async (request) => {
            const auth = await requireUser(request);
            if (!auth.ok) {
                return auth.response;
            }
            const anonymous = rejectAnonymous(auth.caller);
            if (anonymous) {
                return anonymous;
            }
            // A provisioned student has no billing relationship at all: their
            // teacher's plan entitles them, and there is nothing here for them
            // to buy.
            const student = rejectStudent(auth.caller);
            if (student) {
                return student;
            }
            return {
                userId: auth.caller.userId,
                // Asked for only when a Stripe customer is actually created,
                // which is once per teacher per Stripe account.
                email: async () => {
                    const { data } = await auth.caller.userClient.auth.getUser();
                    return data.user?.email ?? null;
                },
            };
        },
        modeForRequest,
        resolvePrice,
        appOrigin,
        billingConfigured: (mode) => Boolean(stripeClient(mode) && serviceClient()),
        runningSubscriptions: async (userId, mode) => {
            const { data, error } = await billing(mode)
                .admin.from('subscriptions')
                .select('status, current_period_end')
                .eq('user_id', userId)
                .eq('mode', mode);
            return error ? { ok: false, error } : { ok: true, rows: data ?? [] };
        },
        findCustomer: async (userId, mode) => {
            // Scoped to the mode: a customer id belongs to one Stripe account,
            // so the sandbox `cus_…` a teacher picked up testing on dev is not
            // a customer the live account has ever heard of.
            const { data, error } = await billing(mode)
                .admin.from('billing_customers')
                .select('stripe_customer_id')
                .eq('user_id', userId)
                .eq('mode', mode)
                .maybeSingle();
            return error ? { ok: false, error } : { ok: true, customerId: data?.stripe_customer_id ?? null };
        },
        createCustomer: async (userId, email, mode) => {
            const { stripe, admin } = billing(mode);
            const customer = await stripe.customers.create({
                email: email ?? undefined,
                metadata: { user_id: userId },
            });
            await admin
                .from('billing_customers')
                .upsert({ user_id: userId, mode, stripe_customer_id: customer.id }, { onConflict: 'user_id,mode' });
            return customer.id;
        },
        // The (user, mode) lock (migration 20261012120103). `begin` answers with
        // an empty set when another request holds it, which is the one case the
        // flow must not read as an error: it is a double-submit, not a failure.
        beginAttempt: async (userId, mode) => {
            const { data, error } = await billing(mode).admin.rpc('begin_checkout_attempt', {
                p_user: userId,
                p_mode: mode,
                p_stale_after: CHECKOUT_ATTEMPT_STALE_AFTER,
            });
            if (error) {
                return { ok: false, reason: 'error', error };
            }
            const row = (data as CheckoutAttemptRow[] | null)?.[0];
            if (!row?.holder) {
                return { ok: false, reason: 'in_flight' };
            }
            return {
                ok: true,
                holder: row.holder,
                stored: {
                    attemptId: row.attempt_id ?? null,
                    priceId: row.price_id ?? null,
                    sessionId: row.session_id ?? null,
                },
            };
        },
        // The idempotency key, durable before it is handed to Stripe, and only
        // while this request still holds the lease (migration 20261013120100).
        // `false` is the lease having been taken over, which is the one answer
        // the flow must not read as a failure: it means another request owns the
        // critical section and this one must open nothing.
        stageAttempt: async (userId, mode, holder, attempt) => {
            const { data, error } = await billing(mode).admin.rpc('stage_checkout_attempt', {
                p_user: userId,
                p_mode: mode,
                p_holder: holder,
                p_attempt_id: attempt.attemptId,
                p_price_id: attempt.priceId,
            });
            if (error) {
                throw new Error(`could not stage the checkout attempt: ${error.message}`);
            }
            return data === true;
        },
        finishAttempt: async (userId, mode, holder, attempt) => {
            const { data, error } = await billing(mode).admin.rpc('finish_checkout_attempt', {
                p_user: userId,
                p_mode: mode,
                p_holder: holder,
                p_attempt_id: attempt.attemptId,
                p_price_id: attempt.priceId,
                p_session_id: attempt.sessionId,
            });
            if (error) {
                throw new Error(`could not record the checkout attempt: ${error.message}`);
            }
            return data === true;
        },
        // finish_checkout_attempt with nothing to remember: the lock goes back
        // and the staged idempotency key is cleared, so no later attempt replays
        // a key Stripe has already answered (see `discardAttempt` in the flow --
        // Stripe saves and replays a failed answer too, which locked a buyer out
        // of a plan for 24 hours). Scoped to our own lease by the same `where`
        // that scopes the record, so a lease that has been taken over is left
        // exactly as its new holder staged it.
        discardAttempt: async (userId, mode, holder) => {
            const { error } = await billing(mode).admin.rpc('finish_checkout_attempt', {
                p_user: userId,
                p_mode: mode,
                p_holder: holder,
                p_attempt_id: null,
                p_price_id: null,
                p_session_id: null,
            });
            if (error) {
                throw new Error(`could not discard the checkout attempt: ${error.message}`);
            }
        },
        releaseAttempt: async (userId, mode, holder) => {
            const { error } = await billing(mode).admin.rpc('release_checkout_attempt', {
                p_user: userId,
                p_mode: mode,
                p_holder: holder,
            });
            if (error) {
                throw new Error(`could not release the checkout attempt: ${error.message}`);
            }
        },
        newAttemptId: () => crypto.randomUUID(),
        stripeSubscriptionStatuses: async (customerId, mode) => {
            try {
                return { ok: true, statuses: await customerSubscriptionStatuses(billing(mode).stripe, customerId) };
            } catch (error) {
                return { ok: false, error };
            }
        },
        fetchSession: async (sessionId, mode) => {
            try {
                return { ok: true, session: await readCheckoutSession(billing(mode).stripe, sessionId) };
            } catch (error) {
                return { ok: false, error };
            }
        },
        subscriptionStatus: async (subscriptionId, mode) => {
            try {
                return { ok: true, status: await subscriptionStatusOf(billing(mode).stripe, subscriptionId) };
            } catch (error) {
                return { ok: false, error };
            }
        },
        expireOpenSessions: (customerId, mode) => expireOpenCheckoutSessions(billing(mode).stripe, customerId),
        expireSession: (sessionId, mode) => expireCheckoutSession(billing(mode).stripe, sessionId),
        createSession: (params, options, mode) => billing(mode).stripe.checkout.sessions.create(params, options),
        holdsRunningSubscription,
        now: () => Date.now(),
        log: (message) => console.log(message),
        logError: (code, err) => logError('stripe-checkout', err, { code }),
    }),
);
