import type { BillingTier } from '@/types/database';

/**
 * Pricing catalogue. Every price id comes from env — nothing is hardcoded, so
 * the Stripe catalogue can be re-created without a code change.
 *
 * Env is read inside functions rather than at module scope so tests can
 * `vi.stubEnv` without having to re-import the module.
 */

export type BillingInterval = 'monthly' | 'annual';

const env = (key: string): string | null => {
    const value = import.meta.env[key] as string | undefined;
    return value && value.length > 0 ? value : null;
};

export const stripePrices = () => ({
    proMonthly: env('VITE_STRIPE_PRICE_PRO_MONTHLY'),
    proAnnual: env('VITE_STRIPE_PRICE_PRO_ANNUAL'),
    studioAnnual: env('VITE_STRIPE_PRICE_STUDIO_ANNUAL'),
    foundingAnnual: env('VITE_STRIPE_PRICE_FOUNDING_ANNUAL'),
});

/** Checkout cannot run without at least the Pro prices configured. */
export const isBillingConfigured = (): boolean => {
    const prices = stripePrices();
    return Boolean(prices.proMonthly && prices.proAnnual);
};

/**
 * Founding Teacher is a launch offer we can switch off. Grandfathering needs no
 * code: existing subscribers simply keep renewing at the price they bought.
 */
export const isFoundingOfferEnabled = (): boolean => {
    const prices = stripePrices();
    return import.meta.env.VITE_STRIPE_FOUNDING_OFFER === 'true' && Boolean(prices.foundingAnnual);
};

export interface TierCard {
    tier: BillingTier;
    name: string;
    tagline: string;
    /** Marketing copy for the free tier's ceilings — the numbers enforced in SQL. */
    features: string[];
}

export const TIER_CARDS: TierCard[] = [
    {
        tier: 'free',
        name: 'Free',
        tagline: 'Everything you need to try Cleffy with a few students.',
        features: [
            '3 active cloud scores',
            '3 play-along analyses a month',
            '1 smart import a month',
            '5 AI fingering reads a month',
            'Unlimited annotation, fingering and PDF export',
        ],
    },
    {
        tier: 'pro',
        name: 'Pro',
        tagline: 'For a working studio. Everything unlimited.',
        features: [
            'Unlimited cloud scores',
            'Unlimited play-along analysis',
            'Unlimited smart imports',
            'Unlimited AI fingering reads',
            'Unlimited annotation, fingering and PDF export',
        ],
    },
    {
        tier: 'studio',
        name: 'Studio',
        tagline: 'Pro for every teacher on your team, up to five seats.',
        features: [
            'Everything in Pro, for up to 5 teachers',
            'One invoice for the whole studio',
            'Add and remove seats by email',
            'Students always join free',
        ],
    },
];

export interface PriceDisplay {
    priceId: string | null;
    amount: string;
    caption: string;
    note?: string;
}

export const priceFor = (tier: BillingTier, interval: BillingInterval): PriceDisplay | null => {
    const prices = stripePrices();
    if (tier === 'free') {
        return { priceId: null, amount: 'Free', caption: 'no card required' };
    }
    if (tier === 'studio') {
        // Studio is annual-only — a flat rate for the whole team.
        return { priceId: prices.studioAnnual, amount: '$299', caption: 'per year, up to 5 teachers' };
    }
    if (interval === 'monthly') {
        return { priceId: prices.proMonthly, amount: '$15', caption: 'per month' };
    }
    return { priceId: prices.proAnnual, amount: '$120', caption: 'per year', note: 'Two months free' };
};

/** The Founding Teacher price, when the launch offer is switched on. */
export const foundingPrice = (): PriceDisplay | null => {
    if (!isFoundingOfferEnabled()) {
        return null;
    }
    return {
        priceId: stripePrices().foundingAnnual,
        amount: '$79',
        caption: 'per year, forever',
        note: 'Founding Teacher — keeps this price for as long as you stay subscribed',
    };
};

export const TIER_LABELS: Record<BillingTier, string> = {
    free: 'Free',
    pro: 'Pro',
    studio: 'Studio',
};
