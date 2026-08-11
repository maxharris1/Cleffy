import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { serviceClient } from '../_shared/imslp.ts';
import { priceTiers, stripeClient } from '../_shared/stripe.ts';
import { handleStripeEvent, type StripeEventLike, type WebhookStore } from '../_shared/stripeEvents.ts';
import { verifyStripeSignature } from '../_shared/stripeSignature.ts';

/**
 * Stripe webhook receiver. Deployed with `verify_jwt = false` (see
 * supabase/config.toml) because Stripe has no Supabase JWT to present — the
 * request is authenticated by its signature instead, against this endpoint's
 * own STRIPE_WEBHOOK_SECRET.
 *
 * Deliberately no rate limit: throttling here would drop Stripe's retries.
 *
 * All the decision logic lives in _shared/stripeEvents.ts so it can be unit
 * tested; this file is only I/O.
 */
Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
    if (!secret) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // The RAW body — verification is over the exact bytes Stripe signed, so this
    // must be read before (and instead of) any JSON parsing.
    const rawBody = await req.text();
    const check = await verifyStripeSignature(
        rawBody,
        req.headers.get('Stripe-Signature'),
        secret,
        Math.floor(Date.now() / 1000),
    );
    if (!check.ok) {
        // 400, not 401: Stripe treats 4xx as "do not retry", which is right for a
        // signature that will never become valid.
        return jsonResponse({ error: 'Invalid signature', code: check.reason }, 400);
    }

    let event: StripeEventLike;
    try {
        event = JSON.parse(rawBody) as StripeEventLike;
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    if (!event?.id || typeof event.type !== 'string') {
        return jsonResponse({ error: 'Malformed event' }, 400);
    }

    const admin = serviceClient();
    const stripe = stripeClient();
    if (!admin || !stripe) {
        // 500 so Stripe retries once we are configured again.
        return jsonResponse({ error: 'Billing is not configured' }, 500);
    }

    const store: WebhookStore = {
        claimEvent: async (id, type) => {
            // Single statement, so two concurrent deliveries of the same event
            // cannot both win: the loser gets zero rows back.
            const { data, error } = await admin
                .from('stripe_events')
                .upsert({ id, type }, { onConflict: 'id', ignoreDuplicates: true })
                .select('id');
            if (error) {
                throw new Error(`could not claim event ${id}: ${error.message}`);
            }
            return (data?.length ?? 0) > 0;
        },
        userIdForCustomer: async (customerId) => {
            const { data } = await admin
                .from('billing_customers')
                .select('user_id')
                .eq('stripe_customer_id', customerId)
                .maybeSingle();
            return data?.user_id ?? null;
        },
        linkCustomer: async (customerId, userId) => {
            const { error } = await admin
                .from('billing_customers')
                .upsert({ user_id: userId, stripe_customer_id: customerId }, { onConflict: 'user_id' });
            if (error) {
                throw new Error(`could not link customer ${customerId}: ${error.message}`);
            }
        },
        upsertSubscription: async (row) => {
            const { error } = await admin
                .from('subscriptions')
                .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'stripe_subscription_id' });
            if (error) {
                throw new Error(`could not upsert subscription ${row.stripe_subscription_id}: ${error.message}`);
            }
        },
        fetchSubscription: async (subscriptionId) => {
            try {
                return await stripe.subscriptions.retrieve(subscriptionId);
            } catch {
                return null;
            }
        },
        userIdForSubscription: async (subscriptionId) => {
            const { data } = await admin
                .from('subscriptions')
                .select('user_id')
                .eq('stripe_subscription_id', subscriptionId)
                .maybeSingle();
            return data?.user_id ?? null;
        },
        applyFreeTierArchival: async (userId) => {
            const { data, error } = await admin.rpc('apply_free_tier_archival', { p_user: userId });
            if (error) {
                throw new Error(`could not archive past the free cap for ${userId}: ${error.message}`);
            }
            console.log(`archived ${data ?? 0} score(s) past the free cap for ${userId}`);
        },
        log: (message) => console.log(message),
    };

    try {
        const result = await handleStripeEvent(event, store, priceTiers());
        return jsonResponse(result.body, result.status);
    } catch (err) {
        // The claim is committed the moment it succeeds, so a failure downstream
        // of it would make Stripe's retry look like a duplicate and silently drop
        // the event. Release the claim first, then ask for the retry with a 500.
        // Re-running is safe: every store write is an upsert or is idempotent.
        await admin
            .from('stripe_events')
            .delete()
            .eq('id', event.id)
            .then(({ error }) => {
                if (error) {
                    console.error(`could not release claim on ${event.id}: ${error.message}`);
                }
            });
        console.error(`stripe-webhook failed for ${event.id} (${event.type}):`, err);
        return jsonResponse({ error: err instanceof Error ? err.message : 'Webhook handling failed' }, 500);
    }
});
