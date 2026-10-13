// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    CHECKOUT_ATTEMPT_STALE_AFTER,
    checkoutIdempotencyKey,
    handleCheckout,
    type CheckoutDeps,
    type CheckoutSessionParams,
} from '../../supabase/functions/_shared/checkoutFlow';
import { holdsRunningSubscription } from '../../supabase/functions/_shared/stripeEvents';

/**
 * The checkout flow, run for real against a fake Stripe that models open
 * Checkout Sessions, paid ones whose webhook has not landed, and a fake
 * `checkout_attempts` table that models the (user, mode) lock the way
 * begin_checkout_attempt does.
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
 * concurrent sessions, only one of which can be paid — and concurrent here
 * means genuinely overlapping, one request suspended INSIDE the flow while the
 * other runs from end to end. The first round of fixes passed a sequential
 * version of this test and still allowed the double charge: two requests that
 * disagree about the price, or that straddle the old ten-minute key bucket,
 * computed different idempotency keys, so Stripe made them a session each and
 * neither expire saw the other's.
 */

const USER = '0b5e0000-0000-4000-8000-000000000001';
const NOW = 1_760_000_000_000;
const PRICE = 'price_teacher_annual_live';
const ACADEMY_PRICE = 'price_academy_annual_live';

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const post = (body: unknown = { priceId: 'price_teacher_annual' }, method = 'POST') =>
    new Request('https://edge.test/functions/v1/stripe-checkout', {
        method,
        headers: { 'Content-Type': 'application/json', Origin: 'https://cleffy.io', Authorization: 'Bearer jwt' },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
    });

/** A request for Academy rather than Teacher: the other half of a two-tab race. */
const postAcademy = () => post({ priceId: 'price_academy_annual' });

interface FakeSession {
    id: string;
    customer: string;
    status: 'open' | 'complete' | 'expired';
    url: string | null;
    subscriptionId: string | null;
    metadata: Record<string, string>;
}

/**
 * A place to suspend one request while another runs: `arrived` resolves when the
 * flow reaches the step, and it does not continue until `release` is called.
 * That is what makes the overlap in these tests real rather than sequential.
 */
const latch = () => {
    let release = () => {};
    const released = new Promise<void>((resolve_) => {
        release = () => resolve_();
    });
    let arrive = () => {};
    const arrived = new Promise<void>((resolve_) => {
        arrive = () => resolve_();
    });
    return { released, release, arrived, arrive };
};

type Latch = ReturnType<typeof latch>;

/**
 * Stripe, reduced to what this flow turns on: a Checkout Session stays `open`
 * (and payable) until something expires it; a paid one becomes `complete` and
 * carries the subscription it created; a repeated idempotency key replays the
 * first response verbatim; and a customer's subscriptions can be listed.
 */
class FakeStripe {
    sessions: FakeSession[] = [];
    customers: string[] = [];
    /** Stripe's idempotency memory: key -> the response it answered with. */
    replays = new Map<string, { id: string; url: string }>();
    /** The customer's subscriptions, as Stripe holds them. */
    subscriptions = new Map<string, string>();
    expireFails = false;
    listFails = false;
    sessionReadFails = false;
    keysUsed: string[] = [];

    openSessions = (): FakeSession[] => this.sessions.filter((session) => session.status === 'open');

    createCustomer = (): string => {
        const id = `cus_${this.customers.length + 1}`;
        this.customers.push(id);
        return id;
    };

    expireOpenSessions = (customerId: string): number => {
        if (this.expireFails) {
            throw new Error('Stripe could not be reached');
        }
        let expired = 0;
        for (const session of this.sessions) {
            if (session.customer !== customerId || session.status !== 'open') {
                continue;
            }
            session.status = 'expired';
            session.url = null;
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
            subscriptionId: null,
            metadata: params.metadata,
        });
        const response = { id, url: `https://checkout.stripe.com/${id}` };
        this.replays.set(options.idempotencyKey, response);
        return response;
    };

    /** The buyer pays: Stripe closes the session and creates the subscription. */
    pay = (sessionId: string, status = 'active'): string => {
        const session = this.sessions.find((candidate) => candidate.id === sessionId);
        if (!session) {
            throw new Error(`no session ${sessionId}`);
        }
        const subscriptionId = `sub_${this.subscriptions.size + 1}`;
        session.status = 'complete';
        session.url = null;
        session.subscriptionId = subscriptionId;
        this.subscriptions.set(subscriptionId, status);
        return subscriptionId;
    };
}

/** How long begin_checkout_attempt lets a lease sit; see the migration. */
const LEASE_MS = 60_000 * Number(CHECKOUT_ATTEMPT_STALE_AFTER.split(' ')[0]);

/**
 * `checkout_attempts` and begin/finish/release_checkout_attempt, modelled: one
 * holder at a time per (user, mode), a lease that can be taken over once stale,
 * and a memory of the session the last attempt opened.
 */
class FakeAttempts {
    holder: string | null = null;
    claimedAt = 0;
    attemptId: string | null = null;
    priceId: string | null = null;
    sessionId: string | null = null;
    /** Attempts begun, holders issued in order — for assertions about the lock. */
    holders: string[] = [];
    beginFails = false;
    /** The service clock, so a lease can be left to go stale without waiting. */
    clock = 0;

    begin = (): {
        holder: string;
        attemptId: string | null;
        priceId: string | null;
        sessionId: string | null;
    } | null => {
        if (this.holder !== null && this.clock - this.claimedAt < LEASE_MS) {
            return null;
        }
        this.holder = `holder-${this.holders.length + 1}`;
        this.claimedAt = this.clock;
        this.holders.push(this.holder);
        return {
            holder: this.holder,
            attemptId: this.attemptId,
            priceId: this.priceId,
            sessionId: this.sessionId,
        };
    };

    finish = (holder: string, attempt: { attemptId: string; priceId: string; sessionId: string | null }): boolean => {
        if (this.holder !== holder) {
            return false;
        }
        this.holder = null;
        this.attemptId = attempt.attemptId;
        this.priceId = attempt.priceId;
        this.sessionId = attempt.sessionId;
        return true;
    };

    release = (holder: string): boolean => {
        if (this.holder !== holder) {
            return false;
        }
        this.holder = null;
        return true;
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
        /** Suspends the flow just before it creates a session in Stripe. */
        pauseBeforeCreate?: Latch;
    } = {},
) => {
    const stripe = new FakeStripe();
    const attempts = new FakeAttempts();
    const params: CheckoutSessionParams[] = [];
    const calls: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    let attemptIds = 0;
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
        resolvePrice: (priceId, mode) => {
            if (mode !== 'live') {
                return null;
            }
            if (priceId === 'price_teacher_annual') {
                return PRICE;
            }
            return priceId === 'price_academy_annual' ? ACADEMY_PRICE : null;
        },
        appOrigin: () => 'https://cleffy.io',
        billingConfigured: () => true,
        runningSubscriptions: vi.fn(async () => {
            calls.push('running');
            return options.runningFails
                ? { ok: false as const, error: new Error('connection reset') }
                : { ok: true as const, rows: options.running ?? [] };
        }),
        beginAttempt: vi.fn(async () => {
            calls.push('begin-attempt');
            if (attempts.beginFails) {
                return { ok: false as const, reason: 'error' as const, error: new Error('connection reset') };
            }
            const taken = attempts.begin();
            return taken
                ? {
                      ok: true as const,
                      holder: taken.holder,
                      stored: { attemptId: taken.attemptId, priceId: taken.priceId, sessionId: taken.sessionId },
                  }
                : { ok: false as const, reason: 'in_flight' as const };
        }),
        finishAttempt: vi.fn(async (_userId, _mode, holder: string, attempt) => {
            calls.push('finish-attempt');
            attempts.finish(holder, attempt);
        }),
        releaseAttempt: vi.fn(async (_userId, _mode, holder: string) => {
            calls.push('release-attempt');
            attempts.release(holder);
        }),
        newAttemptId: () => `attempt-${++attemptIds}`,
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
        stripeSubscriptionStatuses: vi.fn(async () => {
            calls.push('stripe-subscriptions');
            return stripe.listFails
                ? { ok: false as const, error: new Error('Stripe is down') }
                : { ok: true as const, statuses: [...stripe.subscriptions.values()] };
        }),
        fetchSession: vi.fn(async (sessionId: string) => {
            calls.push('fetch-session');
            if (stripe.sessionReadFails) {
                return { ok: false as const, error: new Error('Stripe is down') };
            }
            const session = stripe.sessions.find((candidate) => candidate.id === sessionId);
            return {
                ok: true as const,
                session: session
                    ? { status: session.status, url: session.url, subscriptionId: session.subscriptionId }
                    : null,
            };
        }),
        subscriptionStatus: vi.fn(async (subscriptionId: string) => {
            calls.push('subscription-status');
            return { ok: true as const, status: stripe.subscriptions.get(subscriptionId) ?? null };
        }),
        expireOpenSessions: vi.fn(async (customer: string) => {
            calls.push('expire');
            return stripe.expireOpenSessions(customer);
        }),
        createSession: vi.fn(
            async (sessionParams: CheckoutSessionParams, sessionOptions: { idempotencyKey: string }) => {
                calls.push('create-session');
                if (options.pauseBeforeCreate) {
                    options.pauseBeforeCreate.arrive();
                    await options.pauseBeforeCreate.released;
                }
                params.push(sessionParams);
                return stripe.createSession(sessionParams, sessionOptions);
            },
        ),
        holdsRunningSubscription,
        now: options.now ?? (() => NOW),
        log: (message) => logs.push(message),
        logError: (code) => errors.push(code),
    };
    return { deps, stripe, attempts, params, calls, logs, errors };
};

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe('stripe-checkout flow', () => {
    it('opens one session for a first-time buyer, under the lock, with an attempt-keyed idempotency key', async () => {
        const h = harness();

        const response = await handleCheckout(post(), h.deps);

        expect(response.status).toBe(200);
        expect(await body(response)).toEqual({ url: 'https://checkout.stripe.com/cs_1' });
        expect(h.stripe.openSessions()).toHaveLength(1);
        expect(h.stripe.keysUsed).toEqual([checkoutIdempotencyKey(USER, 'live', PRICE, 'attempt-1')]);
        // The lock before anything is read from Stripe, the customer before the
        // sessions that belong to it, and the expiries before the new session.
        // The lock is released by the record, not beside it.
        expect(h.calls).toEqual([
            'rate',
            'auth',
            'running',
            'begin-attempt',
            'find-customer',
            'create-customer',
            'stripe-subscriptions',
            'expire',
            'create-session',
            'finish-attempt',
        ]);
        expect(h.deps.releaseAttempt).not.toHaveBeenCalled();
        // And the session is remembered, so the next request can hand it back.
        expect(h.attempts.sessionId).toBe('cs_1');
        expect(h.attempts.priceId).toBe(PRICE);
        expect(h.attempts.holder).toBeNull();
    });

    it('sends the buyer back to Stripe with both user_id copies and the attempt key', async () => {
        const h = harness({ customerId: 'cus_existing' });

        await handleCheckout(post(), h.deps);

        expect(h.params[0]).toMatchObject({
            mode: 'subscription',
            customer: 'cus_existing',
            line_items: [{ price: PRICE, quantity: 1 }],
            client_reference_id: USER,
            subscription_data: { metadata: { user_id: USER } },
            metadata: { user_id: USER, checkout_key: checkoutIdempotencyKey(USER, 'live', PRICE, 'attempt-1') },
            success_url: 'https://cleffy.io/settings?checkout=success',
            cancel_url: 'https://cleffy.io/settings?checkout=cancelled',
            allow_promotion_codes: true,
        });
        // An existing customer is reused: a second Stripe customer would have
        // its own open sessions, and expiring one customer's would not touch it.
        expect(h.deps.createCustomer).not.toHaveBeenCalled();
    });

    describe('two concurrent sessions, only one of which can be paid', () => {
        it('refuses a second request that genuinely overlaps the first', async () => {
            // The double-click, as it really happens: the second request arrives
            // while the first is still inside the flow, between Stripe calls.
            // Nothing the two share but the database decides this.
            const gate = latch();
            const h = harness({ customerId: 'cus_1', pauseBeforeCreate: gate });

            const first = handleCheckout(post(), h.deps);
            await gate.arrived;
            const second = await handleCheckout(post(), h.deps);

            expect(second.status).toBe(409);
            expect(await body(second)).toMatchObject({ code: 'checkout_in_progress' });

            gate.release();
            const firstResponse = await first;
            expect(firstResponse.status).toBe(200);
            // One session created, one session payable.
            expect(h.stripe.sessions).toHaveLength(1);
            expect(h.stripe.openSessions()).toHaveLength(1);
            expect(h.deps.createSession).toHaveBeenCalledTimes(1);
        });

        it('refuses an overlapping request for a DIFFERENT price, which no idempotency key could', async () => {
            // Teacher in one tab, Academy in the other. The keys differ by
            // construction, so Stripe would have made two sessions and each
            // request's expire would have run before the other's existed --
            // which is the double charge the first round of fixes left open.
            const gate = latch();
            const h = harness({ customerId: 'cus_1', pauseBeforeCreate: gate });

            const teacher = handleCheckout(post(), h.deps);
            await gate.arrived;
            const academy = await handleCheckout(postAcademy(), h.deps);

            expect(academy.status).toBe(409);
            expect(await body(academy)).toMatchObject({ code: 'checkout_in_progress' });
            gate.release();
            await teacher;

            expect(h.stripe.sessions).toHaveLength(1);
            expect(h.stripe.openSessions()).toHaveLength(1);
            expect(h.params.map((p) => p.line_items[0]?.price)).toEqual([PRICE]);
        });

        it('hands the same session back to a buyer who comes back for the same plan', async () => {
            // Sequentially now: the lock is free, and the session the last
            // attempt opened is still open for the price being asked for. The
            // buyer gets the page they already had, and no second session is
            // created for them to pay.
            const h = harness({ customerId: 'cus_1' });

            const first = await body(await handleCheckout(post(), h.deps));
            const second = await body(await handleCheckout(post(), h.deps));

            expect(second).toEqual(first);
            expect(h.deps.createSession).toHaveBeenCalledTimes(1);
            expect(h.stripe.sessions).toHaveLength(1);
            expect(h.stripe.openSessions()).toHaveLength(1);
            expect(h.deps.expireOpenSessions).toHaveBeenCalledTimes(1);
            expect(h.logs.some((line) => line.includes('reusing open session cs_1'))).toBe(true);
        });

        it('expires the first session, and uses a new key, when the buyer changes plan', async () => {
            // A different price is a different purchase: the stored session is
            // not reusable, so it is expired and a new one opened. The new key
            // carries a FRESH attempt id, so Stripe cannot replay the response
            // whose session we just expired (QA round 4, D1, fourth leg: with a
            // time bucket in the key, Teacher -> Academy -> Teacher inside one
            // bucket was answered with the dead first session's URL).
            const h = harness({ customerId: 'cus_1' });

            const teacher = await body(await handleCheckout(post(), h.deps));
            const academy = await body(await handleCheckout(postAcademy(), h.deps));
            const again = await body(await handleCheckout(post(), h.deps));

            expect(new Set(h.stripe.keysUsed).size).toBe(3);
            expect(h.stripe.sessions).toHaveLength(3);
            expect(h.stripe.openSessions()).toHaveLength(1);
            expect(h.stripe.openSessions()[0]?.url).toBe(again.url);
            expect(again.url).not.toBe(teacher.url);
            expect(again.url).not.toBe(academy.url);
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
            // And the lock is handed back, so the retry we just asked for is not
            // refused as an attempt in flight.
            expect(h.attempts.holder).toBeNull();
        });

        it('keys the idempotency on the buyer, the account, the price and the attempt', () => {
            const key = checkoutIdempotencyKey(USER, 'live', PRICE, 'attempt-1');
            // A second attempt is a second session, never a replay of the first.
            expect(checkoutIdempotencyKey(USER, 'live', PRICE, 'attempt-2')).not.toBe(key);
            // A different plan, another account, another buyer: all different.
            expect(checkoutIdempotencyKey(USER, 'live', ACADEMY_PRICE, 'attempt-1')).not.toBe(key);
            expect(checkoutIdempotencyKey(USER, 'test', PRICE, 'attempt-1')).not.toBe(key);
            expect(checkoutIdempotencyKey('someone-else', 'live', PRICE, 'attempt-1')).not.toBe(key);
            // Nothing in it comes from a clock any more: two isolates serving
            // one double-click agree through the lock, not through arithmetic on
            // the time, so there is no boundary left for them to straddle.
            expect(key).toBe(`checkout:live:${USER}:${PRICE}:attempt-1`);
        });

        it('takes the lock over once the lease of a dead isolate has gone stale', async () => {
            // Why the lock is a LEASE: an isolate killed mid-checkout (a
            // timeout, a deploy) releases nothing, and a lock without a lease
            // would stop that buyer paying us ever again.
            const h = harness({ customerId: 'cus_1' });
            const dead = h.attempts.begin();

            const refused = await handleCheckout(post(), h.deps);
            expect(refused.status).toBe(409);
            expect(await body(refused)).toMatchObject({ code: 'checkout_in_progress' });

            h.attempts.clock += LEASE_MS + 1_000;
            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(200);
            expect(h.stripe.openSessions()).toHaveLength(1);
            // And the dead isolate's lease is not its to give back any more.
            expect(h.attempts.release(dead?.holder ?? '')).toBe(false);
        });
    });

    describe('a session that has been PAID but whose webhook has not landed', () => {
        it('refuses a second checkout because STRIPE says the buyer is subscribed', async () => {
            // The mirror is still empty -- the webhook has not landed -- and the
            // paid session is no longer open, so there is nothing to expire
            // either. Only Stripe knows, so Stripe is asked (QA round 4, D1,
            // second leg).
            const h = harness({ customerId: 'cus_1' });
            await handleCheckout(post(), h.deps);
            h.stripe.pay('cs_1');

            const second = await handleCheckout(post(), h.deps);

            expect(second.status).toBe(409);
            expect(await body(second)).toMatchObject({ code: 'already_subscribed' });
            expect(h.deps.createSession).toHaveBeenCalledTimes(1);
            expect(h.attempts.holder).toBeNull();
        });

        it('asks the buyer to wait while the first payment is still being confirmed', async () => {
            // `incomplete`: Stripe took the session and is still settling the
            // first invoice, so it is not "subscribed" yet and never would be
            // caught by the status check above. The stored session is what
            // remembers that this buyer has already paid.
            const h = harness({ customerId: 'cus_1' });
            await handleCheckout(post(), h.deps);
            h.stripe.pay('cs_1', 'incomplete');

            const second = await handleCheckout(post(), h.deps);

            expect(second.status).toBe(409);
            expect(await body(second)).toMatchObject({ code: 'checkout_pending' });
            expect(h.deps.createSession).toHaveBeenCalledTimes(1);
        });

        it('lets a buyer whose payment ultimately failed start over', async () => {
            // The purchase did not stick: Stripe ended the subscription. A
            // pending state that outlived the purchase would lock this buyer out
            // of paying us for good.
            const h = harness({ customerId: 'cus_1' });
            await handleCheckout(post(), h.deps);
            h.stripe.pay('cs_1', 'incomplete_expired');

            const second = await handleCheckout(post(), h.deps);

            expect(second.status).toBe(200);
            expect(h.deps.createSession).toHaveBeenCalledTimes(2);
            expect(h.stripe.openSessions()).toHaveLength(1);
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
            // The cheapest layer answers without taking the lock or calling Stripe.
            expect(h.deps.beginAttempt).not.toHaveBeenCalled();
        });

        it.each([['active'], ['trialing'], ['past_due']])(
            'refuses a second checkout beside a %s subscription Stripe holds but we have not recorded',
            async (status) => {
                const h = harness({ customerId: 'cus_1' });
                h.stripe.subscriptions.set('sub_existing', status);

                const response = await handleCheckout(post(), h.deps);

                expect(response.status).toBe(409);
                expect(await body(response)).toMatchObject({ code: 'already_subscribed' });
                expect(h.deps.createSession).not.toHaveBeenCalled();
                expect(h.deps.expireOpenSessions).not.toHaveBeenCalled();
            },
        );

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
            h.stripe.subscriptions.set('sub_old', 'canceled');

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

        it('refuses when the lock cannot be taken', async () => {
            const h = harness({ customerId: 'cus_1' });
            h.attempts.beginFails = true;

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
            expect(await body(response)).toMatchObject({ code: 'checkout_unavailable' });
            expect(h.deps.createSession).not.toHaveBeenCalled();
            expect(h.errors).toEqual(['checkout_attempt_lock_failed']);
            // Nothing was taken, so nothing is released.
            expect(h.deps.releaseAttempt).not.toHaveBeenCalled();
        });

        it("refuses when Stripe's own subscription list cannot be read", async () => {
            // Without this read a paid-but-unlanded purchase is invisible, so a
            // failure to make it has to refuse rather than fall through.
            const h = harness({ customerId: 'cus_1' });
            h.stripe.listFails = true;

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
            expect(await body(response)).toMatchObject({ code: 'checkout_unavailable' });
            expect(h.deps.createSession).not.toHaveBeenCalled();
            expect(h.errors).toEqual(['stripe_subscription_list_failed']);
            expect(h.attempts.holder).toBeNull();
        });

        it('refuses when the stored session cannot be read back', async () => {
            const h = harness({ customerId: 'cus_1' });
            await handleCheckout(post(), h.deps);
            h.stripe.sessionReadFails = true;

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
            expect(await body(response)).toMatchObject({ code: 'checkout_unavailable' });
            expect(h.deps.createSession).toHaveBeenCalledTimes(1);
            expect(h.errors).toEqual(['checkout_session_read_failed']);
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
            expect(h.attempts.holder).toBeNull();
        });

        it('refuses when Stripe answers without a URL', async () => {
            const h = harness({ customerId: 'cus_1' });
            h.deps.createSession = async () => ({ url: null });

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
            expect(h.attempts.holder).toBeNull();
        });

        it('refuses when session creation throws, and still gives the lock back', async () => {
            const h = harness({ customerId: 'cus_1' });
            h.deps.createSession = async () => {
                throw new Error('card_declined');
            };

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
            expect(await body(response)).toMatchObject({ error: 'card_declined' });
            expect(h.errors).toEqual(['checkout_failed']);
            expect(h.attempts.holder).toBeNull();
        });

        it('still sends the buyer to a session it could not record', async () => {
            // The session exists and is payable; refusing it would be a failed
            // purchase for a bookkeeping failure. The next attempt expires it
            // and opens its own, so it is still one payable session.
            const h = harness({ customerId: 'cus_1' });
            h.deps.finishAttempt = async () => {
                throw new Error('connection reset');
            };

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(200);
            expect(await body(response)).toEqual({ url: 'https://checkout.stripe.com/cs_1' });
            expect(h.errors).toEqual(['checkout_attempt_record_failed']);
            expect(h.deps.releaseAttempt).toHaveBeenCalled();
            expect(h.attempts.holder).toBeNull();
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
            expect(h.deps.beginAttempt).not.toHaveBeenCalled();
        });
    });
});

describe('stripe-checkout/index.ts is wiring only', () => {
    const source = readFileSync(resolve(process.cwd(), 'supabase/functions/stripe-checkout/index.ts'), 'utf8');

    it('runs the flow this file tests, and makes no decisions of its own', () => {
        expect(source).toMatch(/import \{[^}]*handleCheckout[^}]*\} from '\.\.\/_shared\/checkoutFlow\.ts';/);
        expect(source).toMatch(/Deno\.serve\(\(req\) =>\s*\n\s*handleCheckout\(req, \{/);
        // Every refusal and every ordering decision belongs to the flow; the
        // handler keeping one of its own is how the two drift apart.
        expect(source).not.toMatch(/holdsRunningSubscription\(/);
        expect(source).not.toMatch(/already_subscribed/);
    });

    it('expires open sessions through the helper delete-account shares', () => {
        expect(source).toContain('expireOpenCheckoutSessions');
    });

    it('takes the cross-isolate lock through the RPCs that hold it', () => {
        expect(source).toContain('begin_checkout_attempt');
        expect(source).toContain('finish_checkout_attempt');
        expect(source).toContain('release_checkout_attempt');
        expect(source).toContain('CHECKOUT_ATTEMPT_STALE_AFTER');
    });
});
