import type { StripeMode } from './stripeMode.ts';
import type * as StripeEvents from './stripeEvents.ts';

/**
 * Opening a Stripe Checkout Session for a subscription: who may, at what price,
 * against which Stripe account, and -- the part this file exists for -- how a
 * buyer who submits twice ends up with ONE charge.
 *
 * The double charge it closes (QA round 4, D1): the only guard used to be
 * `holdsRunningSubscription` over the `subscriptions` mirror, and that mirror is
 * written by the webhook when a session is PAID. Checking it at session
 * CREATION therefore answers a question about the past. Two sessions opened
 * before either was paid both passed -- two tabs, a double-click, a cancelled
 * checkout resumed with the back button; Stripe keeps a session payable for 24
 * hours -- and paying both produced two `active` subscriptions billing the same
 * period twice, with nothing in the app to show it (get_entitlements takes the
 * highest tier and stops).
 *
 * Three layers now, and this file is two of them:
 *  1. the customer's open sessions are expired before a new one is created, so
 *     there is never more than one session that can be paid;
 *  2. session creation carries a deterministic idempotency key, so a genuine
 *     double-submit is answered with the SAME session instead of a second one;
 *  3. a partial unique index on (user_id, mode) where the status entitles
 *     (migration 20261012120100) makes a second entitling row unwritable even
 *     if both of the above are somehow bypassed.
 *
 * NO runtime imports, like guestEmail.ts and stripeEvents.ts: Deno wants the
 * `.ts` extension and vitest wants it gone, so everything doing I/O -- and the
 * one rule borrowed from stripeEvents.ts -- arrives in `deps`, and
 * stripe-checkout/index.ts is only the wiring. That is also what makes "two
 * concurrent sessions, only one of which can be paid" a test rather than a
 * manual Stripe rehearsal.
 */

/** Checkouts per client per minute, unchanged from before the extraction. */
export const CHECKOUT_RATE = { limit: 10, windowMs: 60_000 } as const;

/**
 * How wide a window counts as "the same purchase attempt" for Stripe's
 * idempotency key.
 *
 * Stripe remembers a key for 24 hours and replays the original response for it,
 * so the width decides how long a buyer is held to their first session. Too
 * narrow and a double-click that happens to straddle a boundary mints a second
 * session -- which layer 1 then expires, so the buyer sees a dead Checkout page
 * instead of a double charge, but that is still a failed purchase. Too wide and
 * a buyer who abandoned a session, or whose card was declined on it, is handed
 * that same stale session back for the rest of the window with no way to start
 * over. Ten minutes is far above every accidental double-submit (they arrive
 * within seconds) and far below Stripe's 24-hour memory, so a buyer who comes
 * back later gets a fresh session.
 *
 * Bucketing by wall clock rather than by anything per-request is the whole
 * point: two isolates serving a double-click share no state, so the key has to
 * be computable from the purchase alone.
 */
export const CHECKOUT_IDEMPOTENCY_BUCKET_MS = 10 * 60_000;

/**
 * What identifies this purchase attempt: the buyer, the Stripe account, the
 * price, and the time bucket. Mode is in it because the same user may legitimately
 * check out in both accounts (a developer testing against sandbox), and price is
 * in it because changing your mind from Teacher to Academy is a different
 * purchase that must not be answered with the first one's session.
 */
export const checkoutIdempotencyKey = (userId: string, mode: StripeMode, priceId: string, nowMs: number): string =>
    `checkout:${mode}:${userId}:${priceId}:${Math.floor(nowMs / CHECKOUT_IDEMPOTENCY_BUCKET_MS)}`;

export const ALREADY_SUBSCRIBED = {
    error: 'You already have a subscription. Change or resume it with Manage subscription on your Account page.',
    code: 'already_subscribed',
} as const;

/**
 * The buyer, as this flow needs them. `email` is a thunk because reading it
 * costs a GoTrue round trip and only a buyer who has never had a Stripe
 * customer needs one -- everybody else is resolved from `billing_customers`.
 */
export interface CheckoutCaller {
    userId: string;
    email: () => Promise<string | null>;
}

/**
 * Both lookups answer "could not read" separately from "nothing there", because
 * the two demand opposite behaviour. Nothing there means carry on; could not
 * read means refuse the checkout. A failed `billing_customers` read used to
 * fall through to creating a second Stripe customer, and a second customer has
 * its own open sessions -- so layer 1 would have found none to expire and both
 * sessions would have been payable. A buyer asked to try again is strictly
 * better than a buyer charged twice.
 */
export type RunningLookup =
    { ok: true; rows: Array<{ status: string; current_period_end: string | null }> } | { ok: false; error: unknown };

export type CustomerLookup = { ok: true; customerId: string | null } | { ok: false; error: unknown };

/**
 * Exactly the Stripe `checkout.sessions.create` params, built here so the shape
 * of the purchase is covered by tests and index.ts has no decisions left in it.
 */
export interface CheckoutSessionParams {
    mode: 'subscription';
    customer: string;
    line_items: Array<{ price: string; quantity: number }>;
    client_reference_id: string;
    subscription_data: { metadata: Record<string, string> };
    metadata: Record<string, string>;
    success_url: string;
    cancel_url: string;
    allow_promotion_codes: boolean;
}

export interface CheckoutDeps {
    json: (body: unknown, status?: number) => Response;
    options: () => Response;
    clientKey: (req: Request) => string;
    checkRateLimit: (
        key: string,
        limit: number,
        windowMs: number,
    ) => Promise<{ ok: true } | { ok: false; retryAfterSec: number }>;
    /** The caller, or the refusal to answer them with (unauthenticated, anonymous, a student). */
    authenticate: (req: Request) => Promise<CheckoutCaller | Response>;
    modeForRequest: (req: Request) => StripeMode | null;
    resolvePrice: (priceId: string, mode: StripeMode) => string | null;
    appOrigin: (req: Request) => string;
    /**
     * Whether this deployment can transact in `mode` at all — a Stripe secret
     * key and a service-role client. Asked after the origin has named a mode,
     * so an origin we do not publish from is still the 400 below rather than a
     * report about our own configuration.
     */
    billingConfigured: (mode: StripeMode) => boolean;
    runningSubscriptions: (userId: string, mode: StripeMode) => Promise<RunningLookup>;
    findCustomer: (userId: string, mode: StripeMode) => Promise<CustomerLookup>;
    createCustomer: (userId: string, email: string | null, mode: StripeMode) => Promise<string>;
    /** Expires the customer's open sessions, leaving alone one stamped with this key. */
    expireOpenSessions: (customerId: string, keepIdempotencyKey: string, mode: StripeMode) => Promise<number>;
    createSession: (
        params: CheckoutSessionParams,
        options: { idempotencyKey: string },
        mode: StripeMode,
    ) => Promise<{ url?: string | null }>;
    /**
     * stripeEvents.ts's own rule about what counts as a running subscription,
     * handed in rather than imported, like guestEmail.ts takes passwordPolicy:
     * this module has no runtime imports, which is what lets vitest load the
     * exact file Deno runs.
     */
    holdsRunningSubscription: typeof StripeEvents.holdsRunningSubscription;
    now: () => number;
    log: (message: string) => void;
    logError: (code: string, err: unknown) => void;
}

/**
 * Free signup stays card-free -- the free tier is simply "no subscriptions row"
 * -- so nothing here runs until a teacher chooses to pay.
 */
export const handleCheckout = async (req: Request, deps: CheckoutDeps): Promise<Response> => {
    if (req.method === 'OPTIONS') {
        return deps.options();
    }
    if (req.method !== 'POST') {
        return deps.json({ error: 'Method not allowed' }, 405);
    }

    const rate = await deps.checkRateLimit(
        `checkout:${deps.clientKey(req)}`,
        CHECKOUT_RATE.limit,
        CHECKOUT_RATE.windowMs,
    );
    if (!rate.ok) {
        return deps.json({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    const caller = await deps.authenticate(req);
    if (caller instanceof Response) {
        return caller;
    }

    let body: { priceId?: string };
    try {
        body = (await req.json()) as { priceId?: string };
    } catch {
        return deps.json({ error: 'Invalid JSON body' }, 400);
    }

    // Which Stripe account this buyer belongs to is decided by where they are
    // browsing, never by anything they send: cleffy.io is the live account,
    // dev.cleffy.io the sandbox. An origin we do not publish from gets no
    // checkout at all rather than a guessed account.
    const mode = deps.modeForRequest(req);
    if (!mode) {
        return deps.json({ error: 'Unrecognised origin', code: 'unknown_origin' }, 400);
    }

    const requested = typeof body.priceId === 'string' ? body.priceId.trim() : '';
    // Only prices we published are checkout-able; a client-supplied id is never
    // trusted. The id names the plan, and this re-prices that plan in the
    // caller's own mode, so a bundle cached from before the live flip still
    // checks out against the right account.
    const priceId = requested ? deps.resolvePrice(requested, mode) : null;
    if (!priceId) {
        return deps.json({ error: 'Unknown price', code: 'unknown_price' }, 400);
    }

    if (!deps.billingConfigured(mode)) {
        return deps.json({ error: 'Billing is not configured' }, 500);
    }

    try {
        // One subscription per buyer per account: switching plans or resuming a
        // cancelled one is the billing portal's job, and a second Checkout here
        // would bill both (see holdsRunningSubscription). This catches the slow
        // case -- a subscriber coming back for a second plan days later -- and
        // the layers below it catch the fast one, where nothing has been paid
        // yet and so nothing is in this table to find.
        const running = await deps.runningSubscriptions(caller.userId, mode);
        if (!running.ok) {
            deps.logError('subscription_check_failed', running.error);
            return deps.json({ error: 'Could not check your current plan. Please try again.' }, 502);
        }
        if (deps.holdsRunningSubscription(running.rows, deps.now())) {
            return deps.json(ALREADY_SUBSCRIBED, 409);
        }

        // The customer FIRST, because the open sessions to expire are the ones
        // belonging to this customer, and a buyer upgrading for the first time
        // has no customer yet. Scoped to the mode: a customer id belongs to one
        // Stripe account, so the sandbox `cus_…` a teacher picked up testing on
        // dev is not a customer the live account has ever heard of.
        const found = await deps.findCustomer(caller.userId, mode);
        if (!found.ok) {
            deps.logError('customer_lookup_failed', found.error);
            return deps.json({ error: 'Could not start checkout. Please try again.' }, 502);
        }
        const customerId = found.customerId ?? (await deps.createCustomer(caller.userId, await caller.email(), mode));

        const idempotencyKey = checkoutIdempotencyKey(caller.userId, mode, priceId, deps.now());

        // Then the open sessions, THEN the new one. Expiring is what makes "only
        // one session can be paid" true, so it must not be possible for it to
        // fail quietly and let the purchase through anyway: a buyer asked to
        // retry is strictly better than a buyer charged twice. Hence the refusal
        // rather than a logged warning -- we will not mint a session we could
        // not de-duplicate.
        try {
            const expired = await deps.expireOpenSessions(customerId, idempotencyKey, mode);
            if (expired > 0) {
                deps.log(`checkout: expired ${expired} open session(s) for ${customerId} before opening another`);
            }
        } catch (err) {
            deps.logError('expire_open_sessions_failed', err);
            return deps.json(
                { error: 'Could not start checkout. Please try again.', code: 'checkout_unavailable' },
                502,
            );
        }

        const origin = deps.appOrigin(req);
        const session = await deps.createSession(
            {
                mode: 'subscription',
                customer: customerId,
                line_items: [{ price: priceId, quantity: 1 }],
                // Both are belt-and-braces for the webhook's user resolution: either
                // survives even if the billing_customers row is somehow missing.
                client_reference_id: caller.userId,
                subscription_data: { metadata: { user_id: caller.userId } },
                // `checkout_key` is how expireOpenSessions recognises the session
                // this request's own idempotency key already created, and leaves it
                // open instead of killing the page the buyer is being sent to.
                metadata: { user_id: caller.userId, checkout_key: idempotencyKey },
                success_url: `${origin}/settings?checkout=success`,
                cancel_url: `${origin}/settings?checkout=cancelled`,
                allow_promotion_codes: true,
            },
            { idempotencyKey },
            mode,
        );

        if (!session.url) {
            return deps.json({ error: 'Stripe did not return a checkout URL' }, 502);
        }
        return deps.json({ url: session.url });
    } catch (err) {
        deps.logError('checkout_failed', err);
        return deps.json({ error: err instanceof Error ? err.message : 'Checkout failed' }, 502);
    }
};
