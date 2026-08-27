import { requireUser, rejectAnonymous, rejectStudent } from '../_shared/auth.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/rateLimit.ts';
import { appOrigin, isKnownPrice, stripeClient } from '../_shared/stripe.ts';

/**
 * Creates a Stripe Checkout session for a subscription price and maps
 * auth.uid() to a Stripe customer, creating the customer on first upgrade.
 *
 * Free signup stays card-free: the free tier is simply "no subscriptions row",
 * so nothing here runs until a teacher actually chooses to pay.
 */
Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const rate = await checkRateLimit(`checkout:${clientKey(req)}`, 10, 60_000);
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
    // A provisioned student has no billing relationship at all: their teacher's
    // plan entitles them, and there is nothing here for them to buy.
    const student = rejectStudent(auth.caller);
    if (student) {
        return student;
    }

    let body: { priceId?: string };
    try {
        body = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const priceId = typeof body.priceId === 'string' ? body.priceId.trim() : '';
    // Only prices we published are checkout-able; a client-supplied id is never trusted.
    if (!priceId || !isKnownPrice(priceId)) {
        return jsonResponse({ error: 'Unknown price', code: 'unknown_price' }, 400);
    }

    const stripe = stripeClient();
    const admin = serviceClient();
    if (!stripe || !admin) {
        return jsonResponse({ error: 'Billing is not configured' }, 500);
    }

    try {
        const { data: existing } = await admin
            .from('billing_customers')
            .select('stripe_customer_id')
            .eq('user_id', auth.caller.userId)
            .maybeSingle();

        let customerId = existing?.stripe_customer_id ?? null;
        if (!customerId) {
            const { data: userData } = await auth.caller.userClient.auth.getUser();
            const customer = await stripe.customers.create({
                email: userData.user?.email ?? undefined,
                metadata: { user_id: auth.caller.userId },
            });
            customerId = customer.id;
            await admin
                .from('billing_customers')
                .upsert({ user_id: auth.caller.userId, stripe_customer_id: customerId });
        }

        const origin = appOrigin(req);
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            customer: customerId,
            line_items: [{ price: priceId, quantity: 1 }],
            // Both are belt-and-braces for the webhook's user resolution: either
            // survives even if the billing_customers row is somehow missing.
            client_reference_id: auth.caller.userId,
            subscription_data: { metadata: { user_id: auth.caller.userId } },
            success_url: `${origin}/settings?checkout=success`,
            cancel_url: `${origin}/settings?checkout=cancelled`,
            allow_promotion_codes: true,
        });

        if (!session.url) {
            return jsonResponse({ error: 'Stripe did not return a checkout URL' }, 502);
        }
        return jsonResponse({ url: session.url });
    } catch (err) {
        return jsonResponse({ error: err instanceof Error ? err.message : 'Checkout failed' }, 502);
    }
});
