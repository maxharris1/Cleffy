import { features } from '@/lib/features';
import type { BillingTier } from '@/types/database';

/**
 * Pricing catalogue. Every price id comes from env — nothing is hardcoded, so
 * the Stripe catalogue can be re-created without a code change.
 *
 * Two personas, four tiers: Personal is the practice tool for one player,
 * Teacher is the same app plus a student roster, and Academy is Teacher for a
 * team of up to five instructors.
 *
 * The same bundle serves cleffy.io and dev.cleffy.io, so it ships BOTH price
 * catalogues and picks by hostname — one committed `.env.production` rather than
 * a Vercel-only setting nobody can see from the repo. Price ids are not secrets
 * (see `supabase/functions/_shared/stripeMode.ts`), so publishing both grants
 * nothing. The Edge Functions decide the account for real, from the request
 * Origin; if this ever disagreed the server would re-price into its own mode, so
 * the worst case is a display quirk rather than a charge on the wrong account.
 *
 * Env is read inside functions rather than at module scope so tests can
 * `vi.stubEnv` without having to re-import the module.
 */

export type BillingInterval = 'monthly' | 'annual';

export type StripeMode = 'live' | 'test';

const env = (key: string): string | null => {
    const value = import.meta.env[key] as string | undefined;
    return value && value.length > 0 ? value : null;
};

/** Only the production storefront is live; previews and localhost are sandbox. */
const LIVE_HOSTS = ['cleffy.io', 'www.cleffy.io'];

export const stripeMode = (): StripeMode => {
    if (typeof location === 'undefined') {
        return 'test';
    }
    return LIVE_HOSTS.includes(location.hostname.toLowerCase()) ? 'live' : 'test';
};

/**
 * An explicit `VITE_STRIPE_PRICE_*` wins — that is what a local `.env` sets, and
 * what the tests stub. Otherwise the per-mode catalogue decides.
 */
const priceEnv = (suffix: string): string | null =>
    env(`VITE_STRIPE_PRICE_${suffix}`) ??
    env(stripeMode() === 'live' ? `VITE_STRIPE_LIVE_PRICE_${suffix}` : `VITE_STRIPE_TEST_PRICE_${suffix}`);

export const stripePrices = () => ({
    personalMonthly: priceEnv('PERSONAL_MONTHLY'),
    personalAnnual: priceEnv('PERSONAL_ANNUAL'),
    teacherMonthly: priceEnv('TEACHER_MONTHLY'),
    teacherAnnual: priceEnv('TEACHER_ANNUAL'),
    academyMonthly: priceEnv('ACADEMY_MONTHLY'),
    academyAnnual: priceEnv('ACADEMY_ANNUAL'),
    foundingAnnual: priceEnv('FOUNDING_ANNUAL'),
});

/** Checkout cannot run without both individual plans — Academy is the extra, not the offer. */
export const isBillingConfigured = (): boolean => {
    const prices = stripePrices();
    return Boolean(prices.personalMonthly && prices.personalAnnual && prices.teacherMonthly && prices.teacherAnnual);
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
    /** Marketing copy for the tier's ceilings — on Free, the numbers enforced in SQL. */
    features: string[];
}

/** The release flags the cards depend on (src/lib/features.ts). */
export type TierCardFlags = Pick<typeof features, 'playalong' | 'fingering'>;

/**
 * The tier cards for a build. Play-along analyses (omr_runs) and fingering are
 * still metered server-side, but a release that switches them off must not
 * sell them: a line on a card is a promise to a paying customer. The two
 * meters every build uses are named for what actually draws on them —
 * `smart_imports` is spent by an IMSLP import, `vision_reads` by the AI pass of
 * Import marks (and by fingering note reads where that ships).
 */
export const tierCards = (flags: TierCardFlags): TierCard[] => {
    const playalong = flags.playalong;
    const fingering = flags.fingering;
    const aiReads = fingering ? 'AI page reads (Import marks and fingering)' : 'AI page reads for Import marks';
    return [
        {
            tier: 'free',
            name: 'Free',
            tagline: 'A taste of Personal — the whole practice tool for one player, in small amounts.',
            features: [
                '3 active cloud scores',
                ...(playalong ? ['3 play-along analyses a month'] : []),
                '2 IMSLP imports a month',
                `5 ${aiReads} a month`,
                '1 PDF export a month',
                fingering ? 'Unlimited annotation and fingering tools' : 'Unlimited annotation',
            ],
        },
        {
            tier: 'personal',
            name: 'Personal',
            tagline: 'Your personal practice tool — the whole app for one player, with no student features.',
            features: [
                'Unlimited cloud scores',
                ...(playalong ? ['Unlimited play-along analysis'] : []),
                'Unlimited IMSLP imports',
                // Paid AI reads carry a fair-use ceiling (tier_limits() in SQL),
                // so the card states it rather than promising "unlimited".
                `500 ${aiReads} a month (fair use)`,
                'Unlimited PDF export',
                'No roster — this plan is just for you',
            ],
        },
        {
            tier: 'teacher',
            name: 'Teacher',
            tagline: 'For a teaching studio: a class of twenty works out at under $1 per student.',
            features: [
                'Unlimited students',
                'Everything in Personal',
                'One roster for everyone you teach',
                'Practice notes on every lesson',
            ],
        },
        {
            tier: 'academy',
            name: 'Academy',
            tagline: 'Teacher for every instructor on your team, up to five seats.',
            features: [
                'Everything in Teacher, for up to 5 teachers',
                'One invoice for the whole academy',
                'Add and remove teacher seats by email',
                'Students always join free',
            ],
        },
    ];
};

/** The cards this build sells. */
export const TIER_CARDS: TierCard[] = tierCards(features);

export interface PriceDisplay {
    priceId: string | null;
    amount: string;
    caption: string;
    note?: string;
}

export const priceFor = (tier: BillingTier, interval: BillingInterval): PriceDisplay | null => {
    const prices = stripePrices();
    const monthly = interval === 'monthly';
    if (tier === 'free') {
        return { priceId: null, amount: 'Free', caption: 'no card required' };
    }
    if (tier === 'personal') {
        return monthly
            ? { priceId: prices.personalMonthly, amount: '$7', caption: 'per month' }
            : { priceId: prices.personalAnnual, amount: '$70', caption: 'per year', note: 'Two months free' };
    }
    if (tier === 'academy') {
        return monthly
            ? { priceId: prices.academyMonthly, amount: '$49', caption: 'per month, up to 5 teachers' }
            : {
                  priceId: prices.academyAnnual,
                  amount: '$490',
                  caption: 'per year, up to 5 teachers',
                  note: 'Two months free',
              };
    }
    return monthly
        ? { priceId: prices.teacherMonthly, amount: '$19', caption: 'per month' }
        : { priceId: prices.teacherAnnual, amount: '$190', caption: 'per year', note: 'Two months free' };
};

/** The Founding Teacher price — a second annual price on the Teacher product. */
export const foundingPrice = (): PriceDisplay | null => {
    if (!isFoundingOfferEnabled()) {
        return null;
    }
    return {
        priceId: stripePrices().foundingAnnual,
        amount: '$99',
        caption: 'per year, forever',
        note: 'Founding Teacher — $99/yr on Teacher, and it keeps this price for as long as you stay subscribed',
    };
};

export const TIER_LABELS: Record<BillingTier, string> = {
    free: 'Free',
    personal: 'Personal',
    teacher: 'Teacher',
    academy: 'Academy',
};
