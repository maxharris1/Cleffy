// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import * as billingTerms from '../../supabase/functions/_shared/billingTerms';
import {
    CHECKOUT_ATTEMPT_STALE_AFTER,
    CHECKOUT_ATTEMPT_STALE_AFTER_MS,
    checkoutIdempotencyKey,
    EDGE_FUNCTION_WALL_CLOCK_MS,
    handleCheckout,
    purchaseKey,
    type CheckoutDeps,
    type CheckoutSessionParams,
    type ConsentRecord,
} from '../../supabase/functions/_shared/checkoutFlow';
import {
    EDGE_FUNCTION_WALL_CLOCK_MS as WEBHOOK_WALL_CLOCK_MS,
    holdsRunningSubscription,
} from '../../supabase/functions/_shared/stripeEvents';

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

/** What the lock and the idempotency key match on: the price AND the currency the consent named. */
const PRICE_KEY = purchaseKey(PRICE, 'usd');
const ACADEMY_KEY = purchaseKey(ACADEMY_PRICE, 'usd');

/** The consent the pricing dialog sends with a checkout, for a buyer in `country`. */
const consentFor = (slot: billingTerms.PlanSlot, country = 'US') => ({
    accepted: true,
    country,
    text: billingTerms.autoRenewalConsentText(
        billingTerms.purchaseTermsFor(slot, billingTerms.currencyForCountry(country)),
    ),
});

const post = (
    body: unknown = { priceId: 'price_teacher_annual', consent: consentFor('teacherAnnual') },
    method = 'POST',
) =>
    new Request('https://edge.test/functions/v1/stripe-checkout', {
        method,
        headers: { 'Content-Type': 'application/json', Origin: 'https://cleffy.io', Authorization: 'Bearer jwt' },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
    });

/** A request for Academy rather than Teacher: the other half of a two-tab race. */
const postAcademy = () => post({ priceId: 'price_academy_annual', consent: consentFor('academyAnnual') });

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
    /**
     * Stripe's idempotency memory: key -> the response it answered with,
     * FAILURES INCLUDED. Stripe saves the first answer a key got whether it
     * succeeded or not and replays it for 24 hours, which is the half of the
     * idempotency layer this fake used not to model -- and the half that locked
     * a buyer out of a plan when a create came back 500 (Codex round 2 of #56).
     */
    replays = new Map<string, { id: string; url: string } | { error: string }>();
    /** The customer's subscriptions, as Stripe holds them. */
    subscriptions = new Map<string, string>();
    expireFails = false;
    listFails = false;
    sessionReadFails = false;
    /** Stripe's answer to the next create: set it to the message it fails with. */
    createFails: string | null = null;
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

    /** Expires one session by id, as Stripe does for a session that is still open. */
    expireSession = (sessionId: string): void => {
        if (this.expireFails) {
            throw new Error('Stripe could not be reached');
        }
        const session = this.sessions.find((candidate) => candidate.id === sessionId);
        if (session?.status === 'open') {
            session.status = 'expired';
            session.url = null;
        }
    };

    createSession = (
        params: CheckoutSessionParams,
        options: { idempotencyKey: string },
    ): { id: string; url: string } => {
        this.keysUsed.push(options.idempotencyKey);
        const replay = this.replays.get(options.idempotencyKey);
        if (replay) {
            if ('error' in replay) {
                throw new Error(replay.error);
            }
            return replay;
        }
        if (this.createFails) {
            // Saved against the key, exactly like a success: this is what a
            // replay of a failed create gets back for the next 24 hours.
            this.replays.set(options.idempotencyKey, { error: this.createFails });
            throw new Error(this.createFails);
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

/**
 * How long begin_checkout_attempt lets a lease sit. Derived from the interval
 * the function actually passes Postgres, and cross-checked against the
 * milliseconds constant beside it, so the fake cannot model a lease the flow no
 * longer asks for.
 */
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

    /**
     * stage_checkout_attempt: the idempotency key persisted under the CURRENT
     * lease, keeping the lock. Scoped to the holder like finish and release, so
     * an attempt whose lease has been taken over cannot stage -- which is what
     * stops it reaching the Stripe create at all.
     */
    stage = (holder: string, attempt: { attemptId: string; priceId: string }): boolean => {
        if (this.holder !== holder) {
            return false;
        }
        this.attemptId = attempt.attemptId;
        this.priceId = attempt.priceId;
        this.sessionId = null;
        return true;
    };

    finish = (
        holder: string,
        attempt: { attemptId: string | null; priceId: string | null; sessionId: string | null },
    ): boolean => {
        if (this.holder !== holder) {
            return false;
        }
        this.holder = null;
        this.attemptId = attempt.attemptId;
        this.priceId = attempt.priceId;
        this.sessionId = attempt.sessionId;
        return true;
    };

    /**
     * finish_checkout_attempt with nothing to remember, which is how the flow
     * discards a staged key: the lock goes back and the row keeps no attempt for
     * a later request to replay.
     */
    discard = (holder: string): boolean => this.finish(holder, { attemptId: null, priceId: null, sessionId: null });

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
        /**
         * Suspends the FIRST request to reach the staging of its idempotency
         * key, and only that one, so a second request can run past it from end
         * to end -- which is what a lease takeover mid-attempt looks like.
         */
        pauseBeforeStage?: Latch;
        /** checkout_consents cannot be written. */
        consentFails?: boolean;
    } = {},
) => {
    const stripe = new FakeStripe();
    const attempts = new FakeAttempts();
    const params: CheckoutSessionParams[] = [];
    const calls: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    let attemptIds = 0;
    let paused = false;
    let pausedCreate = false;
    let customerId = options.customerId ?? null;
    const consents: Array<ConsentRecord & { id: string; sessionId: string | null }> = [];
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
        slotForPrice: (priceId) =>
            priceId === PRICE ? 'teacherAnnual' : priceId === ACADEMY_PRICE ? 'academyAnnual' : null,
        terms: billingTerms,
        recordConsent: vi.fn(async (record: ConsentRecord) => {
            if (options.consentFails) {
                throw new Error('connection reset');
            }
            const id = `consent-${consents.length + 1}`;
            consents.push({ ...record, id, sessionId: null });
            return id;
        }),
        linkConsent: vi.fn(async (consentId: string, sessionId: string) => {
            const row = consents.find((candidate) => candidate.id === consentId);
            if (row) {
                row.sessionId = sessionId;
            }
        }),
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
        stageAttempt: vi.fn(async (_userId, _mode, holder: string, attempt) => {
            calls.push('stage-attempt');
            if (options.pauseBeforeStage && !paused) {
                paused = true;
                options.pauseBeforeStage.arrive();
                await options.pauseBeforeStage.released;
            }
            return attempts.stage(holder, attempt);
        }),
        finishAttempt: vi.fn(async (_userId, _mode, holder: string, attempt) => {
            calls.push('finish-attempt');
            return attempts.finish(holder, attempt);
        }),
        discardAttempt: vi.fn(async (_userId, _mode, holder: string) => {
            calls.push('discard-attempt');
            attempts.discard(holder);
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
        expireSession: vi.fn(async (sessionId: string) => {
            calls.push('expire-session');
            stripe.expireSession(sessionId);
        }),
        createSession: vi.fn(
            async (sessionParams: CheckoutSessionParams, sessionOptions: { idempotencyKey: string }) => {
                calls.push('create-session');
                // The FIRST request to get here, and only that one, so a second
                // can run past it from end to end -- a create still in flight
                // when its lease is taken off it.
                if (options.pauseBeforeCreate && !pausedCreate) {
                    pausedCreate = true;
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
    return { deps, stripe, attempts, params, calls, logs, errors, consents };
};

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

type Harness = ReturnType<typeof harness>;

/**
 * An isolate killed inside `checkout.sessions.create`, as it is really killed:
 * Stripe makes the session and the invocation stops there. Nothing after the
 * create runs -- no discard of the key it staged, no release of the lock, no
 * answer to the buyer -- so what is left behind is the row layer 4b was written
 * for (an attempt id, the price, no session) and a lease nobody hands back,
 * which the next request takes over once it has gone stale.
 *
 * The flow never sees an error here, and that is the point of modelling the
 * death this way rather than as a throw from the create: a create whose failure
 * the flow DOES see has its key discarded, because Stripe replays a saved
 * failure for 24 hours as readily as a saved session (Codex round 2 of #56).
 * The two leave Stripe in the same state and must leave `checkout_attempts` in
 * different ones.
 */
const diesInsideCreate = async (h: Harness): Promise<void> => {
    const create = h.deps.createSession;
    let created = () => {};
    const didCreate = new Promise<void>((resolve_) => {
        created = () => resolve_();
    });
    h.deps.createSession = async (params, sessionOptions, mode) => {
        const made = await create(params, sessionOptions, mode);
        created();
        // The isolate is gone: nothing below this line ever runs, and the
        // request it was serving never answers.
        await new Promise<never>(() => {});
        return made;
    };
    void handleCheckout(post(), h.deps);
    await didCreate;
    h.deps.createSession = create;
    h.attempts.clock += LEASE_MS + 1_000;
};

describe('stripe-checkout flow', () => {
    it('opens one session for a first-time buyer, under the lock, with an attempt-keyed idempotency key', async () => {
        const h = harness();

        const response = await handleCheckout(post(), h.deps);

        expect(response.status).toBe(200);
        expect(await body(response)).toEqual({ url: 'https://checkout.stripe.com/cs_1' });
        expect(h.stripe.openSessions()).toHaveLength(1);
        expect(h.stripe.keysUsed).toEqual([checkoutIdempotencyKey(USER, 'live', PRICE_KEY, 'attempt-1')]);
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
            // The key is durable BEFORE Stripe is asked to make a session with
            // it, which is what a dead isolate's successor replays.
            'stage-attempt',
            'create-session',
            'finish-attempt',
        ]);
        expect(h.deps.releaseAttempt).not.toHaveBeenCalled();
        // And the session is remembered, so the next request can hand it back.
        expect(h.attempts.sessionId).toBe('cs_1');
        expect(h.attempts.priceId).toBe(PRICE_KEY);
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
            subscription_data: { metadata: { user_id: USER, consent_id: 'consent-1' } },
            metadata: {
                user_id: USER,
                checkout_key: checkoutIdempotencyKey(USER, 'live', PRICE_KEY, 'attempt-1'),
                consent_id: 'consent-1',
            },
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

    /**
     * The lease was shorter than the invocation holding it could legally run, and
     * the idempotency key existed only in that invocation's memory. Either one on
     * its own is a second payable session (QA round 4 review of #56, finding 1).
     */
    describe('an attempt that outlives, or dies inside, its own lease', () => {
        it('agrees with stripeEvents.ts about what an invocation can run for', () => {
            // The number is stated twice because neither module may import the
            // other at runtime -- Deno wants the `.ts` extension and vitest
            // wants it gone, which is why checkoutFlow.ts takes
            // holdsRunningSubscription through `deps` rather than importing it.
            // Two copies of a platform limit is exactly the kind of thing that
            // drifts, and both leases are sized against it.
            expect(EDGE_FUNCTION_WALL_CLOCK_MS).toBe(WEBHOOK_WALL_CLOCK_MS);
        });

        it('leases the lock for longer than an invocation can run', () => {
            // Two minutes was the bug stated as a number: an invocation may run
            // longer than that, so a request that was merely SLOW inside
            // `checkout.sessions.create` had its lock taken off it while it was
            // still going to create a session.
            expect(CHECKOUT_ATTEMPT_STALE_AFTER_MS).toBeGreaterThan(EDGE_FUNCTION_WALL_CLOCK_MS);
            // And the two spellings of the lease agree, because the interval is
            // what Postgres compares and the number is what this file models.
            expect(LEASE_MS).toBe(CHECKOUT_ATTEMPT_STALE_AFTER_MS);
        });

        it('replays the dead attempt key instead of opening a second session', async () => {
            // The isolate dies between the Stripe create and the record of it:
            // Stripe has a payable session, `checkout_attempts` has no session
            // id, and nothing in the old design could connect the two -- the key
            // was gone with the isolate, so the buyer's next attempt minted a
            // fresh one and Stripe made them a SECOND session. Both payable.
            const h = harness({ customerId: 'cus_1' });
            await diesInsideCreate(h);

            // Stripe's side of the half-finished attempt: one payable session
            // nobody recorded.
            expect(h.stripe.openSessions()).toHaveLength(1);
            // Our side: the key it was created with, which is the whole fix.
            expect(h.attempts.attemptId).toBe('attempt-1');
            expect(h.attempts.sessionId).toBeNull();
            // And the lock it never gave back, which is why the next request
            // can only have it once the lease has gone stale.
            expect(h.attempts.holder).toBe('holder-1');

            const next = await handleCheckout(post(), h.deps);

            expect(next.status).toBe(200);
            // The SAME key, so Stripe answers with the session it already made.
            expect(h.stripe.keysUsed).toEqual([
                checkoutIdempotencyKey(USER, 'live', PRICE_KEY, 'attempt-1'),
                checkoutIdempotencyKey(USER, 'live', PRICE_KEY, 'attempt-1'),
            ]);
            expect(h.stripe.sessions).toHaveLength(1);
            expect(h.stripe.openSessions()).toHaveLength(1);
            expect(await body(next)).toEqual({ url: 'https://checkout.stripe.com/cs_1' });
            // And it is recorded this time, so the attempt after it is layer 4.
            expect(h.attempts.sessionId).toBe('cs_1');
        });

        it('does not expire the session it is about to replay the key for', async () => {
            // The trap in the paragraph above: expiring first and then replaying
            // the key hands the buyer the URL of a session we have just killed --
            // exactly the dead Checkout page the per-attempt key replaced the old
            // time-bucket key to avoid.
            const h = harness({ customerId: 'cus_1' });
            await diesInsideCreate(h);
            const expiresBefore = (h.deps.expireOpenSessions as ReturnType<typeof vi.fn>).mock.calls.length;

            const next = await handleCheckout(post(), h.deps);

            expect((h.deps.expireOpenSessions as ReturnType<typeof vi.fn>).mock.calls.length).toBe(expiresBefore);
            expect(h.stripe.openSessions()).toHaveLength(1);
            expect(await body(next)).toEqual({ url: h.stripe.openSessions()[0]?.url });
        });

        it('still expires, and uses a fresh key, when the dead attempt was for another plan', async () => {
            // The replay is only right for the SAME purchase. Teacher died
            // half-done and the buyer now wants Academy: Teacher's orphan session
            // has to be expired, and Academy needs a key of its own.
            const h = harness({ customerId: 'cus_1' });
            await diesInsideCreate(h);

            const academy = await handleCheckout(postAcademy(), h.deps);

            expect(academy.status).toBe(200);
            expect(h.stripe.keysUsed).toEqual([
                checkoutIdempotencyKey(USER, 'live', PRICE_KEY, 'attempt-1'),
                checkoutIdempotencyKey(USER, 'live', ACADEMY_KEY, 'attempt-2'),
            ]);
            // Two sessions made over the two attempts, exactly one payable.
            expect(h.stripe.sessions).toHaveLength(2);
            expect(h.stripe.openSessions()).toHaveLength(1);
            expect(h.stripe.openSessions()[0]?.id).toBe('cs_2');
        });

        it('opens nothing for an attempt whose lease was taken over while it ran', async () => {
            // The review's own scenario, end to end: A stalls inside the Stripe
            // create long enough for its lease to go stale, B takes the lock
            // over. Before the fix B saw no open session yet (A's create had not
            // returned), expired nothing, and opened its own -- two payable
            // sessions, reached THROUGH the lock. Now A cannot stage its key
            // under a lease it no longer holds, so it never reaches the create.
            const gate = latch();
            const h = harness({ customerId: 'cus_1', pauseBeforeStage: gate });
            // A is suspended at the staging of its key, one step before the
            // create...
            const stalled = handleCheckout(post(), h.deps);
            await gate.arrived;
            // ...and its lease goes stale while it is there, so B takes the lock
            // over and runs the whole flow for a different plan.
            h.attempts.clock += LEASE_MS + 1_000;
            const tookOver = await handleCheckout(postAcademy(), h.deps);
            gate.release();
            const stalledResponse = await stalled;

            expect(tookOver.status).toBe(200);
            expect(stalledResponse.status).toBe(409);
            expect(await body(stalledResponse)).toMatchObject({ code: 'checkout_in_progress' });
            // One create, one session, one payable session.
            expect(h.deps.createSession).toHaveBeenCalledTimes(1);
            expect(h.stripe.sessions).toHaveLength(1);
            expect(h.stripe.openSessions()).toHaveLength(1);
            expect(h.params.map((p) => p.line_items[0]?.price)).toEqual([ACADEMY_PRICE]);
            expect(h.logs.some((line) => line.includes('taken over before a session was opened'))).toBe(true);
        });

        it('asks the buyer to retry rather than hand out a session it could not record', async () => {
            // The narrower version of the same thing: the lease is lost while the
            // create is in flight, so by the time it returns another request has
            // run the expiry and the URL may already be dead. A 409 costs the
            // buyer a click; a dead Checkout page costs them the purchase.
            const h = harness({ customerId: 'cus_1' });
            h.deps.finishAttempt = async () => false;

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(409);
            expect(await body(response)).toMatchObject({ code: 'checkout_in_progress' });
            expect(h.logs.some((line) => line.includes('taken over before session cs_1 could be recorded'))).toBe(true);
            // And the session it opened is not left payable: nobody will ever be
            // sent to it, and the request that took the lease over has one of its
            // own, so an open orphan beside it is two payable sessions.
            expect(h.deps.expireSession).toHaveBeenCalledWith('cs_1', 'live');
            expect(h.stripe.openSessions()).toHaveLength(0);
        });

        it('expires the orphan it opened, and leaves the live session alone', async () => {
            // The same thing with both requests real: A's create is still in
            // flight when its lease goes stale, B takes the lock over and runs
            // the whole flow, and A's session arrives AFTER B's expiry has
            // already been and gone. Two sessions exist in Stripe -- A's create
            // could not be called back -- so the only question is how many are
            // payable, and expiring A's by id is what makes the answer one
            // without killing the URL B has just handed the buyer.
            const gate = latch();
            const h = harness({ customerId: 'cus_1', pauseBeforeCreate: gate });
            const stalled = handleCheckout(post(), h.deps);
            await gate.arrived;
            h.attempts.clock += LEASE_MS + 1_000;
            const tookOver = await handleCheckout(postAcademy(), h.deps);
            gate.release();
            const stalledResponse = await stalled;

            expect(tookOver.status).toBe(200);
            expect(await body(tookOver)).toEqual({ url: 'https://checkout.stripe.com/cs_1' });
            expect(stalledResponse.status).toBe(409);
            expect(h.stripe.sessions).toHaveLength(2);
            expect(h.stripe.openSessions().map((session) => session.id)).toEqual(['cs_1']);
            expect(h.deps.expireSession).toHaveBeenCalledWith('cs_2', 'live');
            expect(h.logs.some((line) => line.includes('expired orphan session cs_2'))).toBe(true);
        });

        it('still refuses the buyer when the orphan cannot be expired', async () => {
            // A Stripe call we cannot make is not a reason to hand out a URL the
            // other request's expiry may already have killed. The next attempt's
            // layer 5 finds the orphan anyway.
            const h = harness({ customerId: 'cus_1' });
            h.deps.finishAttempt = async () => false;
            h.deps.expireSession = async () => {
                throw new Error('Stripe could not be reached');
            };

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(409);
            expect(h.errors).toEqual(['orphan_session_expire_failed']);
        });

        it('refuses the checkout when the key cannot be made durable', async () => {
            // Fail closed, for the same reason the failed expiry does: a session
            // created under a key nothing can read back is a session the next
            // attempt cannot recognise, and it would open a second one beside it.
            const h = harness({ customerId: 'cus_1' });
            h.deps.stageAttempt = async () => {
                throw new Error('connection reset');
            };

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
            expect(await body(response)).toMatchObject({ code: 'checkout_unavailable' });
            expect(h.deps.createSession).not.toHaveBeenCalled();
            expect(h.errors).toEqual(['checkout_attempt_stage_failed']);
            // The lock is handed back, so the retry we just asked for is not
            // refused as an attempt in flight.
            expect(h.attempts.holder).toBeNull();
        });
    });

    /**
     * Stripe's idempotency layer saves the answer a key got -- a session OR an
     * error -- and replays it for 24 hours. Staging the key before the create
     * (above) made a dead isolate's session recoverable; it also made a FAILED
     * create's key recoverable, which is not the same favour (Codex round 2 of
     * #56).
     */
    describe('a create whose failure this request lived to see', () => {
        it('mints a fresh key instead of replaying the 500 Stripe remembers', async () => {
            // The lockout: the create came back 500, the row kept the attempt id
            // it had staged, and layer 4b read that as "replay this key". Stripe
            // answered the replay with the same 500 it had saved -- so did the
            // retry after that, for 24 hours. The buyer could not buy that plan
            // at all, and switching plan was the only way out.
            const h = harness({ customerId: 'cus_1' });
            h.stripe.createFails = 'Stripe had an internal error';

            const failed = await handleCheckout(post(), h.deps);

            expect(failed.status).toBe(502);
            // Nothing staged for a later attempt to replay: a key Stripe has
            // saved a failure against is a key nothing may use again.
            expect(h.attempts.attemptId).toBeNull();
            expect(h.attempts.priceId).toBeNull();
            expect(h.attempts.sessionId).toBeNull();
            expect(h.attempts.holder).toBeNull();

            h.stripe.createFails = null;
            const next = await handleCheckout(post(), h.deps);

            expect(next.status).toBe(200);
            expect(await body(next)).toEqual({ url: 'https://checkout.stripe.com/cs_1' });
            // A FRESH key, so Stripe creates a session rather than replaying its
            // own error at the buyer.
            expect(h.stripe.keysUsed).toEqual([
                checkoutIdempotencyKey(USER, 'live', PRICE_KEY, 'attempt-1'),
                checkoutIdempotencyKey(USER, 'live', PRICE_KEY, 'attempt-2'),
            ]);
            expect(h.stripe.openSessions()).toHaveLength(1);
        });

        it('expires the session a lost answer may have opened, rather than replay its key', async () => {
            // The other shape of a watched failure: the create DID reach Stripe
            // and the answer went missing (a timeout, a reset), so Stripe holds a
            // session whose id we never saw. Discarding the key gives that up,
            // and gives up nothing: the next request has no key to replay, so it
            // runs layer 5, where the orphan is expired like any other open
            // session before a new one is opened. One payable session either way,
            // and no key that can replay a failure.
            const h = harness({ customerId: 'cus_1' });
            const realCreate = h.deps.createSession;
            h.deps.createSession = async (params, sessionOptions, mode) => {
                await realCreate(params, sessionOptions, mode);
                throw new Error('socket hang up');
            };

            const lost = await handleCheckout(post(), h.deps);
            expect(lost.status).toBe(502);
            expect(h.attempts.attemptId).toBeNull();

            h.deps.createSession = realCreate;
            const next = await handleCheckout(post(), h.deps);

            expect(next.status).toBe(200);
            expect(await body(next)).toEqual({ url: 'https://checkout.stripe.com/cs_2' });
            expect(h.stripe.sessions).toHaveLength(2);
            expect(h.stripe.openSessions().map((session) => session.id)).toEqual(['cs_2']);
            expect(h.stripe.keysUsed).toEqual([
                checkoutIdempotencyKey(USER, 'live', PRICE_KEY, 'attempt-1'),
                checkoutIdempotencyKey(USER, 'live', PRICE_KEY, 'attempt-2'),
            ]);
        });

        it('reads a replayed answer back, and refuses rather than send the buyer to a dead page', async () => {
            // What Stripe replays is the response it SAVED, not the session as it
            // stands today, so a key staged a day ago can hand back the URL of a
            // session that has since been expired or paid. The read is what turns
            // that into a retry the buyer can act on instead of a Checkout page
            // that refuses them with nothing to go back to.
            const h = harness({ customerId: 'cus_1' });
            await diesInsideCreate(h);
            // Something else has since expired the orphan -- here, the account's
            // own open sessions being cleared -- while the staged key lives on.
            h.stripe.expireOpenSessions('cus_1');

            const replayed = await handleCheckout(post(), h.deps);

            expect(replayed.status).toBe(502);
            expect(await body(replayed)).toMatchObject({ code: 'checkout_unavailable' });
            expect(h.logs.some((line) => line.includes('replayed key'))).toBe(true);
            // The spent key is given up with it, so the retry is a clean attempt
            // rather than the same replay again.
            expect(h.attempts.attemptId).toBeNull();

            const next = await handleCheckout(post(), h.deps);

            expect(next.status).toBe(200);
            expect(await body(next)).toEqual({ url: 'https://checkout.stripe.com/cs_2' });
            expect(h.stripe.openSessions().map((session) => session.id)).toEqual(['cs_2']);
        });

        it('forgets the key when Stripe answers without a URL', async () => {
            // Nothing payable came back, so the key is spent on that answer
            // exactly as it is on an error -- and replaying it would get the same
            // URL-less answer back for a day.
            const h = harness({ customerId: 'cus_1' });
            h.deps.createSession = async () => ({ id: 'cs_no_url', url: null });

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
            expect(h.attempts.attemptId).toBeNull();
            expect(h.attempts.holder).toBeNull();
        });

        it('still answers the buyer when the key cannot be discarded', async () => {
            // Best effort: a discard that fails leaves the buyer where this fix
            // found them, which is a reason to log it and not a reason to answer
            // them differently.
            const h = harness({ customerId: 'cus_1' });
            h.stripe.createFails = 'Stripe had an internal error';
            h.deps.discardAttempt = async () => {
                throw new Error('connection reset');
            };

            const response = await handleCheckout(post(), h.deps);

            expect(response.status).toBe(502);
            expect(h.errors).toEqual(['checkout_attempt_discard_failed', 'checkout_failed']);
            // The lock is still given back, by the release every unrecorded path
            // runs.
            expect(h.attempts.holder).toBeNull();
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

describe('auto-renewal consent, currency and Stripe Tax (launch items 13-17)', () => {
    it('refuses a checkout whose box was not ticked, before taking the lock or recording anything', async () => {
        const h = harness();

        for (const consent of [undefined, { ...consentFor('teacherAnnual'), accepted: false }]) {
            const response = await handleCheckout(post({ priceId: 'price_teacher_annual', consent }), h.deps);
            expect(response.status).toBe(400);
            expect(await body(response)).toMatchObject({ code: 'consent_required' });
        }
        expect(h.deps.beginAttempt).not.toHaveBeenCalled();
        expect(h.consents).toEqual([]);
    });

    it('refuses a country it cannot price for', async () => {
        const h = harness();
        const response = await handleCheckout(
            post({ priceId: 'price_teacher_annual', consent: { ...consentFor('teacherAnnual'), country: 'Narnia' } }),
            h.deps,
        );
        expect(response.status).toBe(400);
        expect(await body(response)).toMatchObject({ code: 'country_required' });
    });

    it('refuses wording that is not what this server would charge under', async () => {
        // The euro wording sent from a US address, and a bundle from before a
        // wording change: neither is consent to the purchase about to be made.
        const h = harness();
        for (const text of [consentFor('teacherAnnual', 'DE').text, `${consentFor('teacherAnnual').text} `]) {
            const response = await handleCheckout(
                post({ priceId: 'price_teacher_annual', consent: { ...consentFor('teacherAnnual'), text } }),
                h.deps,
            );
            expect(response.status).toBe(409);
            expect(await body(response)).toMatchObject({ code: 'consent_outdated' });
        }
        expect(h.deps.createSession).not.toHaveBeenCalled();
        expect(h.consents).toEqual([]);
    });

    it('records the exact wording, versions, country and IP, and ties the session to it', async () => {
        const h = harness({ customerId: 'cus_1' });

        await handleCheckout(post(), h.deps);

        expect(h.consents).toEqual([
            {
                id: 'consent-1',
                sessionId: 'cs_1',
                userId: USER,
                mode: 'live',
                stripeCustomerId: 'cus_1',
                priceId: PRICE,
                planSlot: 'teacherAnnual',
                currency: 'usd',
                amountMinor: 19000,
                renewalInterval: 'year',
                taxInclusive: false,
                wording: consentFor('teacherAnnual').text,
                wordingVersion: billingTerms.CONSENT_WORDING_VERSION,
                termsVersion: billingTerms.LEGAL_VERSIONS.terms,
                refundPolicyVersion: billingTerms.LEGAL_VERSIONS.refunds,
                declaredCountry: 'US',
                ip: '203.0.113.9',
                userAgent: null,
            },
        ]);
    });

    it('opens the session with Stripe Tax, a required billing address and the renewal terms by the Pay button', async () => {
        const h = harness({ customerId: 'cus_1' });

        await handleCheckout(post(), h.deps);

        expect(h.params[0]).toMatchObject({
            currency: 'usd',
            automatic_tax: { enabled: true },
            billing_address_collection: 'required',
            customer_update: { address: 'auto', name: 'auto' },
            custom_text: {
                submit: {
                    message: billingTerms.checkoutSubmitMessage(billingTerms.purchaseTermsFor('teacherAnnual', 'usd')),
                },
            },
        });
        expect(h.params[0]?.custom_text.submit.message.length).toBeLessThanOrEqual(1200);
    });

    it('charges a buyer in Germany in euros, VAT included', async () => {
        const h = harness({ customerId: 'cus_1' });

        const response = await handleCheckout(
            post({ priceId: 'price_teacher_annual', consent: consentFor('teacherAnnual', 'DE') }),
            h.deps,
        );

        expect(response.status).toBe(200);
        expect(h.params[0]?.currency).toBe('eur');
        expect(h.consents[0]).toMatchObject({ currency: 'eur', amountMinor: 21000, taxInclusive: true });
        expect(h.consents[0]?.wording).toContain('€210 (VAT included)');
        expect(h.attempts.priceId).toBe(purchaseKey(PRICE, 'eur'));
    });

    it('never hands back an open session priced in the other currency', async () => {
        // Same plan, new country: the open USD session is not what the buyer
        // just agreed to, so it is expired and a euro one opened in its place.
        const h = harness({ customerId: 'cus_1' });

        const dollars = await body(await handleCheckout(post(), h.deps));
        const euros = await body(
            await handleCheckout(
                post({ priceId: 'price_teacher_annual', consent: consentFor('teacherAnnual', 'FR') }),
                h.deps,
            ),
        );

        expect(euros.url).not.toBe(dollars.url);
        expect(h.stripe.openSessions()).toHaveLength(1);
        expect(h.params.map((params) => params.currency)).toEqual(['usd', 'eur']);
    });

    it('records a fresh consent when the buyer is sent back to their open session', async () => {
        const h = harness({ customerId: 'cus_1' });

        const first = await body(await handleCheckout(post(), h.deps));
        const second = await body(await handleCheckout(post(), h.deps));

        expect(second.url).toBe(first.url);
        expect(h.consents.map((row) => [row.id, row.sessionId])).toEqual([
            ['consent-1', 'cs_1'],
            ['consent-2', 'cs_1'],
        ]);
    });

    it('opens nothing when the consent cannot be stored', async () => {
        const h = harness({ customerId: 'cus_1', consentFails: true });

        const response = await handleCheckout(post(), h.deps);

        expect(response.status).toBe(502);
        expect(h.deps.createSession).not.toHaveBeenCalled();
        expect(h.deps.expireOpenSessions).not.toHaveBeenCalled();
        expect(h.errors).toContain('consent_record_failed');
        // And the lock is given back for the retry.
        expect(h.attempts.holder).toBeNull();
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
        // And one session by id, for the orphan of a create that lost its lease:
        // expiring that buyer's open sessions would kill the live one too.
        expect(source).toContain('expireCheckoutSession');
    });

    it('takes the cross-isolate lock through the RPCs that hold it', () => {
        expect(source).toContain('begin_checkout_attempt');
        expect(source).toContain('stage_checkout_attempt');
        expect(source).toContain('finish_checkout_attempt');
        expect(source).toContain('release_checkout_attempt');
        expect(source).toContain('CHECKOUT_ATTEMPT_STALE_AFTER');
    });

    it('discards a staged key through finish_checkout_attempt with nothing to remember', () => {
        // No migration of its own: the discard is the record statement with no
        // attempt, no price and no session, under the same lease scoping. A
        // reader of the SQL sees only finish_checkout_attempt, so the nulls are
        // asserted here.
        expect(source).toMatch(/p_attempt_id: null,\s*\n\s*p_price_id: null,\s*\n\s*p_session_id: null,/);
    });
});
