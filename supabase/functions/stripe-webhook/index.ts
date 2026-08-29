import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { serviceClient } from '../_shared/rateLimit.ts';
import { priceTiers, servedModes, stripeClient, type StripeMode, webhookSecretFor } from '../_shared/stripe.ts';
import { handleStripeEvent, type StripeEventLike, type WebhookStore } from '../_shared/stripeEvents.ts';
import { type SignatureFailure, verifyStripeSignature } from '../_shared/stripeSignature.ts';

/**
 * Stripe webhook receiver. Deployed with `verify_jwt = false` (see
 * supabase/config.toml) because Stripe has no Supabase JWT to present — the
 * request is authenticated by its signature instead, against this endpoint's
 * own signing secret.
 *
 * Both Stripe accounts post here, to the one URL this project has, and an event
 * carries no Origin to sort them by. The signature does that instead: each
 * account signs with its own endpoint secret, so whichever secret verifies IS
 * the account the event came from. That makes mode a *result* of authentication
 * rather than an input to it — nothing an unsigned caller sends can pick which
 * account its subscription lands in.
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

    // Only the accounts this deployment serves. Production serves live alone, so
    // a sandbox event that still reaches it — the sandbox endpoint pointed here
    // for as long as dev shared this backend — verifies against nothing and is
    // refused rather than writing a test-mode row into the production database.
    const secrets: Array<[StripeMode, string]> = [];
    for (const candidate of servedModes()) {
        const secret = webhookSecretFor(candidate);
        if (secret) {
            secrets.push([candidate, secret]);
        }
    }
    if (secrets.length === 0) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    // The RAW body — verification is over the exact bytes Stripe signed, so this
    // must be read before (and instead of) any JSON parsing.
    const rawBody = await req.text();
    const signature = req.headers.get('Stripe-Signature');
    const now = Math.floor(Date.now() / 1000);

    let mode: StripeMode | null = null;
    // A missing or malformed header fails identically against every secret, so
    // keep that structural reason rather than the mismatch it degrades into —
    // otherwise every misconfiguration reports as a bad signature.
    let failure: SignatureFailure = 'signature_mismatch';
    for (const [candidate, secret] of secrets) {
        const check = await verifyStripeSignature(rawBody, signature, secret, now);
        if (check.ok) {
            mode = candidate;
            break;
        }
        if (check.reason !== 'signature_mismatch') {
            failure = check.reason;
        }
    }
    if (!mode) {
        // 400, not 401: Stripe treats 4xx as "do not retry", which is right for a
        // signature that will never become valid.
        return jsonResponse({ error: 'Invalid signature', code: failure }, 400);
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
    // Belt and braces: the event's own livemode flag must agree with the secret
    // that verified it. Disagreement should be impossible, and writing a live
    // subscription row out of a sandbox event is not a way to find out.
    if (typeof event.livemode === 'boolean' && event.livemode !== (mode === 'live')) {
        return jsonResponse({ error: 'Event livemode disagrees with its signing secret' }, 400);
    }

    const admin = serviceClient();
    const stripe = stripeClient(mode);
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
                .upsert({ user_id: userId, mode, stripe_customer_id: customerId }, { onConflict: 'user_id,mode' });
            if (error) {
                throw new Error(`could not link customer ${customerId}: ${error.message}`);
            }
        },
        upsertSubscription: async (row) => {
            const { error } = await admin
                .from('subscriptions')
                .upsert(
                    { ...row, mode, updated_at: new Date().toISOString() },
                    { onConflict: 'stripe_subscription_id' },
                );
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
        storedStatusOf: async (subscriptionId) => {
            const { data } = await admin
                .from('subscriptions')
                .select('status')
                .eq('stripe_subscription_id', subscriptionId)
                .maybeSingle();
            return data?.status ?? null;
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
        const result = await handleStripeEvent(event, store, priceTiers(mode));
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
