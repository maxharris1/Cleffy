import { requireUser, rejectAnonymous, rejectStudent } from '../_shared/auth.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/rateLimit.ts';
import { appOrigin, modeForRequest, stripeClient } from '../_shared/stripe.ts';

/**
 * Opens a Stripe Customer Portal session. Plan changes, card updates and
 * cancellations all happen there rather than in Cleffy — the webhook is what
 * brings the result back into `subscriptions`.
 *
 * What the portal actually offers is not decided here: it comes from the
 * account's default portal configuration, per mode, and this function only
 * hands Stripe a customer. So "plan changes happen there" is true only while
 * `subscription_update` is enabled on that configuration with the switchable
 * products listed — a dashboard setting, invisible from this file and from the
 * API (no version this account accepts serialises
 * `features.subscription_update.products`). DEPLOY.md §1 records the intended
 * shape; if plan switching ever silently stops working, that configuration is
 * the first thing to look at, not this code.
 */
Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const rate = await checkRateLimit(`portal:${clientKey(req)}`, 10, 60_000);
    if (!rate.ok) {
        return jsonResponse({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    const auth = await requireUser(req);
    if (!auth.ok) {
        return auth.response;
    }
    const anonymous = rejectAnonymous(auth.caller);
    if (anonymous) {
        return anonymous;
    }
    // A provisioned student has no billing relationship at all: no customer, no
    // subscription, nothing to manage in the portal.
    const student = rejectStudent(auth.caller);
    if (student) {
        return student;
    }

    // The portal opens against the account the caller's site sells on, so a
    // dev.cleffy.io tester manages their sandbox subscription and never sees a
    // real customer's billing.
    const mode = modeForRequest(req);
    if (!mode) {
        return jsonResponse({ error: 'Unrecognised origin', code: 'unknown_origin' }, 400);
    }

    const stripe = stripeClient(mode);
    const admin = serviceClient();
    if (!stripe || !admin) {
        return jsonResponse({ error: 'Billing is not configured' }, 500);
    }

    try {
        const { data: customer } = await admin
            .from('billing_customers')
            .select('stripe_customer_id')
            .eq('user_id', auth.caller.userId)
            .eq('mode', mode)
            .maybeSingle();

        if (!customer?.stripe_customer_id) {
            // Never subscribed — there is nothing to manage yet.
            return jsonResponse({ error: 'No billing account yet', code: 'no_customer' }, 404);
        }

        const session = await stripe.billingPortal.sessions.create({
            customer: customer.stripe_customer_id,
            return_url: `${appOrigin(req)}/settings`,
        });

        return jsonResponse({ url: session.url });
    } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : 'Portal session failed' }, 502);
    }
});
