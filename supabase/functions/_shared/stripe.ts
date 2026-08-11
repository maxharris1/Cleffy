import Stripe from 'npm:stripe@18';

import type { BillingTier } from './stripeEvents.ts';

/**
 * Stripe wiring for the Edge Functions. Every price id comes from env — nothing
 * about the catalogue is hardcoded here or stored in Postgres, so prices can be
 * re-created or swapped without a migration.
 */

let cachedStripe: Stripe | null | undefined;

export const stripeClient = (): Stripe | null => {
    if (cachedStripe !== undefined) {
        return cachedStripe;
    }
    const key = Deno.env.get('STRIPE_SECRET_KEY');
    if (!key) {
        cachedStripe = null;
        return null;
    }
    cachedStripe = new Stripe(key, {
        // Deno has no node:http — route the SDK through fetch instead.
        httpClient: Stripe.createFetchHttpClient(),
    });
    return cachedStripe;
};

export interface PriceCatalog {
    proMonthly: string | null;
    proAnnual: string | null;
    studioAnnual: string | null;
    /** Founding Teacher: a second, cheaper annual price on the same Pro product. */
    foundingAnnual: string | null;
}

export const priceCatalog = (): PriceCatalog => ({
    proMonthly: Deno.env.get('STRIPE_PRICE_PRO_MONTHLY') ?? null,
    proAnnual: Deno.env.get('STRIPE_PRICE_PRO_ANNUAL') ?? null,
    studioAnnual: Deno.env.get('STRIPE_PRICE_STUDIO_ANNUAL') ?? null,
    foundingAnnual: Deno.env.get('STRIPE_PRICE_FOUNDING_ANNUAL') ?? null,
});

/** price id -> tier. Founding maps to 'pro'; grandfathering is just renewal at that price. */
export const priceTiers = (): Record<string, BillingTier> => {
    const catalog = priceCatalog();
    const tiers: Record<string, BillingTier> = {};
    for (const price of [catalog.proMonthly, catalog.proAnnual, catalog.foundingAnnual]) {
        if (price) {
            tiers[price] = 'pro';
        }
    }
    if (catalog.studioAnnual) {
        tiers[catalog.studioAnnual] = 'studio';
    }
    return tiers;
};

/** Only prices we published may be checked out — never trust a client-supplied price id. */
export const isKnownPrice = (priceId: string): boolean => Object.hasOwn(priceTiers(), priceId);

/**
 * Where Checkout and the Portal send the user back to. Set APP_URL as an Edge
 * secret in production; the Origin header is the local-dev fallback.
 */
export const appOrigin = (req: Request): string => {
    const configured = Deno.env.get('APP_URL');
    if (configured) {
        return configured.replace(/\/+$/, '');
    }
    const origin = req.headers.get('Origin');
    return origin ? origin.replace(/\/+$/, '') : 'http://localhost:5173';
};
