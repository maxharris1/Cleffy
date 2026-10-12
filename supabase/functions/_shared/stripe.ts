import Stripe from 'npm:stripe@18';

import {
    appOriginFrom,
    modeForOrigin as modeForOriginWith,
    priceTiers as priceTiersWith,
    resolvePrice as resolvePriceWith,
    secretKeyFor as secretKeyForWith,
    servedModes as servedModesWith,
    webhookSecretFor as webhookSecretForWith,
    type StripeMode,
} from './stripeMode.ts';

/**
 * Deno adapter over `stripeMode.ts`.
 *
 * Everything decision-making lives there, import-free, so the vitest suite can
 * load and test the same file Deno runs. All this module adds is the two things
 * only Deno has: `Deno.env` and a Stripe client.
 */

export { MODES, PUBLISHED_PRICES, keyContradictsMode, type PriceCatalog, type StripeMode } from './stripeMode.ts';

const env = (name: string): string | undefined => Deno.env.get(name);

/** Which Stripe account a caller belongs to, or null if the origin is not one of ours. */
export const modeForOrigin = (origin: string | null): StripeMode | null => modeForOriginWith(origin, env);

export const modeForRequest = (req: Request): StripeMode | null => modeForOrigin(req.headers.get('Origin'));

/** The Stripe accounts this deployment serves at all — production serves only live. */
export const servedModes = (): StripeMode[] => servedModesWith(env);

export const secretKeyFor = (mode: StripeMode): string | null => secretKeyForWith(mode, env);

export const webhookSecretFor = (mode: StripeMode): string | null => webhookSecretForWith(mode, env);

export const resolvePrice = (priceId: string, mode: StripeMode): string | null => resolvePriceWith(priceId, mode, env);

export const priceTiers = (mode: StripeMode) => priceTiersWith(mode, env);

export const appOrigin = (req: Request): string => appOriginFrom(req.headers.get('Origin'), env);

/**
 * Expires every Checkout Session the customer still has open, and answers how
 * many there were.
 *
 * Two callers, for two reasons that come to the same thing. delete-account
 * expires them so a session opened before the account went away cannot later be
 * paid for a user who no longer exists. stripe-checkout expires them before it
 * opens another, because a session stays payable for 24 hours and two open
 * sessions are two charges (QA round 4, D1) -- Stripe bills a Checkout Session
 * when it is PAID, which is long after the moment any guard of ours ran.
 *
 * `keepIdempotencyKey` is what lets those two uses share one implementation
 * without stripe-checkout destroying its own second layer. The session it is
 * about to create carries the request's idempotency key in its metadata, and a
 * genuine double-submit (two tabs, a double-click) replays the first session
 * instead of making a second one -- so expiring everything first would hand the
 * buyer back a session we had just killed. A session stamped with the key this
 * request will use is therefore the one session left alone; every other open
 * one goes. delete-account passes nothing and expires all of them, which is the
 * behaviour (and the count) it had before this was factored out.
 */
export const expireOpenCheckoutSessions = async (
    stripe: Stripe,
    customerId: string,
    keepIdempotencyKey?: string | null,
): Promise<number> => {
    let expired = 0;
    for await (const session of stripe.checkout.sessions.list({
        customer: customerId,
        status: 'open',
        limit: 100,
    })) {
        if (keepIdempotencyKey && session.metadata?.checkout_key === keepIdempotencyKey) {
            continue;
        }
        await stripe.checkout.sessions.expire(session.id);
        expired += 1;
    }
    return expired;
};

const clients = new Map<StripeMode, Stripe | null>();

export const stripeClient = (mode: StripeMode): Stripe | null => {
    const cached = clients.get(mode);
    if (cached !== undefined) {
        return cached;
    }
    const key = secretKeyFor(mode);
    if (!key) {
        // Either unset, or set to a key belonging to the other mode. Both are
        // configuration errors the caller must fail on rather than work around.
        console.error(`no usable ${mode}-mode Stripe secret key; billing is not configured for ${mode}`);
    }
    const client = key
        ? new Stripe(key, {
              // Deno has no node:http — route the SDK through fetch instead.
              httpClient: Stripe.createFetchHttpClient(),
          })
        : null;
    clients.set(mode, client);
    return client;
};
