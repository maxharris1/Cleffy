import { describe, expect, it } from 'vitest';

import {
    appOriginFrom,
    keyContradictsMode,
    modeForOrigin,
    priceCatalog,
    priceTiers,
    PUBLISHED_PRICES,
    resolvePrice,
    secretKeyFor,
    servedModes,
    slotForPrice,
    webhookSecretFor,
    type EnvLookup,
} from '../../supabase/functions/_shared/stripeMode';

/**
 * cleffy.io sells against the real Stripe account and dev.cleffy.io against the
 * sandbox, from one codebase over one Supabase project. Everything that keeps
 * those apart is in `stripeMode.ts`, and everything it gets wrong is measured in
 * real money — a tester's card charged, or a customer's upgrade silently landing
 * in a sandbox nobody bills. Hence direct tests rather than coverage by proxy.
 */

const env =
    (values: Record<string, string>): EnvLookup =>
    (name) =>
        values[name];

const LIVE_KEY = 'sk_live_pretend';
const TEST_KEY = 'sk_test_pretend';

const configured = env({ STRIPE_SECRET_KEY_LIVE: LIVE_KEY, STRIPE_SECRET_KEY: TEST_KEY });

describe('modeForOrigin', () => {
    it.each([
        ['https://cleffy.io', 'live'],
        ['https://www.cleffy.io', 'live'],
        // Case and a trailing slash are normalised away rather than missed.
        ['https://CLEFFY.io/', 'live'],
        ['https://dev.cleffy.io', 'test'],
        ['http://localhost:5173', 'test'],
        ['http://localhost:4173', 'test'],
        ['http://127.0.0.1:5199', 'test'],
        // dev:local binds every interface so an iPad can reach it; that LAN
        // origin has to buy from the sandbox rather than be refused.
        ['http://192.168.1.42:5173', 'test'],
        ['http://cleffys-mbp.local:5173', 'test'],
    ])('routes %s to %s', (origin, expected) => {
        expect(modeForOrigin(origin, configured)).toBe(expected);
    });

    // The whole point of failing closed: an origin we do not publish from gets no
    // account guessed for it, in either direction.
    it.each([
        ['https://cleffy.io.attacker.example'],
        ['https://notcleffy.io'],
        ['https://cleffy-git-dev-someone.vercel.app'],
        ['null'],
        ['not a url'],
        [''],
    ])('refuses to place %s', (origin) => {
        expect(modeForOrigin(origin, configured)).toBeNull();
    });

    // Development is recognised by scheme, so a lookalike must not get there by
    // dressing itself up as one — https is the only way into live, and the live
    // list is exact.
    it('never lets an https lookalike inherit the development rule', () => {
        expect(modeForOrigin('https://cleffy.io.evil.example', configured)).toBeNull();
        expect(modeForOrigin('http://cleffy.io.evil.example', configured)).toBe('test');
    });

    it('refuses a request that sent no Origin at all', () => {
        expect(modeForOrigin(null, configured)).toBeNull();
    });

    it('never quietly downgrades the storefront to sandbox when the live key is missing', () => {
        // Serving test mode on cleffy.io would let anyone buy a plan with Stripe's
        // published test card, so this must stay 'live' and fail later instead.
        expect(modeForOrigin('https://cleffy.io', env({ STRIPE_SECRET_KEY: TEST_KEY }))).toBe('live');
    });

    // Production serves live alone, so its own backend refuses every sandbox
    // caller. This is what stops dev, a preview or a laptop writing a row into
    // the production database even when a client build points at it by mistake.
    it('refuses a sandbox caller where only live is served', () => {
        const productionOnly = env({ STRIPE_SECRET_KEY_LIVE: LIVE_KEY, STRIPE_MODES: 'live' });
        expect(modeForOrigin('https://cleffy.io', productionOnly)).toBe('live');
        expect(modeForOrigin('https://dev.cleffy.io', productionOnly)).toBeNull();
        expect(modeForOrigin('http://localhost:5173', productionOnly)).toBeNull();
    });

    it('refuses a live caller where only sandbox is served', () => {
        const branchOnly = env({ STRIPE_SECRET_KEY: TEST_KEY, STRIPE_MODES: 'test' });
        expect(modeForOrigin('https://cleffy.io', branchOnly)).toBeNull();
        expect(modeForOrigin('https://dev.cleffy.io', branchOnly)).toBe('test');
    });

    it('serves both when STRIPE_MODES is unset', () => {
        expect(servedModes(env({}))).toEqual(['live', 'test']);
        expect(servedModes(env({ STRIPE_MODES: 'live' }))).toEqual(['live']);
        expect(servedModes(env({ STRIPE_MODES: ' TEST , live ' }))).toEqual(['live', 'test']);
    });

    // A typo must not silently widen to "everything"; an unrecognised list
    // serves nothing, and every caller is refused.
    it('serves nothing when STRIPE_MODES names nothing we know', () => {
        expect(servedModes(env({ STRIPE_MODES: 'production' }))).toEqual([]);
        expect(modeForOrigin('https://cleffy.io', env({ STRIPE_MODES: 'production' }))).toBeNull();
    });

    it('takes an added origin from env without a code change', () => {
        const withPreview = env({ STRIPE_TEST_ORIGINS: 'https://dev.cleffy.io,https://preview.cleffy.io' });
        expect(modeForOrigin('https://preview.cleffy.io', withPreview)).toBe('test');
        expect(modeForOrigin('https://cleffy.io', withPreview)).toBe('live');
    });

    // DEPLOY.md offers these variables as the way to add a preview host without a
    // deploy, so they have to add: naming one host must not be how production
    // quietly loses `www` — the storefront half its buyers arrive on.
    it('adds an env origin without dropping the storefront it ships with', () => {
        const onlyPreview = env({ STRIPE_TEST_ORIGINS: 'https://preview.cleffy.io' });
        expect(modeForOrigin('https://preview.cleffy.io', onlyPreview)).toBe('test');
        expect(modeForOrigin('https://dev.cleffy.io', onlyPreview)).toBe('test');

        const onlyApex = env({ STRIPE_LIVE_ORIGINS: 'https://cleffy.io' });
        expect(modeForOrigin('https://www.cleffy.io', onlyApex)).toBe('live');

        // Still fails closed for anything on neither list.
        expect(modeForOrigin('https://notcleffy.io', onlyApex)).toBeNull();
    });
});

describe('secret key selection', () => {
    it('reads each mode from its own variable', () => {
        expect(secretKeyFor('live', configured)).toBe(LIVE_KEY);
        expect(secretKeyFor('test', configured)).toBe(TEST_KEY);
    });

    it('lets the pre-split STRIPE_SECRET_KEY keep serving sandbox', () => {
        expect(secretKeyFor('test', env({ STRIPE_SECRET_KEY: TEST_KEY }))).toBe(TEST_KEY);
    });

    it('prefers the explicit test key over the legacy name', () => {
        const both = env({ STRIPE_SECRET_KEY_TEST: 'sk_test_explicit', STRIPE_SECRET_KEY: TEST_KEY });
        expect(secretKeyFor('test', both)).toBe('sk_test_explicit');
    });

    it('has no live key until one is set — the flip is that single secret', () => {
        expect(secretKeyFor('live', env({ STRIPE_SECRET_KEY: TEST_KEY }))).toBeNull();
    });

    // The expensive typo: a live key pasted into the sandbox slot bills testers
    // for real, and a test key in the live slot silently sells nothing.
    it('rejects a key belonging to the other mode', () => {
        expect(secretKeyFor('live', env({ STRIPE_SECRET_KEY_LIVE: TEST_KEY }))).toBeNull();
        expect(secretKeyFor('test', env({ STRIPE_SECRET_KEY_TEST: LIVE_KEY }))).toBeNull();
    });

    it('accepts restricted keys, which carry the same mode infix', () => {
        expect(secretKeyFor('live', env({ STRIPE_SECRET_KEY_LIVE: 'rk_live_abc' }))).toBe('rk_live_abc');
        expect(secretKeyFor('test', env({ STRIPE_SECRET_KEY_TEST: 'rk_test_abc' }))).toBe('rk_test_abc');
        expect(keyContradictsMode('rk_test_abc', 'live')).toBe(true);
    });

    // The guard catches a swap; it is not an allowlist. A key shape Stripe has
    // not shipped yet must not read as "billing is not configured".
    it('passes through a key format it does not recognise', () => {
        expect(keyContradictsMode('sk_something_new', 'live')).toBe(false);
        expect(secretKeyFor('live', env({ STRIPE_SECRET_KEY_LIVE: 'sk_something_new' }))).toBe('sk_something_new');
    });

    it('keeps webhook secrets on the same two-name scheme', () => {
        const secrets = env({ STRIPE_WEBHOOK_SECRET_LIVE: 'whsec_live', STRIPE_WEBHOOK_SECRET: 'whsec_legacy' });
        expect(webhookSecretFor('live', secrets)).toBe('whsec_live');
        expect(webhookSecretFor('test', secrets)).toBe('whsec_legacy');
    });
});

describe('price resolution', () => {
    const empty = env({});

    it('checks out the caller-mode price for the plan the client named', () => {
        expect(resolvePrice(PUBLISHED_PRICES.live.personalMonthly!, 'live', empty)).toBe(
            PUBLISHED_PRICES.live.personalMonthly,
        );
        expect(resolvePrice(PUBLISHED_PRICES.test.personalMonthly!, 'test', empty)).toBe(
            PUBLISHED_PRICES.test.personalMonthly,
        );
    });

    // A browser holding a bundle cached from before the flip still names sandbox
    // ids on cleffy.io. That must buy the live plan, not 400 — and must never be
    // able to buy at sandbox prices.
    it('re-prices a stale sandbox id into the live catalogue', () => {
        expect(resolvePrice(PUBLISHED_PRICES.test.teacherAnnual!, 'live', empty)).toBe(
            PUBLISHED_PRICES.live.teacherAnnual,
        );
    });

    it('re-prices a live id into the sandbox for a dev caller', () => {
        expect(resolvePrice(PUBLISHED_PRICES.live.academyMonthly!, 'test', empty)).toBe(
            PUBLISHED_PRICES.test.academyMonthly,
        );
    });

    it('refuses a price id from neither catalogue', () => {
        expect(resolvePrice('price_madeup', 'live', empty)).toBeNull();
        expect(slotForPrice('price_madeup', empty)).toBeNull();
    });

    it('maps Founding Teacher to teacher in both catalogues', () => {
        expect(priceTiers('live', empty)[PUBLISHED_PRICES.live.foundingAnnual!]).toBe('teacher');
        expect(priceTiers('test', empty)[PUBLISHED_PRICES.test.foundingAnnual!]).toBe('teacher');
    });

    it('never lets one mode tier a price belonging to the other', () => {
        const live = priceTiers('live', empty);
        for (const id of Object.values(PUBLISHED_PRICES.test)) {
            expect(live[id!]).toBeUndefined();
        }
    });

    it('replaces a whole catalogue on any override, and only that mode', () => {
        const partial = env({ STRIPE_PRICE_LIVE_PERSONAL_MONTHLY: 'price_override' });
        const live = priceCatalog('live', partial);
        expect(live.personalMonthly).toBe('price_override');
        // All-or-nothing: the six unset keys go null rather than falling back and
        // serving two vintages of price from one mode.
        expect(live.teacherMonthly).toBeNull();
        expect(priceCatalog('test', partial)).toEqual(PUBLISHED_PRICES.test);
    });
});

describe('appOriginFrom', () => {
    it('returns a dev tester to dev rather than handing them to production', () => {
        expect(appOriginFrom('https://dev.cleffy.io', env({ APP_URL: 'https://cleffy.io' }))).toBe(
            'https://dev.cleffy.io',
        );
    });

    it('returns a production buyer to production', () => {
        expect(appOriginFrom('https://cleffy.io', env({ APP_URL: 'https://cleffy.io' }))).toBe('https://cleffy.io');
    });

    it('falls back to APP_URL when there is no usable Origin', () => {
        expect(appOriginFrom(null, env({ APP_URL: 'https://cleffy.io/' }))).toBe('https://cleffy.io');
        expect(appOriginFrom('https://elsewhere.example', env({ APP_URL: 'https://cleffy.io' }))).toBe(
            'https://cleffy.io',
        );
    });

    // The Origin header is written by the caller and every http origin counts as a
    // development one, so without a second gate a stranger's host would be echoed
    // straight into Stripe's success_url. A dev box is loopback, LAN or mDNS;
    // phish.example is none of them, whatever scheme it arrives under.
    it('never returns to an arbitrary http origin the caller named', () => {
        const branch = env({ APP_URL: 'https://dev.cleffy.io', STRIPE_MODES: 'test' });
        expect(appOriginFrom('http://phish.example', branch)).toBe('https://dev.cleffy.io');
        expect(appOriginFrom('http://attacker.tld:8080/x', branch)).toBe('https://dev.cleffy.io');
        // A lookalike must not reach a dev box's exemption by wearing its prefix.
        expect(appOriginFrom('http://127.evil.example', branch)).toBe('https://dev.cleffy.io');
        // ...while the dev boxes that rule exists for still come back to themselves.
        expect(appOriginFrom('http://localhost:5173', branch)).toBe('http://localhost:5173');
        expect(appOriginFrom('http://192.168.1.42:5173', branch)).toBe('http://192.168.1.42:5173');
        expect(appOriginFrom('http://cleffys-mbp.local:5173', branch)).toBe('http://cleffys-mbp.local:5173');
    });

    // Narrowing the redirect must not cost the env escape hatch: a preview host
    // added without a deploy still gets its own users back.
    it('returns a preview host added by env to itself', () => {
        const withPreview = env({ STRIPE_TEST_ORIGINS: 'https://preview.cleffy.io', APP_URL: 'https://cleffy.io' });
        expect(appOriginFrom('https://preview.cleffy.io', withPreview)).toBe('https://preview.cleffy.io');
    });
});
