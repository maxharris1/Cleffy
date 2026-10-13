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
 * The first round of fixes expired the customer's open sessions before opening
 * another and keyed creation on a deterministic idempotency key derived from the
 * buyer, the price and a ten-minute wall-clock bucket. Both only serialise two
 * requests that AGREE about the purchase and arrive in the same bucket: Teacher
 * in one tab and Academy in the other, or a double-click that straddles a bucket
 * boundary, get different keys, so Stripe creates two sessions -- and because
 * two isolates interleave (both list the open sessions, each finding only its
 * own or none, both create), the expire step leaves both payable. That is the
 * same double charge by another road, and no amount of key arithmetic closes it,
 * because the requests share no state to agree on.
 *
 * So what makes "one payable session per buyer" true now is a lock that lives
 * where both isolates can see it -- a leased row in `checkout_attempts`
 * (migration 20261012120103), taken for the (user, mode) pair before anything
 * is read from Stripe and released after the session is recorded. Five layers,
 * outermost first:
 *
 *  1. the `subscriptions` mirror still refuses a buyer who already holds a
 *     running subscription -- the slow case, days later, and the cheapest read;
 *  2. the lock: a second request that arrives while one is inside is refused
 *     (409) rather than racing it;
 *  3. STRIPE's own view of the customer's subscriptions, which is what catches
 *     a session that has been PAID but whose webhook has not landed yet -- the
 *     mirror cannot know about it, and the session is no longer open, so there
 *     is nothing to expire either;
 *  4. the session the last attempt opened, remembered in the same row: still
 *     open for the same price, the buyer is handed it back instead of a second
 *     one; paid and still resolving, they are asked to wait;
 *  5. everything else open is expired before a new session is created, and the
 *     new session's idempotency key carries a FRESH attempt id, so Stripe never
 *     replays the URL of a session we have since expired.
 *
 * Underneath all of it, a partial unique index on (user_id, mode) where the
 * status entitles (migration 20261012120100) makes a second entitling row
 * unwritable, and the webhook cancels and refunds a duplicate that still gets
 * through.
 *
 * NO runtime imports, like guestEmail.ts and stripeEvents.ts: Deno wants the
 * `.ts` extension and vitest wants it gone, so everything doing I/O -- and the
 * one rule borrowed from stripeEvents.ts -- arrives in `deps`, and
 * stripe-checkout/index.ts is only the wiring. That is also what makes "two
 * requests genuinely overlapping, only one of which can be paid" a test rather
 * than a manual Stripe rehearsal.
 */

/** Checkouts per client per minute, unchanged from before the extraction. */
export const CHECKOUT_RATE = { limit: 10, windowMs: 60_000 } as const;

/**
 * How long a checkout attempt may hold the (user, mode) lock before another
 * request may take it over.
 *
 * Written as a Postgres interval because that is where the comparison happens
 * (begin_checkout_attempt, migration 20261012120103). It has to clear the
 * slowest honest attempt -- a Stripe subscription list, a session read, the
 * expiries and the create, so a handful of round trips -- or a buyer whose first
 * request is still in flight takes the lock from it and opens a second session
 * beside theirs. And it has to be short enough that an isolate killed
 * mid-checkout does not lock a buyer out of paying us for long. Two minutes sits
 * between the two: well past any sequence of Stripe calls that is still running,
 * and inside the patience of someone who just pressed a button twice.
 */
export const CHECKOUT_ATTEMPT_STALE_AFTER = '2 minutes';

/**
 * What identifies this purchase attempt to Stripe's idempotency layer: the
 * buyer, the account, the price, and the attempt id minted when the session was
 * created.
 *
 * The attempt id, rather than a time bucket, is what fixed D1's fourth leg.
 * Stripe replays a key's original response for 24 hours, so a key that two
 * different attempts can compute hands the second one a session the first has
 * since had expired -- Teacher, then Academy, then Teacher again inside one
 * bucket replayed a dead Checkout URL. An id minted per attempt cannot be
 * recomputed, so every attempt that reaches Stripe creates its own session, and
 * the attempt that wants the PREVIOUS session is served by reading it back out
 * of `checkout_attempts` instead (layer 4).
 */
export const checkoutIdempotencyKey = (userId: string, mode: StripeMode, priceId: string, attemptId: string): string =>
    `checkout:${mode}:${userId}:${priceId}:${attemptId}`;

/**
 * Stripe subscription statuses that mean this buyer is already subscribed, read
 * from Stripe rather than from our mirror. Deliberately the same rule
 * `holdsRunningSubscription` applies to the mirror -- entitling, or still being
 * retried -- so the two layers cannot disagree about who may buy.
 */
const SUBSCRIBED_STRIPE_STATUSES = ['active', 'trialing', 'past_due'];

/**
 * Statuses that mean a PAID session's subscription has not settled into an
 * answer yet: `incomplete` is Stripe still confirming the first payment, and the
 * three above are a purchase whose webhook simply has not landed. Anything else
 * -- canceled, incomplete_expired, unpaid, paused -- is a purchase that did not
 * stick or a subscription the portal owns, and the buyer may open a new
 * checkout, exactly as the mirror rule allows.
 */
const RESOLVING_STRIPE_STATUSES = ['incomplete', ...SUBSCRIBED_STRIPE_STATUSES];

export const ALREADY_SUBSCRIBED = {
    error: 'You already have a subscription. Change or resume it with Manage subscription on your Account page.',
    code: 'already_subscribed',
} as const;

/** Layer 2: another request for this buyer is inside the critical section. */
export const CHECKOUT_IN_PROGRESS = {
    error: 'A checkout is already being prepared for you. Give it a moment and try again.',
    code: 'checkout_in_progress',
} as const;

/** Layer 4: this buyer has paid and we are waiting for Stripe to tell us. */
export const CHECKOUT_PENDING = {
    error: 'Your payment is being confirmed. Refresh your Account page in a moment.',
    code: 'checkout_pending',
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
 * its own open sessions -- so the expire step would have found none to expire
 * and both sessions would have been payable. A buyer asked to try again is
 * strictly better than a buyer charged twice.
 */
export type RunningLookup =
    { ok: true; rows: Array<{ status: string; current_period_end: string | null }> } | { ok: false; error: unknown };

export type CustomerLookup = { ok: true; customerId: string | null } | { ok: false; error: unknown };

/** The customer's subscriptions as STRIPE holds them, which is layer 3. */
export type StripeSubscriptionsLookup = { ok: true; statuses: string[] } | { ok: false; error: unknown };

/** One subscription's status as Stripe holds it; null when Stripe has no such id. */
export type StripeStatusLookup = { ok: true; status: string | null } | { ok: false; error: unknown };

/**
 * A Checkout Session as this flow reads it back. `url` is only present while the
 * session is open, and `subscriptionId` only once it has been paid.
 */
export interface CheckoutSessionState {
    status: 'open' | 'complete' | 'expired' | 'other';
    url: string | null;
    subscriptionId: string | null;
}

/** null `session` means Stripe has no session with that id (ours, long gone). */
export type SessionLookup = { ok: true; session: CheckoutSessionState | null } | { ok: false; error: unknown };

/** What the last attempt for this (user, mode) left behind, if any. */
export interface StoredAttempt {
    attemptId: string | null;
    priceId: string | null;
    sessionId: string | null;
}

/**
 * Taking the (user, mode) lock. `in_flight` is another request holding it --
 * not an error, and not a reason to open a second session.
 */
export type AttemptStart =
    | { ok: true; holder: string; stored: StoredAttempt }
    | { ok: false; reason: 'in_flight' }
    | { ok: false; reason: 'error'; error: unknown };

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
    /**
     * Layer 2. Takes the (user, mode) lock and answers with the session the last
     * attempt opened; `in_flight` when another request holds it.
     */
    beginAttempt: (userId: string, mode: StripeMode) => Promise<AttemptStart>;
    /** Releases the lock, recording the session this attempt opened. */
    finishAttempt: (
        userId: string,
        mode: StripeMode,
        holder: string,
        attempt: { attemptId: string; priceId: string; sessionId: string | null },
    ) => Promise<void>;
    /** Releases the lock having opened nothing, leaving the stored session alone. */
    releaseAttempt: (userId: string, mode: StripeMode, holder: string) => Promise<void>;
    /** A fresh attempt id (crypto.randomUUID in the handler). */
    newAttemptId: () => string;
    findCustomer: (userId: string, mode: StripeMode) => Promise<CustomerLookup>;
    createCustomer: (userId: string, email: string | null, mode: StripeMode) => Promise<string>;
    /** Layer 3: the customer's subscriptions as Stripe holds them right now. */
    stripeSubscriptionStatuses: (customerId: string, mode: StripeMode) => Promise<StripeSubscriptionsLookup>;
    /** Layer 4: the stored session, read back from Stripe. */
    fetchSession: (sessionId: string, mode: StripeMode) => Promise<SessionLookup>;
    /** The status of the subscription a paid session created. */
    subscriptionStatus: (subscriptionId: string, mode: StripeMode) => Promise<StripeStatusLookup>;
    /** Layer 5: expires every open Checkout Session this customer has. */
    expireOpenSessions: (customerId: string, mode: StripeMode) => Promise<number>;
    createSession: (
        params: CheckoutSessionParams,
        options: { idempotencyKey: string },
        mode: StripeMode,
    ) => Promise<{ id?: string | null; url?: string | null }>;
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

/** Could not read something we refuse to proceed without. */
const unavailable = (deps: CheckoutDeps, code: string, err: unknown): Response => {
    deps.logError(code, err);
    return deps.json({ error: 'Could not start checkout. Please try again.', code: 'checkout_unavailable' }, 502);
};

/**
 * Everything from taking the (user, mode) lock to recording the session, which
 * is the part that must not run twice for one buyer at once. Split out so the
 * lock is released on every path out of it, including a throw, without the
 * release being repeated at each `return`.
 */
const openSessionUnderLock = async (
    req: Request,
    deps: CheckoutDeps,
    caller: CheckoutCaller,
    mode: StripeMode,
    priceId: string,
    holder: string,
    stored: StoredAttempt,
): Promise<{ response: Response; recorded: boolean }> => {
    /** An answer that opened no session for the lock to remember. */
    const unrecorded = (response: Response) => ({ response, recorded: false });

    // The customer FIRST, because everything below is scoped to it: the
    // subscriptions Stripe holds for it, the session the last attempt opened,
    // and the open sessions to expire. A buyer upgrading for the first time has
    // no customer yet. Inside the lock, so two requests cannot create two Stripe
    // customers for one user -- the loser's customer would keep its own open
    // sessions, which no expire of ours would ever find again.
    const found = await deps.findCustomer(caller.userId, mode);
    if (!found.ok) {
        deps.logError('customer_lookup_failed', found.error);
        return unrecorded(deps.json({ error: 'Could not start checkout. Please try again.' }, 502));
    }
    const customerId = found.customerId ?? (await deps.createCustomer(caller.userId, await caller.email(), mode));

    // Layer 3. The mirror above answers for a purchase the webhook has already
    // applied; this answers for one it has not. A Checkout Session that has been
    // PAID has already created the subscription in Stripe, and until the webhook
    // lands there is nothing in our tables to show it and no open session left
    // to expire -- so without this read, a second submit sails past every other
    // layer and is paid too.
    const remote = await deps.stripeSubscriptionStatuses(customerId, mode);
    if (!remote.ok) {
        return unrecorded(unavailable(deps, 'stripe_subscription_list_failed', remote.error));
    }
    const subscribed = remote.statuses.find((status) => SUBSCRIBED_STRIPE_STATUSES.includes(status));
    if (subscribed) {
        deps.log(`checkout: ${caller.userId} already holds a ${subscribed} subscription in Stripe (${mode})`);
        return unrecorded(deps.json(ALREADY_SUBSCRIBED, 409));
    }

    // Layer 4. The session the last attempt opened is the one thing a
    // double-submit and a reload have in common, and handing it back is what
    // makes "one payable session" compatible with "the buyer gets a page".
    if (stored.sessionId) {
        const read = await deps.fetchSession(stored.sessionId, mode);
        if (!read.ok) {
            return unrecorded(unavailable(deps, 'checkout_session_read_failed', read.error));
        }
        const session = read.session;
        if (session?.status === 'open' && session.url && stored.priceId === priceId) {
            deps.log(`checkout: reusing open session ${stored.sessionId} for ${caller.userId}`);
            return unrecorded(deps.json({ url: session.url }));
        }
        if (session?.status === 'complete' && session.subscriptionId) {
            // Paid. Whether that purchase is still resolving decides between
            // "wait" and "you may buy again": a subscription Stripe has ended
            // (the payment ultimately failed, or it was cancelled) must not
            // block a new checkout for good.
            const status = await deps.subscriptionStatus(session.subscriptionId, mode);
            if (!status.ok) {
                return unrecorded(unavailable(deps, 'stripe_subscription_read_failed', status.error));
            }
            if (status.status && RESOLVING_STRIPE_STATUSES.includes(status.status)) {
                deps.log(
                    `checkout: ${caller.userId} has paid session ${stored.sessionId} ` +
                        `(subscription ${session.subscriptionId} is ${status.status}); asking them to wait`,
                );
                return unrecorded(deps.json(CHECKOUT_PENDING, 409));
            }
        }
    }

    // Layer 5. Expiring is what makes "only one session can be paid" true, so it
    // must not be possible for it to fail quietly and let the purchase through
    // anyway: a buyer asked to retry is strictly better than a buyer charged
    // twice. Hence the refusal rather than a logged warning -- we will not mint a
    // session we could not de-duplicate. Nothing is kept: the session the buyer
    // might have wanted back was handed to them above, and this attempt's key is
    // one no previous attempt could have used.
    try {
        const expired = await deps.expireOpenSessions(customerId, mode);
        if (expired > 0) {
            deps.log(`checkout: expired ${expired} open session(s) for ${customerId} before opening another`);
        }
    } catch (err) {
        deps.logError('expire_open_sessions_failed', err);
        return unrecorded(
            deps.json({ error: 'Could not start checkout. Please try again.', code: 'checkout_unavailable' }, 502),
        );
    }

    const attemptId = deps.newAttemptId();
    const idempotencyKey = checkoutIdempotencyKey(caller.userId, mode, priceId, attemptId);
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
            // `checkout_key` is provenance only now: nothing reads it back (the
            // expire step no longer spares a session by it), but a session in
            // the Stripe dashboard saying which attempt opened it is what makes
            // a double-charge report answerable afterwards.
            metadata: { user_id: caller.userId, checkout_key: idempotencyKey },
            success_url: `${origin}/settings?checkout=success`,
            cancel_url: `${origin}/settings?checkout=cancelled`,
            allow_promotion_codes: true,
        },
        { idempotencyKey },
        mode,
    );

    if (!session.url) {
        return unrecorded(deps.json({ error: 'Stripe did not return a checkout URL' }, 502));
    }

    // Recorded before the lock goes, so the next request sees this session
    // rather than opening another. A failure here is not a reason to refuse a
    // session the buyer can already pay: the next attempt expires it and opens
    // its own, which is one payable session either way.
    try {
        await deps.finishAttempt(caller.userId, mode, holder, {
            attemptId,
            priceId,
            sessionId: session.id ?? null,
        });
        return { response: deps.json({ url: session.url }), recorded: true };
    } catch (err) {
        deps.logError('checkout_attempt_record_failed', err);
        return unrecorded(deps.json({ url: session.url }));
    }
};

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
        // Layer 1. One subscription per buyer per account: switching plans or
        // resuming a cancelled one is the billing portal's job, and a second
        // Checkout here would bill both (see holdsRunningSubscription). This
        // catches the slow case -- a subscriber coming back for a second plan
        // days later -- without taking the lock or calling Stripe at all.
        const running = await deps.runningSubscriptions(caller.userId, mode);
        if (!running.ok) {
            deps.logError('subscription_check_failed', running.error);
            return deps.json({ error: 'Could not check your current plan. Please try again.' }, 502);
        }
        if (deps.holdsRunningSubscription(running.rows, deps.now())) {
            return deps.json(ALREADY_SUBSCRIBED, 409);
        }

        // Layer 2. Two isolates serving one buyer share nothing but the
        // database, so this is where "one attempt at a time" is decided. The
        // loser is refused outright rather than queued: it is a double-click or
        // a second tab, and the request that holds the lock is about to hand
        // back a URL that the loser's next try will be given too (layer 4).
        const start = await deps.beginAttempt(caller.userId, mode);
        if (!start.ok) {
            if (start.reason === 'error') {
                return unavailable(deps, 'checkout_attempt_lock_failed', start.error);
            }
            deps.log(`checkout: ${caller.userId} already has an attempt in flight (${mode})`);
            return deps.json(CHECKOUT_IN_PROGRESS, 409);
        }

        let recorded = false;
        try {
            const outcome = await openSessionUnderLock(req, deps, caller, mode, priceId, start.holder, start.stored);
            recorded = outcome.recorded;
            return outcome.response;
        } finally {
            // Every path that did not record a session gives the lock back, so
            // the buyer's next try is not held off for the whole lease: a
            // refusal, a failed read, a throw. finishAttempt already released
            // it on the path that did.
            if (!recorded) {
                try {
                    await deps.releaseAttempt(caller.userId, mode, start.holder);
                } catch (err) {
                    // The lease expires on its own, so this costs the buyer a
                    // wait rather than the purchase.
                    deps.logError('checkout_attempt_release_failed', err);
                }
            }
        }
    } catch (err) {
        deps.logError('checkout_failed', err);
        return deps.json({ error: err instanceof Error ? err.message : 'Checkout failed' }, 502);
    }
};
