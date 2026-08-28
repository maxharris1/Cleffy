/**
 * Which Stripe account a request belongs to, and what a plan costs there.
 *
 * NO imports — Deno loads this with the `.ts` extension, vitest without it
 * (`allowImportingTsExtensions` is off), and neither can follow a specifier the
 * other uses. Env arrives as an injected lookup for the same reason: `Deno.env`
 * does not exist under vitest, and this is the logic standing between a test
 * card and a real one, so it is tested directly rather than by proxy.
 * `_shared/stripe.ts` is the thin Deno adapter that binds `Deno.env.get` to it.
 *
 * One Supabase project serves both deploys — cleffy.io from `main`,
 * dev.cleffy.io from `dev` — so a single secret key would put both storefronts
 * on the same Stripe account. The request **Origin** chooses instead: cleffy.io
 * transacts against the live account, dev.cleffy.io and localhost against the
 * sandbox. Nothing in a request body influences it, so no crafted payload can
 * move a caller from the sandbox onto a real card, or a real buyer into test
 * mode. An origin we do not recognise resolves to no mode at all and every
 * caller refuses: guessing is the one mistake that spends someone's money.
 */

export type StripeMode = 'live' | 'test';

export const MODES: readonly StripeMode[] = ['live', 'test'];

/** Same union as stripeEvents.ts — re-declared because this module takes no imports. */
export type BillingTier = 'free' | 'personal' | 'teacher' | 'academy';

/** `Deno.env.get`, or a plain object lookup under test. */
export type EnvLookup = (name: string) => string | undefined;

export const nonEmpty = (value: string | undefined | null): string | null => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
};

/**
 * Scheme + host + port, lower-cased, with any path and trailing slash dropped,
 * so `https://Cleffy.io/` and `https://cleffy.io` are one origin. Anything
 * unparseable is null rather than a guess.
 */
export const normalizeOrigin = (origin: string | null | undefined): string | null => {
    const trimmed = nonEmpty(origin);
    if (!trimmed) {
        return null;
    }
    try {
        return new URL(trimmed).origin.toLowerCase();
    } catch {
        return null;
    }
};

/**
 * The storefronts, by the account they sell from. `www` is listed because a
 * redirect that ever failed to fire would otherwise drop a real buyer into the
 * sandbox — the costlier direction of that mistake.
 */
const DEFAULT_ORIGINS: Record<StripeMode, string[]> = {
    live: ['https://cleffy.io', 'https://www.cleffy.io'],
    test: ['https://dev.cleffy.io'],
};

/** Comma-separated overrides, so a new preview hostname needs no code deploy. */
const ORIGIN_ENV_KEYS: Record<StripeMode, string> = {
    live: 'STRIPE_LIVE_ORIGINS',
    test: 'STRIPE_TEST_ORIGINS',
};

export const originsFor = (mode: StripeMode, env: EnvLookup): string[] => {
    const configured = nonEmpty(env(ORIGIN_ENV_KEYS[mode]));
    const entries = configured ? configured.split(',') : DEFAULT_ORIGINS[mode];
    return entries.map(normalizeOrigin).filter((entry): entry is string => entry !== null);
};

/** Any local dev server is sandbox, whatever port Vite happened to pick. */
export const isLocalhost = (origin: string): boolean => {
    try {
        const { hostname, protocol } = new URL(origin);
        return protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
    } catch {
        return false;
    }
};

/**
 * Which Stripe account this caller belongs to, or null if we cannot tell.
 *
 * Live is matched first and never degrades to the sandbox: if the live key is
 * missing, cleffy.io fails loudly rather than quietly serving test checkouts,
 * where Stripe's published test card would buy a real entitlement for nothing.
 */
export const modeForOrigin = (origin: string | null, env: EnvLookup): StripeMode | null => {
    const normalized = normalizeOrigin(origin);
    if (!normalized) {
        return null;
    }
    if (originsFor('live', env).includes(normalized)) {
        return 'live';
    }
    if (originsFor('test', env).includes(normalized) || isLocalhost(normalized)) {
        return 'test';
    }
    return null;
};

/**
 * Secret key names, most specific first. The pre-split `STRIPE_SECRET_KEY` held
 * the sandbox key, so it stays a fallback for test mode: adding
 * STRIPE_SECRET_KEY_LIVE is by itself the whole live flip, and dev keeps the key
 * it already had.
 */
const SECRET_KEY_ENV: Record<StripeMode, string[]> = {
    live: ['STRIPE_SECRET_KEY_LIVE'],
    test: ['STRIPE_SECRET_KEY_TEST', 'STRIPE_SECRET_KEY'],
};

const WEBHOOK_SECRET_ENV: Record<StripeMode, string[]> = {
    live: ['STRIPE_WEBHOOK_SECRET_LIVE'],
    test: ['STRIPE_WEBHOOK_SECRET_TEST', 'STRIPE_WEBHOOK_SECRET'],
};

/**
 * Stripe stamps its own mode into the key (`sk_live_…`, `rk_test_…`), so a key
 * pasted into the wrong slot is detectable — and worth detecting, because that
 * single slip is what charges a real card from a test button.
 *
 * Only a key that positively names the OTHER mode is rejected. A shape we do not
 * recognise is passed through: this check exists to catch a swap, and making it
 * an allowlist would turn any future Stripe key format into an outage.
 */
export const keyContradictsMode = (key: string, mode: StripeMode): boolean =>
    mode === 'live' ? /^[a-z]+_test_/.test(key) : /^[a-z]+_live_/.test(key);

const firstSet = (names: string[], env: EnvLookup): string | null => {
    for (const name of names) {
        const value = nonEmpty(env(name));
        if (value) {
            return value;
        }
    }
    return null;
};

/** A key whose own prefix names the other mode is treated as absent. */
export const secretKeyFor = (mode: StripeMode, env: EnvLookup): string | null => {
    const key = firstSet(SECRET_KEY_ENV[mode], env);
    if (!key || keyContradictsMode(key, mode)) {
        return null;
    }
    return key;
};

export const webhookSecretFor = (mode: StripeMode, env: EnvLookup): string | null =>
    firstSet(WEBHOOK_SECRET_ENV[mode], env);

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

export const CATALOG_KEYS: ReadonlyArray<keyof PriceCatalog> = [
    'personalMonthly',
    'personalAnnual',
    'teacherMonthly',
    'teacherAnnual',
    'academyMonthly',
    'academyAnnual',
    'foundingAnnual',
];

/**
 * The published catalogues — live from Stripe account "Cleffy", test from
 * "Cleffy sandbox". `tests/billing/priceCatalogInSync.test.ts` proves these stay
 * equal to the VITE_ price ids in `.env.production`, so the client and the Edge
 * Functions cannot drift apart.
 *
 * Price ids are configuration, not secrets: both catalogues ship in every
 * browser bundle, because the pricing dialog has to name the price it is about
 * to check out. A price id is only a pointer into a catalogue the secret key
 * gates, so publishing one grants nothing. Committing them leaves the two secret
 * keys and the two webhook secrets as the only values set by hand, and removes
 * the class of outage where the client offers a price the server never heard of.
 */
export const PUBLISHED_PRICES: Record<StripeMode, PriceCatalog> = {
    live: {
        personalMonthly: 'price_1U9V7M4eZ6RX0W0glzzjnokr',
        personalAnnual: 'price_1U9V7R4eZ6RX0W0gEcT8ASvn',
        teacherMonthly: 'price_1U9V7T4eZ6RX0W0giIjCensQ',
        teacherAnnual: 'price_1U9V7s4eZ6RX0W0gYFUvnaey',
        academyMonthly: 'price_1U9V854eZ6RX0W0ghUfKx12e',
        academyAnnual: 'price_1U9V884eZ6RX0W0gqt1uAuRz',
        foundingAnnual: 'price_1U9V814eZ6RX0W0gNPPqpB4T',
    },
    test: {
        personalMonthly: 'price_1U8nin9EqxUjgZtnTC00MEwP',
        personalAnnual: 'price_1U8niu9EqxUjgZtn3fGKope8',
        teacherMonthly: 'price_1U8niw9EqxUjgZtnSqC3tsTx',
        teacherAnnual: 'price_1U8niy9EqxUjgZtn7TBy8cdn',
        academyMonthly: 'price_1U8nj49EqxUjgZtnlVhAVP4P',
        academyAnnual: 'price_1U8nj69EqxUjgZtnNZv0nUMq',
        foundingAnnual: 'price_1U8nj19EqxUjgZtnhcbeO9ct',
    },
};

/** `personalMonthly` -> `PERSONAL_MONTHLY`, the env-var half of every price name. */
export const ENV_SUFFIX: Record<keyof PriceCatalog, string> = {
    personalMonthly: 'PERSONAL_MONTHLY',
    personalAnnual: 'PERSONAL_ANNUAL',
    teacherMonthly: 'TEACHER_MONTHLY',
    teacherAnnual: 'TEACHER_ANNUAL',
    academyMonthly: 'ACADEMY_MONTHLY',
    academyAnnual: 'ACADEMY_ANNUAL',
    foundingAnnual: 'FOUNDING_ANNUAL',
};

/** Test keeps the pre-split names; live takes the LIVE_ infix. */
export const priceEnvName = (mode: StripeMode, key: keyof PriceCatalog): string =>
    mode === 'live' ? `STRIPE_PRICE_LIVE_${ENV_SUFFIX[key]}` : `STRIPE_PRICE_${ENV_SUFFIX[key]}`;

/**
 * Env wins over the published catalogue, but all-or-nothing **within one mode**:
 * setting even one price for a mode replaces that whole catalogue. Merging
 * per-key would let a half-finished catalogue change serve two vintages of price
 * from one mode, which reads as working right up until someone is billed the
 * wrong amount. Failing closed is the cheaper mistake — checkout answers
 * "Unknown price" instead.
 */
export const priceCatalog = (mode: StripeMode, env: EnvLookup): PriceCatalog => {
    const fromEnv = {} as PriceCatalog;
    let overridden = false;

    for (const key of CATALOG_KEYS) {
        const value = nonEmpty(env(priceEnvName(mode, key)));
        fromEnv[key] = value;
        if (value) {
            overridden = true;
        }
    }

    return overridden ? fromEnv : { ...PUBLISHED_PRICES[mode] };
};

/**
 * Which plan a price id names, looked up across **both** catalogues.
 *
 * Checkout resolves the slot and re-reads it in the caller's own mode, so a
 * browser still running a bundle cached from before the live flip checks out
 * correctly: it names a sandbox price, and cleffy.io charges the live price for
 * that same plan. The origin decides the account; a price id only ever names the
 * plan, never the mode.
 */
export const slotForPrice = (priceId: string, env: EnvLookup): keyof PriceCatalog | null => {
    for (const mode of MODES) {
        const catalog = priceCatalog(mode, env);
        for (const key of CATALOG_KEYS) {
            if (catalog[key] === priceId) {
                return key;
            }
        }
    }
    return null;
};

/** The id to actually check out: the caller's plan, priced in the caller's mode. */
export const resolvePrice = (priceId: string, mode: StripeMode, env: EnvLookup): string | null => {
    const slot = slotForPrice(priceId, env);
    return slot ? priceCatalog(mode, env)[slot] : null;
};

/** price id -> tier. Founding maps to 'teacher'; grandfathering is just renewal at that price. */
export const priceTiers = (mode: StripeMode, env: EnvLookup): Record<string, BillingTier> => {
    const catalog = priceCatalog(mode, env);
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

/**
 * Where Checkout and the Portal send the user back to.
 *
 * The caller's own origin wins, so a dev.cleffy.io tester is returned to
 * dev.cleffy.io rather than handed off to production mid-flow. APP_URL remains
 * the fallback for a caller that sent no Origin header at all.
 */
export const appOriginFrom = (origin: string | null, env: EnvLookup): string => {
    const normalized = normalizeOrigin(origin);
    if (normalized && modeForOrigin(normalized, env) !== null) {
        return normalized;
    }
    const configured = nonEmpty(env('APP_URL'));
    if (configured) {
        return configured.replace(/\/+$/, '');
    }
    return 'http://localhost:5173';
};
