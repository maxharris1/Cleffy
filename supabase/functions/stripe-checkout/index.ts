import { rejectAnonymous, rejectStudent, requireUser } from '../_shared/auth.ts';
import { handleCheckout } from '../_shared/checkoutFlow.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { logError } from '../_shared/errorReporting.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/rateLimit.ts';
import {
    appOrigin,
    expireOpenCheckoutSessions,
    modeForRequest,
    resolvePrice,
    stripeClient,
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
        expireOpenSessions: (customerId, keepIdempotencyKey, mode) =>
            expireOpenCheckoutSessions(billing(mode).stripe, customerId, keepIdempotencyKey),
        createSession: (params, options, mode) => billing(mode).stripe.checkout.sessions.create(params, options),
        holdsRunningSubscription,
        now: () => Date.now(),
        log: (message) => console.log(message),
        logError: (code, err) => logError('stripe-checkout', err, { code }),
    }),
);
