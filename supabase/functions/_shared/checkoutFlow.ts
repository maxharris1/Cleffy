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
 *  4b. the attempt that staged a key and recorded no session -- an isolate that
 *     died around the create. Its key is replayed rather than a new one minted,
 *     so Stripe answers with the session it opened (if it opened one) instead of
 *     a second one beside it;
 *  5. everything else open is expired before a new session is created, and the
 *     new session's idempotency key carries a FRESH attempt id, so Stripe never
 *     replays the URL of a session we have since expired. The key is written to
 *     `checkout_attempts` BEFORE the create, under our own lease, which is both
 *     what makes 4b possible and what stops an attempt whose lease has been
 *     taken over from creating anything.
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
 * The wall-clock ceiling an Edge Function invocation can reach before the
 * platform kills it. Here only to be compared against the lease below, which is
 * the comparison that was wrong.
 */
export const EDGE_FUNCTION_WALL_CLOCK_MS = 150_000;

/**
 * How long a checkout attempt may hold the (user, mode) lock before another
 * request may take it over, in the two forms that have to agree: the Postgres
 * interval the comparison is actually made in (begin_checkout_attempt, migration
 * 20261012120103) and the milliseconds a test can compare against the ceiling
 * above.
 *
 * Two minutes was SHORTER than the invocation that holds it may legally run
 * (QA round 4 review of #56): a buyer's first request stalled inside
 * `checkout.sessions.create` -- Stripe slow, or retrying behind the SDK -- is
 * still running at 2:01, by which point its lease is stale and a second request
 * takes the lock from it. The second request then lists, finds no open session
 * yet (the first one's create has not returned), expires nothing, and opens a
 * session of its own. Both are payable, which is the double charge the lock
 * exists to stop, reached through the lock rather than around it.
 *
 * Five minutes clears the ceiling with room for the clock skew between the
 * isolate and the database, and is still inside the patience of someone whose
 * isolate died mid-checkout -- they wait out the remainder of the lease rather
 * than losing the purchase.
 *
 * It is deliberately no longer the only thing standing between a takeover and a
 * second session: a plan whose ceiling is higher than this would make the lease
 * too short again, so `stage_checkout_attempt` persists the idempotency key
 * under this lease before the create, and refuses to do so once the lease is
 * someone else's (see `stageAttempt`). A takeover therefore either replays the
 * dead attempt's key -- one session -- or stops the dead attempt from creating
 * anything at all.
 */
export const CHECKOUT_ATTEMPT_STALE_AFTER_MS = 5 * 60_000;
export const CHECKOUT_ATTEMPT_STALE_AFTER = '5 minutes';

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
 *
 * The id is written to `checkout_attempts` before it is handed to Stripe, so
 * "cannot be recomputed" does not also mean "is lost when the isolate dies":
 * the attempt that follows a death reads it back and replays it (layer 4b).
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

/**
 * What the last attempt for this (user, mode) left behind, if any.
 *
 * An `attemptId` with NO `sessionId` is the recoverable state: that attempt
 * persisted the key it was about to create with and then did not get as far as
 * recording a session. See the recovery step in `openSessionUnderLock`.
 */
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
    /**
     * Persists the attempt id this request is about to key the Stripe create on,
     * WITHOUT giving the lock up. Answers false when the lease is no longer
     * ours, which is the one case in which no session may be created.
     *
     * Why it exists (QA round 4 review of #56): the key used to be minted in
     * memory a line above the create, so an isolate that died between the two
     * left a session Stripe had made and we had never heard of, and the next
     * attempt -- a fresh key -- asked Stripe for another one. Persisted first,
     * the next attempt replays the SAME key, and Stripe answers with the session
     * the dead one opened instead of a second one.
     */
    stageAttempt: (
        userId: string,
        mode: StripeMode,
        holder: string,
        attempt: { attemptId: string; priceId: string },
    ) => Promise<boolean>;
    /**
     * Releases the lock, recording the session this attempt opened. False when
     * the lease had already been taken over, so nothing was recorded -- see the
     * call site for why that is not a session to hand out.
     */
    finishAttempt: (
        userId: string,
        mode: StripeMode,
        holder: string,
        attempt: { attemptId: string; priceId: string; sessionId: string | null },
    ) => Promise<boolean>;
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

    // Layer 4b: the attempt that staged a key and never recorded a session.
    //
    // An isolate killed between `stage_checkout_attempt` and
    // `finish_checkout_attempt` -- the window that covers the Stripe create
    // itself, which is the slowest call in this function -- leaves exactly that
    // row: an attempt id, the price it was for, and no session. Stripe may or
    // may not have made the session; from here the two are indistinguishable.
    //
    // Replaying that attempt's key answers both at once. Stripe keeps a key's
    // original response for 24 hours, so a create that landed comes back as the
    // SAME session, and one that never reached Stripe is made now. Either way
    // the buyer ends up with one payable session rather than a second one beside
    // an orphan nobody knew about.
    //
    // The expiry below is skipped on this path, and must be: the session the
    // replay is about to hand back is open, and expiring it first would make
    // Stripe replay the URL of a session we had just killed -- a dead Checkout
    // page, which is the exact failure the per-attempt key replaced the old
    // time-bucket key to avoid. Nothing else can be open for it to miss: the
    // attempt that staged this key ran the expiry before staging, and opening a
    // session needs this lock.
    const resumed =
        stored.attemptId !== null && stored.sessionId === null && stored.priceId === priceId ? stored.attemptId : null;

    // Layer 5, for every attempt that is NOT a replay. Expiring is what makes
    // "only one session can be paid" true, so it must not be possible for it to
    // fail quietly and let the purchase through anyway: a buyer asked to retry is
    // strictly better than a buyer charged twice. Hence the refusal rather than a
    // logged warning -- we will not mint a session we could not de-duplicate.
    // Nothing is kept: the session the buyer might have wanted back was handed to
    // them above, and the key minted below is one no previous attempt could have
    // used.
    if (resumed === null) {
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
    }

    const attemptId = resumed ?? deps.newAttemptId();
    const idempotencyKey = checkoutIdempotencyKey(caller.userId, mode, priceId, attemptId);

    // The key goes to the DATABASE before it goes to Stripe, which is what makes
    // the paragraph above possible at all -- a key only this isolate's memory
    // ever held is a key no later attempt can replay.
    //
    // It is also the second guard on a lease takeover, and the one that does not
    // depend on arithmetic about how long an invocation may run: the statement is
    // scoped to our holder, so an attempt whose lease has been taken over cannot
    // stage, and therefore cannot create. A takeover is then either a replay of
    // this attempt's key (one session) or a request that refuses to open one.
    //
    // A failure to persist it is a refusal, for the same reason the failed expiry
    // above is: the alternative is a session whose key nothing can recover.
    let staged: boolean;
    try {
        staged = await deps.stageAttempt(caller.userId, mode, holder, { attemptId, priceId });
    } catch (err) {
        return unrecorded(unavailable(deps, 'checkout_attempt_stage_failed', err));
    }
    if (!staged) {
        deps.log(
            `checkout: the attempt lease for ${caller.userId} was taken over before a session was opened (${mode})`,
        );
        return unrecorded(deps.json(CHECKOUT_IN_PROGRESS, 409));
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
        const recorded = await deps.finishAttempt(caller.userId, mode, holder, {
            attemptId,
            priceId,
            sessionId: session.id ?? null,
        });
        if (!recorded) {
            // The lease was taken over while this create was in flight, which
            // means another request has run the expiry since -- so the URL just
            // returned may already be dead, and the live session is the other
            // request's. Handing this one out would send the buyer to a Checkout
            // page that refuses them; asking them to try again hands them the
            // live session on the next request (layer 4).
            deps.log(
                `checkout: the attempt lease for ${caller.userId} was taken over before ` +
                    `session ${session.id ?? 'unknown'} could be recorded (${mode})`,
            );
            return unrecorded(deps.json(CHECKOUT_IN_PROGRESS, 409));
        }
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
