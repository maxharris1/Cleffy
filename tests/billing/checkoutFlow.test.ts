// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    CHECKOUT_IDEMPOTENCY_BUCKET_MS,
    checkoutIdempotencyKey,
    handleCheckout,
    type CheckoutDeps,
    type CheckoutSessionParams,
} from '../../supabase/functions/_shared/checkoutFlow';
import { holdsRunningSubscription } from '../../supabase/functions/_shared/stripeEvents';

/**
 * The checkout flow, run for real against a fake Stripe that models open
 * Checkout Sessions and Stripe's idempotency replay.
 *
 * The point of it (QA round 4, D1): opening TWO Checkout Sessions used to be
 * allowed, because the only guard read the `subscriptions` mirror — which the
 * webhook writes when a session is PAID, not when one is opened. Both sessions
 * stayed payable for 24 hours, and paying both (two tabs, a double-click, the
 * back button) produced two `active` subscriptions billing the same period
 * twice, with nothing in the app to show it. Reproduced live in Stripe test
 * mode against customer cus_VQjG7mYC8wK6M6.
 *
 * So what is asserted here is Max's acceptance test in those words: two
 * concurrent sessions, only one of which can be paid.
 */

const USER = '0b5e0000-0000-4000-8000-000000000001';
const NOW = 1_760_000_000_000;
const PRICE = 'price_teacher_annual_live';

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const post = (body: unknown = { priceId: 'price_teacher_annual' }, method = 'POST') =>
    new Request('https://edge.test/functions/v1/stripe-checkout', {
        method,
        headers: { 'Content-Type': 'application/json', Origin: 'https://cleffy.io', Authorization: 'Bearer jwt' },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
    });

interface FakeSession {
    id: string;
    customer: string;
    status: 'open' | 'expired';
    url: string;
    metadata: Record<string, string>;
}

/**
 * Stripe, reduced to the two behaviours this flow turns on: a Checkout Session
 * stays `open` (and payable) until something expires it, and a repeated
 * idempotency key replays the FIRST response verbatim instead of creating a
 * second session.
 */
class FakeStripe {
    sessions: FakeSession[] = [];
    customers: string[] = [];
    /** Stripe's idempotency memory: key -> the response it answered with. */
    replays = new Map<string, { id: string; url: string }>();
    expireFails = false;
    keysUsed: string[] = [];

    openSessions = (): FakeSession[] => this.sessions.filter((session) => session.status === 'open');

    createCustomer = (): string => {
        const id = `cus_${this.customers.length + 1}`;
        this.customers.push(id);
        return id;
    };

    expireOpenSessions = (customerId: string, keepKey: string): number => {
        if (this.expireFails) {
            throw new Error('Stripe could not be reached');
        }
        let expired = 0;
        for (const session of this.sessions) {
            if (session.customer !== customerId || session.status !== 'open') {
                continue;
            }
            // The session this request's own idempotency key already created is
            // the one left alone — expiring it would hand the buyer back a dead
            // Checkout page on a double-click. Everything else goes.
            if (session.metadata.checkout_key === keepKey) {
                continue;
            }
            session.status = 'expired';
            expired += 1;
        }
        return expired;
    };

    createSession = (params: CheckoutSessionParams, options: { idempotencyKey: string }) => {
        this.keysUsed.push(options.idempotencyKey);
        const replay = this.replays.get(options.idempotencyKey);
        if (replay) {
            return replay;
        }
        const id = `cs_${this.sessions.length + 1}`;
        this.sessions.push({
            id,
            customer: params.customer,
            status: 'open',
            url: `https://checkout.stripe.com/${id}`,
            metadata: params.metadata,
        });
        const response = { id, url: `https://checkout.stripe.com/${id}` };
        this.replays.set(options.idempotencyKey, response);
        return response;
    };
}

const harness = (
    options: {
        running?: Array<{ status: string; current_period_end: string | null }>;
        runningFails?: boolean;
        customerFails?: boolean;
        customerId?: string | null;
        caller?: Response;
        rateLimited?: boolean;
        now?: () => number;
    } = {},
) => {
    const stripe = new FakeStripe();
    const params: CheckoutSessionParams[] = [];
    const calls: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    let customerId = options.customerId ?? null;
    const deps: CheckoutDeps = {
        json,
        options: () => new Response(null, { status: 204 }),
        clientKey: () => '203.0.113.9',
        checkRateLimit: vi.fn(async () => {
            calls.push('rate');
            return options.rateLimited ? { ok: false as const, retryAfterSec: 30 } : { ok: true as const };
        }),
        authenticate: vi.fn(async () => {
            calls.push('auth');
            return options.caller ?? { userId: USER, email: async () => 'ada@example.com' };
        }),
        modeForRequest: (req) => (req.headers.get('Origin') === 'https://cleffy.io' ? 'live' : null),
        resolvePrice: (priceId, mode) => (priceId === 'price_teacher_annual' && mode === 'live' ? PRICE : null),
        appOrigin: () => 'https://cleffy.io',
        billingConfigured: () => true,
        runningSubscriptions: vi.fn(async () => {
            calls.push('running');
            return options.runningFails
                ? { ok: false as const, error: new Error('connection reset') }
                : { ok: true as const, rows: options.running ?? [] };
        }),
        findCustomer: vi.fn(async () => {
            calls.push('find-customer');
            return options.customerFails
                ? { ok: false as const, error: new Error('connection reset') }
                : { ok: true as const, customerId };
        }),
        createCustomer: vi.fn(async () => {
            calls.push('create-customer');
            customerId = stripe.createCustomer();
            return customerId;
        }),
        expireOpenSessions: vi.fn(async (customer: string, keepKey: string) => {
            calls.push('expire');
            return stripe.expireOpenSessions(customer, keepKey);
        }),
        createSession: vi.fn(
            async (sessionParams: CheckoutSessionParams, sessionOptions: { idempotencyKey: string }) => {
                calls.push('create-session');
                params.push(sessionParams);
                return stripe.createSession(sessionParams, sessionOptions);
            },
        ),
        holdsRunningSubscription,
        now: options.now ?? (() => NOW),
        log: (message) => logs.push(message),
        logError: (code) => errors.push(code),
    };
    return { deps, stripe, params, calls, logs, errors };
};

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe('stripe-checkout flow', () => {
    it('opens one session for a first-time buyer and carries a deterministic idempotency key', async () => {
        const h = harness();

        const response = await handleCheckout(post(), h.deps);

        expect(response.status).toBe(200);
        expect(await body(response)).toEqual({ url: 'https://checkout.stripe.com/cs_1' });
        expect(h.stripe.openSessions()).toHaveLength(1);
        expect(h.stripe.keysUsed).toEqual([checkoutIdempotencyKey(USER, 'live', PRICE, NOW)]);
        // The customer has to exist before its open sessions can be listed, and
        // its open sessions have to be gone before another is created.
        expect(h.calls).toEqual([
            'rate',
            'auth',
            'running',
            'find-customer',
            'create-customer',
            'expire',
            'create-session',
        ]);
    });

    it('sends the buyer back to Stripe with both user_id copies and the expire key', async () => {
        const h = harness({ customerId: 'cus_existing' });

        await handleCheckout(post(), h.deps);

        expect(h.params[0]).toMatchObject({
            mode: 'subscription',
            customer: 'cus_existing',
            line_items: [{ price: PRICE, quantity: 1 }],
            client_reference_id: USER,
            subscription_data: { metadata: { user_id: USER } },
            metadata: { user_id: USER, checkout_key: checkoutIdempotencyKey(USER, 'live', PRICE, NOW) },
            success_url: 'https://cleffy.io/settings?checkout=success',
            cancel_url: 'https://cleffy.io/settings?checkout=cancelled',
            allow_promotion_codes: true,
        });
        // An existing customer is reused: a second Stripe customer would have
        // its own open sessions, and expiring one customer's would not touch it.
        expect(h.deps.createCustomer).not.toHaveBeenCalled();
    });

    describe('two concurrent sessions, only one of which can be paid', () => {
        it('answers a double-submit with the same session, and leaves exactly one open', async () => {
            // The double-click: two requests inside one idempotency bucket.
            // Stripe replays the first session, so the buyer lands on the page
            // they already had, and there is only ever one session to pay.
            const h = harness({ customerId: 'cus_1' });

            const first = await body(await handleCheckout(post(), h.deps));
            const second = await body(await handleCheckout(post(), h.deps));

            expect(first).toEqual(second);
            expect(h.stripe.keysUsed[0]).toBe(h.stripe.keysUsed[1]);
            expect(h.stripe.sessions).toHaveLength(1);
            expect(h.stripe.openSessions()).toHaveLength(1);
            // And the one session the buyer is being sent to is still payable:
            // expiring it would have made the retry a dead Checkout page.
            expect(h.stripe.openSessions()[0]?.url).toBe(second.url);
        });

        it('expires the first session when a later attempt opens another', async () => {
            // The back button an hour later, or a change of plan: a different
            // idempotency key, so Stripe really does create a second session.
            // The first must not be left payable beside it.
            let clock = NOW;
            const h = harness({ customerId: 'cus_1', now: () => clock });

            const first = await body(await handleCheckout(post(), h.deps));
            clock = NOW + CHECKOUT_IDEMPOTENCY_BUCKET_MS * 2;
            const second = await body(await handleCheckout(post(), h.deps));

            expect(h.stripe.keysUsed[0]).not.toBe(h.stripe.keysUsed[1]);
            expect(h.stripe.sessions).toHaveLength(2);
            expect(h.stripe.openSessions()).toHaveLength(1);
            expect(h.stripe.openSessions()[0]?.url).toBe(second.url);
            expect(first.url).not.toBe(second.url);
            expect(h.logs.some((line) => line.includes('expired 1 open session'))).toBe(true);
        });

        it('refuses the checkout when the open sessions cannot be expired', async () => {
            // Fail closed. A session we could not de-duplicate is a session that
            // can be paid beside another one, and a buyer asked to retry is
            // strictly better than a buyer charged twice.
            const h = harness({ customerId: 'cus_1' });
            h.stripe.expireFails = true;

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
            expect(await body(response)).toMatchObject({ code: 'checkout_unavailable' });
            expect(h.deps.createSession).not.toHaveBeenCalled();
            expect(h.stripe.sessions).toEqual([]);
            expect(h.errors).toEqual(['expire_open_sessions_failed']);
        });

        it('keys the idempotency on the buyer, the account, the price and a time bucket', () => {
            const key = checkoutIdempotencyKey(USER, 'live', PRICE, NOW);
            // Same purchase attempt, moments apart: the same key.
            expect(checkoutIdempotencyKey(USER, 'live', PRICE, NOW + 1_000)).toBe(key);
            // A different plan is a different purchase and must get its own session.
            expect(checkoutIdempotencyKey(USER, 'live', 'price_academy_annual', NOW)).not.toBe(key);
            // Another account, another buyer, another window: all different.
            expect(checkoutIdempotencyKey(USER, 'test', PRICE, NOW)).not.toBe(key);
            expect(checkoutIdempotencyKey('someone-else', 'live', PRICE, NOW)).not.toBe(key);
            expect(checkoutIdempotencyKey(USER, 'live', PRICE, NOW + CHECKOUT_IDEMPOTENCY_BUCKET_MS * 2)).not.toBe(key);
            // Stripe forgets a key after 24 hours; the bucket must be well inside that.
            expect(CHECKOUT_IDEMPOTENCY_BUCKET_MS).toBeLessThan(24 * 60 * 60_000);
        });
    });

    describe('one subscription per buyer per account', () => {
        it.each([
            ['active', { status: 'active', current_period_end: '2027-01-01T00:00:00Z' }],
            ['trialing', { status: 'trialing', current_period_end: '2027-01-01T00:00:00Z' }],
            // Stripe is still retrying the card; fixing it in the portal revives it.
            ['past_due', { status: 'past_due', current_period_end: '2026-09-01T00:00:00Z' }],
        ])('refuses a second checkout beside a %s subscription', async (_name, row) => {
            const h = harness({ running: [row], customerId: 'cus_1' });

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(409);
            expect(await body(response)).toMatchObject({ code: 'already_subscribed' });
            expect(h.deps.createSession).not.toHaveBeenCalled();
            expect(h.deps.expireOpenSessions).not.toHaveBeenCalled();
        });

        it('still refuses while a subscription cancelling at period end runs out', async () => {
            // The row the webhook writes for a portal cancellation is `active`
            // with the period end it stops on — it still runs, and resuming it
            // is one click in the portal. Phase 1 verified this case WAS
            // protected (409 already_subscribed) while the double-charge path
            // was not, so it is here to stay protected.
            const h = harness({
                running: [{ status: 'active', current_period_end: '2027-01-01T00:00:00Z' }],
                customerId: 'cus_1',
            });

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(409);
            expect(await body(response)).toMatchObject({ code: 'already_subscribed' });
        });

        it('lets a buyer whose subscription has ended check out again', async () => {
            const h = harness({
                running: [{ status: 'canceled', current_period_end: '2026-09-01T00:00:00Z' }],
                customerId: 'cus_1',
            });

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(200);
            expect(h.stripe.openSessions()).toHaveLength(1);
        });
    });

    describe('fails closed on every read it cannot make', () => {
        it('refuses when the subscription check fails', async () => {
            const h = harness({ runningFails: true });

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
            expect(h.deps.createSession).not.toHaveBeenCalled();
            expect(h.errors).toEqual(['subscription_check_failed']);
        });

        it('refuses when the customer lookup fails, rather than creating a second customer', async () => {
            // This one was a live hole: the lookup's error was ignored, so a
            // transient failure created a NEW Stripe customer — whose open
            // sessions are not the ones the expire step would have found, which
            // is two payable sessions again.
            const h = harness({ customerFails: true });

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
            expect(h.deps.createCustomer).not.toHaveBeenCalled();
            expect(h.deps.createSession).not.toHaveBeenCalled();
            expect(h.errors).toEqual(['customer_lookup_failed']);
        });

        it('refuses when Stripe answers without a URL', async () => {
            const h = harness({ customerId: 'cus_1' });
            h.deps.createSession = async () => ({ url: null });

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
        });

        it('refuses when session creation throws', async () => {
            const h = harness({ customerId: 'cus_1' });
            h.deps.createSession = async () => {
                throw new Error('card_declined');
            };

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
            expect(await body(response)).toMatchObject({ error: 'card_declined' });
            expect(h.errors).toEqual(['checkout_failed']);
        });

        it('reports a deployment with no Stripe key as a server error, not a bad request', async () => {
            const h = harness();
            h.deps.billingConfigured = () => false;

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(500);
            expect(h.deps.runningSubscriptions).not.toHaveBeenCalled();
        });
    });

    describe('gates ahead of any Stripe call', () => {
        it('answers a preflight and refuses anything but POST', async () => {
            const h = harness();
            expect((await handleCheckout(post({}, 'OPTIONS'), h.deps)).status).toBe(204);
            expect((await handleCheckout(post({}, 'GET'), h.deps)).status).toBe(405);
            expect(h.deps.checkRateLimit).not.toHaveBeenCalled();
        });

        it('rate limits before it authenticates', async () => {
            const h = harness({ rateLimited: true });

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(429);
            expect(await body(response)).toMatchObject({ retryAfterSec: 30 });
            expect(h.deps.authenticate).not.toHaveBeenCalled();
        });

        it('passes an auth refusal straight back', async () => {
            const h = harness({ caller: json({ error: 'Unauthorized' }, 401) });

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(401);
            expect(h.deps.runningSubscriptions).not.toHaveBeenCalled();
        });

        it('refuses an origin we do not publish from, and a price we do not sell', async () => {
            const h = harness();
            const elsewhere = new Request('https://edge.test/functions/v1/stripe-checkout', {
                method: 'POST',
                headers: { Origin: 'https://evil.example', Authorization: 'Bearer jwt' },
                body: JSON.stringify({ priceId: 'price_teacher_annual' }),
            });
            expect(await body(await handleCheckout(elsewhere, h.deps))).toMatchObject({ code: 'unknown_origin' });
            expect(await body(await handleCheckout(post({ priceId: 'price_made_up' }), h.deps))).toMatchObject({
                code: 'unknown_price',
            });
            expect(await body(await handleCheckout(post({}), h.deps))).toMatchObject({ code: 'unknown_price' });
            expect(h.deps.createSession).not.toHaveBeenCalled();
        });
    });
});

describe('stripe-checkout/index.ts is wiring only', () => {
    const source = readFileSync(resolve(process.cwd(), 'supabase/functions/stripe-checkout/index.ts'), 'utf8');

    it('runs the flow this file tests, and makes no decisions of its own', () => {
        expect(source).toContain("import { handleCheckout } from '../_shared/checkoutFlow.ts'");
        expect(source).toMatch(/Deno\.serve\(\(req\) =>\s*\n\s*handleCheckout\(req, \{/);
        // Every refusal and every ordering decision belongs to the flow; the
        // handler keeping one of its own is how the two drift apart.
        expect(source).not.toMatch(/holdsRunningSubscription\(/);
        expect(source).not.toMatch(/already_subscribed/);
    });

    it('expires open sessions through the helper delete-account shares', () => {
        expect(source).toContain('expireOpenCheckoutSessions');
    });
});
