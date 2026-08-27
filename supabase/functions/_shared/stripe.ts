import Stripe from 'npm:stripe@18';

import type { BillingTier } from './stripeEvents.ts';

/**
 * Stripe wiring for the Edge Functions.
 *
 * Price ids are configuration, not secrets: the same seven values ship in
 * `.env.production` and therefore in every browser bundle, because the pricing
 * dialog has to name the price it is about to check out. A price id is only a
 * pointer into a catalogue that the secret key gates, so publishing one grants
 * nothing. They are committed below for exactly that reason — it leaves
 * STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET as the only values that must be
 * set by hand, and removes the class of outage where the client offers a price
 * the server has not been told about.
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
    personalMonthly: string | null;
    personalAnnual: string | null;
    teacherMonthly: string | null;
    teacherAnnual: string | null;
    academyMonthly: string | null;
    academyAnnual: string | null;
    /** Founding Teacher: a second, cheaper annual price on the same Teacher product. */
    foundingAnnual: string | null;
}

/**
 * The published sandbox catalogue (Stripe account "Cleffy sandbox").
 * `tests/billing/priceCatalogInSync.test.ts` proves these stay equal to the
 * VITE_ price ids in `.env.production`, so the client and the Edge Functions
 * cannot drift apart.
 */
export const PUBLISHED_PRICES: PriceCatalog = {
    personalMonthly: 'price_1U8nin9EqxUjgZtnTC00MEwP',
    personalAnnual: 'price_1U8niu9EqxUjgZtn3fGKope8',
    teacherMonthly: 'price_1U8niw9EqxUjgZtnSqC3tsTx',
    teacherAnnual: 'price_1U8niy9EqxUjgZtn7TBy8cdn',
    academyMonthly: 'price_1U8nj49EqxUjgZtnlVhAVP4P',
    academyAnnual: 'price_1U8nj69EqxUjgZtnNZv0nUMq',
    foundingAnnual: 'price_1U8nj19EqxUjgZtnhcbeO9ct',
};

const PRICE_ENV_KEYS: Record<keyof PriceCatalog, string> = {
    personalMonthly: 'STRIPE_PRICE_PERSONAL_MONTHLY',
    personalAnnual: 'STRIPE_PRICE_PERSONAL_ANNUAL',
    teacherMonthly: 'STRIPE_PRICE_TEACHER_MONTHLY',
    teacherAnnual: 'STRIPE_PRICE_TEACHER_ANNUAL',
    academyMonthly: 'STRIPE_PRICE_ACADEMY_MONTHLY',
    academyAnnual: 'STRIPE_PRICE_ACADEMY_ANNUAL',
    foundingAnnual: 'STRIPE_PRICE_FOUNDING_ANNUAL',
};

/**
 * Env wins over the published catalogue, but all-or-nothing: setting even one
 * STRIPE_PRICE_* replaces the whole catalogue. Merging per-key would let a
 * half-finished live-mode flip serve live and sandbox ids from the same
 * catalogue, which reads as working right up until a real card is charged
 * against a test price. Failing closed on an incomplete override is the
 * cheaper mistake — checkout answers "Unknown price" instead.
 */
export const priceCatalog = (): PriceCatalog => {
    const keys = Object.keys(PRICE_ENV_KEYS) as Array<keyof PriceCatalog>;
    const fromEnv = {} as PriceCatalog;
    let overridden = false;

    for (const key of keys) {
        const value = Deno.env.get(PRICE_ENV_KEYS[key]) ?? null;
        fromEnv[key] = value && value.length > 0 ? value : null;
        if (fromEnv[key]) {
            overridden = true;
        }
    }

    return overridden ? fromEnv : { ...PUBLISHED_PRICES };
};

/** price id -> tier. Founding maps to 'teacher'; grandfathering is just renewal at that price. */
export const priceTiers = (): Record<string, BillingTier> => {
    const catalog = priceCatalog();
    const byTier: Array<[BillingTier, Array<string | null>]> = [
        ['personal', [catalog.personalMonthly, catalog.personalAnnual]],
        ['teacher', [catalog.teacherMonthly, catalog.teacherAnnual, catalog.foundingAnnual]],
        ['academy', [catalog.academyMonthly, catalog.academyAnnual]],
    ];

    const tiers: Record<string, BillingTier> = {};
    for (const [tier, prices] of byTier) {
        for (const price of prices) {
            if (price) {
                tiers[price] = tier;
            }
        }
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
