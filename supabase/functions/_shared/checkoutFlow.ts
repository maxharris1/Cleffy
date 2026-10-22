import type * as BillingTerms from './billingTerms.ts';
import type { LEGAL_VERSIONS } from './legalVersions.ts';
import type * as ReadCapped from './readCappedJson.ts';
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
 *     a second one beside it, and the replayed answer is read back before the
 *     buyer is sent to it, because what Stripe replays is the response it saved
 *     and not the session as it stands today. An isolate that DIED is the only
 *     attempt that leaves a key here: a create we were alive to watch fail
 *     clears it instead, since Stripe replays a saved failure exactly as
 *     readily as a saved session (`discardAttempt`);
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
 * SHA-256 (hex) of everything a replay of an attempt's key has to reproduce:
 * the session parameters exactly as they are sent to Stripe, and the consent
 * wording the buyer ticked.
 *
 * Stripe compares a replayed key's parameters with the first request's and
 * refuses any difference (Codex finding 1 on #62: a fresh consent id in the
 * metadata made every replay a refusal). Staging this beside the key lets the
 * attempt that follows a dead isolate tell "the same request again" -- replay
 * the key -- from "a different request" -- mint a fresh key and expire the
 * orphan -- before Stripe has to. Web Crypto, which Deno and Node both have, so
 * the module stays import-free.
 */
export const checkoutParamsFingerprint = async (
    params: CheckoutSessionParams,
    consentText: string,
): Promise<string> => {
    const bytes = new TextEncoder().encode(JSON.stringify({ params, consentText }));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

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

/**
 * The buyer's account is being deleted (20261022110600_account_deletion_barrier.sql):
 * the database refuses the attempt lease, so no session can be opened that the
 * deletion's billing sweeps would miss.
 */
export const CHECKOUT_DELETION_PENDING = {
    error: 'This account is being deleted, so a new purchase cannot start.',
    code: 'account_deletion_pending',
} as const;

/**
 * Whether the buyer's account is being deleted could not be checked
 * (deletionPending.ts's DELETION_CHECK_UNAVAILABLE): refused as a 503, a retry
 * prompt, since nothing was started (decision 60(b)).
 */
export const CHECKOUT_DELETION_CHECK_UNAVAILABLE = {
    error: 'We could not check your account just now, so checkout did not start. Please try again in a minute.',
    code: 'deletion_check_unavailable',
    retryAfterSec: 30,
} as const;

/** Layer 4: this buyer has paid and we are waiting for Stripe to tell us. */
/**
 * The auto-renewal checkbox was not ticked, or the request did not say so.
 * The dialog cannot send a checkout without it; this is the server refusing to
 * take that on trust (CA BPC §17602(a)(2) wants affirmative consent).
 */
export const CONSENT_REQUIRED = {
    error: 'Please confirm the automatic-renewal terms before you continue to payment.',
    code: 'consent_required',
} as const;

/**
 * The wording the buyer ticked is not the wording this server would charge
 * under -- almost always a browser running a bundle from before a price or
 * wording change. Refused rather than recorded, because a consent record whose
 * text the buyer never saw proves nothing.
 */
export const CONSENT_OUTDATED = {
    error: 'The subscription terms have changed since this page loaded. Reload the page to see the current terms.',
    code: 'consent_outdated',
} as const;

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
    /**
     * The consent the staged attempt recorded, and the fingerprint of the
     * session parameters it sent (`checkoutParamsFingerprint`). A replay reuses
     * the first and has to reproduce the second, because Stripe refuses a key
     * replayed with different parameters (migration 20261020160100). Null on a
     * row staged before that migration, which is then not replayed.
     */
    consentId: string | null;
    paramsHash: string | null;
}

/** What `stageAttempt` persists before the create: everything a replay needs. */
export interface StagedAttempt {
    attemptId: string;
    priceId: string;
    consentId: string;
    paramsHash: string;
}

/**
 * Taking the (user, mode) lock. `in_flight` is another request holding it --
 * not an error, and not a reason to open a second session.
 */
export type AttemptStart =
    | { ok: true; holder: string; stored: StoredAttempt }
    | { ok: false; reason: 'in_flight' }
    /** The lease was refused because the account is being deleted. */
    | { ok: false; reason: 'deletion_pending' }
    /** Whether the account is being deleted could not be checked; nothing was taken. */
    | { ok: false; reason: 'deletion_check_failed'; error: unknown }
    | { ok: false; reason: 'error'; error: unknown };

/**
 * Exactly the Stripe `checkout.sessions.create` params, built here so the shape
 * of the purchase is covered by tests and index.ts has no decisions left in it.
 */
export interface CheckoutSessionParams {
    mode: 'subscription';
    customer: string;
    line_items: Array<{ price: string; quantity: number }>;
    /** Which of the price's `currency_options` to charge in -- the one the consent named. */
    currency: BillingTerms.Currency;
    /** Stripe Tax: VAT / sales tax from the billing address, per each price's tax_behavior. */
    automatic_tax: { enabled: true };
    billing_address_collection: 'required';
    /** Required beside automatic_tax for an existing customer: Checkout saves the address it collects. */
    customer_update: { address: 'auto'; name: 'auto' };
    /** The renewal terms again, directly above Stripe's Pay button. */
    custom_text: { submit: { message: string } };
    client_reference_id: string;
    subscription_data: { metadata: Record<string, string> };
    metadata: Record<string, string>;
    success_url: string;
    cancel_url: string;
    allow_promotion_codes: boolean;
}

/**
 * What the buyer consented to, as this server re-derives it. `key` is what the
 * attempt lock matches on and what the idempotency key is built from: the price
 * AND the currency, so a buyer who goes back and changes country is never
 * handed the open session priced in the other currency.
 */
export interface Purchase {
    priceId: string;
    key: string;
    terms: BillingTerms.PurchaseTerms;
    consentText: string;
    country: string;
}

/** One row of `checkout_consents`, as the flow hands it to be stored. */
export interface ConsentRecord {
    userId: string;
    mode: StripeMode;
    stripeCustomerId: string;
    priceId: string;
    planSlot: BillingTerms.PlanSlot;
    currency: BillingTerms.Currency;
    amountMinor: number;
    renewalInterval: BillingTerms.RenewalInterval;
    taxInclusive: boolean;
    wording: string;
    wordingVersion: string;
    termsVersion: string;
    refundPolicyVersion: string;
    declaredCountry: string;
    ip: string | null;
    userAgent: string | null;
}

/** The parts of billingTerms.ts the flow uses -- injected, so this file stays import-free. */
export type CheckoutTermsDeps = Pick<
    typeof BillingTerms,
    | 'normalizeCountry'
    | 'currencyForCountry'
    | 'purchaseTermsFor'
    | 'autoRenewalConsentText'
    | 'checkoutSubmitMessage'
    | 'CONSENT_WORDING_VERSION'
>;

/** `price_…|eur` -- see Purchase.key. */
export const purchaseKey = (priceId: string, currency: BillingTerms.Currency): string => `${priceId}|${currency}`;

export interface CheckoutDeps {
    /** _shared/legalVersions.ts: the policy versions a consent records. */
    legalVersions: Pick<typeof LEGAL_VERSIONS, 'terms' | 'refunds'>;
    json: (body: unknown, status?: number) => Response;
    /**
     * _shared/readCappedJson.ts's readCappedJson, passed in because this file
     * takes no runtime imports: the body read with a streamed cap.
     */
    readJson: typeof ReadCapped.readCappedJson;
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
    /** Which plan a (resolved) price id names, so the wording can be rebuilt for it. */
    slotForPrice: (priceId: string) => BillingTerms.PlanSlot | null;
    terms: CheckoutTermsDeps;
    /**
     * Stores the buyer's consent and answers with its id. Called before the
     * buyer is handed any Checkout URL; a failure refuses the checkout, because
     * a purchase whose consent we cannot prove is one we must not take.
     */
    recordConsent: (record: ConsentRecord) => Promise<string>;
    /** Attaches the Checkout Session to a stored consent. Best effort: the session's metadata carries the id too. */
    linkConsent: (consentId: string, sessionId: string) => Promise<void>;
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
    stageAttempt: (userId: string, mode: StripeMode, holder: string, attempt: StagedAttempt) => Promise<boolean>;
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
    /**
     * Releases the lock AND forgets the key this attempt staged, so no later
     * attempt replays it. The same statement as `finishAttempt` with nothing to
     * remember -- an attempt that opened no session and left no key behind --
     * and scoped to our own lease for the same reason.
     *
     * Why a create that FAILED has to be forgotten (QA round 4, Codex round 2 of
     * #56): Stripe saves the response it answers an idempotency key with
     * whether that response succeeded or failed, and replays it for 24 hours. So
     * a create that came back 500 poisons its own key, and layer 4b -- which
     * reads "an attempt id with no session" as "replay this" -- handed that key
     * straight back to Stripe, which answered with the same 500. Every retry,
     * for a day: the buyer could not buy that plan at all.
     *
     * Forgetting it sends the next request down layer 5 instead, which is the
     * path that is safe when we cannot tell whether Stripe made a session: it
     * expires every open session this customer has -- the orphan of a create
     * whose answer we lost included -- before it mints a key of its own.
     */
    discardAttempt: (userId: string, mode: StripeMode, holder: string) => Promise<void>;
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
    /**
     * Expires ONE session by id, for the session this attempt opened and then
     * lost the lease on -- the only session we know nobody will ever be sent to.
     * By id rather than by customer, because the request that took the lease
     * over has a session of its own that it IS handing out.
     */
    expireSession: (sessionId: string, mode: StripeMode) => Promise<void>;
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
    purchase: Purchase,
    holder: string,
    stored: StoredAttempt,
): Promise<{ response: Response; recorded: boolean }> => {
    /** An answer that opened no session for the lock to remember. */
    const unrecorded = (response: Response) => ({ response, recorded: false });
    // From here on the lock and the idempotency key speak in purchase keys
    // (price AND currency); only the line item wants the bare Stripe price.
    const priceId = purchase.key;

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

    /**
     * Stores the consent this request carries, answering with its id -- or null,
     * which every caller turns into a refusal: no buyer is handed a Checkout URL
     * we hold no consent record for. Called only once every layer that might
     * refuse the buyer outright has passed, so a refused attempt leaves no
     * consent behind for a purchase that was never offered.
     */
    const recordConsent = async (): Promise<string | null> => {
        try {
            return await deps.recordConsent({
                userId: caller.userId,
                mode,
                stripeCustomerId: customerId,
                priceId: purchase.priceId,
                planSlot: purchase.terms.slot,
                currency: purchase.terms.currency,
                amountMinor: purchase.terms.amountMinor,
                renewalInterval: purchase.terms.interval,
                taxInclusive: purchase.terms.taxInclusive,
                wording: purchase.consentText,
                wordingVersion: deps.terms.CONSENT_WORDING_VERSION,
                termsVersion: deps.legalVersions.terms,
                refundPolicyVersion: deps.legalVersions.refunds,
                declaredCountry: purchase.country,
                ip: deps.clientKey(req) === 'unknown' ? null : deps.clientKey(req),
                userAgent: req.headers.get('User-Agent')?.slice(0, 512) ?? null,
            });
        } catch (err) {
            deps.logError('consent_record_failed', err);
            return null;
        }
    };
    const consentUnavailable = () =>
        unrecorded(
            deps.json({ error: 'Could not start checkout. Please try again.', code: 'checkout_unavailable' }, 502),
        );
    const linkConsent = async (consentId: string, sessionId: string): Promise<void> => {
        try {
            await deps.linkConsent(consentId, sessionId);
        } catch (err) {
            // The session's metadata names the consent too, and the webhook
            // links them on completion, so this costs nothing but a log line.
            deps.logError('consent_link_failed', err);
        }
    };

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
            // The buyer ticked the box again for the same plan and currency, so
            // this is a consent of its own -- recorded, and tied to the session
            // they are being sent back to.
            const consentId = await recordConsent();
            if (!consentId) {
                return consentUnavailable();
            }
            await linkConsent(consentId, stored.sessionId);
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
    //
    // A replay is only a replay if it sends Stripe EXACTLY what the dead attempt
    // sent: Stripe refuses a key reused with different parameters (Codex finding
    // 1 on #62). So the replay reuses the consent the dead attempt recorded --
    // its id is in the session metadata -- rather than recording another, and
    // rebuilds the parameters from it and the stored attempt id. Only if they
    // fingerprint the same as what was staged is the key replayed; a request
    // that differs in anything (the origin it came from, a submit message a
    // deploy reworded) is a different request, and goes down layer 5 with a
    // fresh key, which also expires whatever the dead attempt left open.
    const origin = deps.appOrigin(req);
    const paramsFor = (consentId: string, attemptId: string): CheckoutSessionParams => {
        const idempotencyKey = checkoutIdempotencyKey(caller.userId, mode, priceId, attemptId);
        return {
            mode: 'subscription',
            customer: customerId,
            line_items: [{ price: purchase.priceId, quantity: 1 }],
            // The currency the consent named; the price carries a
            // `currency_options` entry for each, with its own tax_behavior.
            currency: purchase.terms.currency,
            // Stripe Tax works out VAT / sales tax from the billing address,
            // which is why the address is required rather than optional.
            automatic_tax: { enabled: true },
            billing_address_collection: 'required',
            customer_update: { address: 'auto', name: 'auto' },
            custom_text: { submit: { message: deps.terms.checkoutSubmitMessage(purchase.terms) } },
            // Both are belt-and-braces for the webhook's user resolution:
            // either survives even if the billing_customers row is somehow
            // missing.
            client_reference_id: caller.userId,
            subscription_data: { metadata: { user_id: caller.userId, consent_id: consentId } },
            // `checkout_key` is provenance only now: nothing reads it back
            // (the expire step no longer spares a session by it), but a
            // session in the Stripe dashboard saying which attempt opened it
            // is what makes a double-charge report answerable afterwards.
            // `consent_id` is the checkout_consents row this purchase rests on.
            metadata: { user_id: caller.userId, checkout_key: idempotencyKey, consent_id: consentId },
            success_url: `${origin}/settings?checkout=success`,
            cancel_url: `${origin}/settings?checkout=cancelled`,
            allow_promotion_codes: true,
        };
    };

    let resumed: { attemptId: string; consentId: string } | null = null;
    if (stored.attemptId !== null && stored.sessionId === null && stored.priceId === priceId) {
        const replay =
            stored.consentId && stored.paramsHash
                ? await checkoutParamsFingerprint(paramsFor(stored.consentId, stored.attemptId), purchase.consentText)
                : null;
        if (replay !== null && replay === stored.paramsHash && stored.consentId) {
            resumed = { attemptId: stored.attemptId, consentId: stored.consentId };
        } else {
            deps.log(
                `checkout: the staged key for ${caller.userId} was sent with other parameters than this ` +
                    `request's; opening a fresh session instead of replaying it (${mode})`,
            );
        }
    }

    // Layer 5, for every attempt that is NOT a replay. Expiring is what makes
    // "only one session can be paid" true, so it must not be possible for it to
    // fail quietly and let the purchase through anyway: a buyer asked to retry is
    // strictly better than a buyer charged twice. Hence the refusal rather than a
    // logged warning -- we will not mint a session we could not de-duplicate.
    // Nothing is kept: the session the buyer might have wanted back was handed to
    // them above, and the key minted below is one no previous attempt could have
    // used.
    //
    // The consent is recorded before anything is expired or staged, so a refusal
    // here has nothing to undo. A replay records none: the consent the dead
    // attempt recorded, for this same plan and currency, is the one the replayed
    // session names.
    const consentId = resumed ? resumed.consentId : await recordConsent();
    if (!consentId) {
        return consentUnavailable();
    }

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

    const attemptId = resumed?.attemptId ?? deps.newAttemptId();
    const idempotencyKey = checkoutIdempotencyKey(caller.userId, mode, priceId, attemptId);
    const params = paramsFor(consentId, attemptId);
    const paramsHash = await checkoutParamsFingerprint(params, purchase.consentText);

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
        staged = await deps.stageAttempt(caller.userId, mode, holder, { attemptId, priceId, consentId, paramsHash });
    } catch (err) {
        return unrecorded(unavailable(deps, 'checkout_attempt_stage_failed', err));
    }
    if (!staged) {
        deps.log(
            `checkout: the attempt lease for ${caller.userId} was taken over before a session was opened (${mode})`,
        );
        return unrecorded(deps.json(CHECKOUT_IN_PROGRESS, 409));
    }

    /**
     * Give up the staged key, best effort, on every way out of the create that
     * leaves us without a session the buyer can pay.
     *
     * Best effort because there is nothing better available: a discard that
     * fails leaves the key staged, which is the behaviour this fix replaces, and
     * refusing the buyer a retry would not unpoison it. It is logged, and the
     * key stops being replayable as soon as any attempt stages one of its own.
     */
    const discardStagedKey = async (): Promise<void> => {
        try {
            await deps.discardAttempt(caller.userId, mode, holder);
        } catch (err) {
            deps.logError('checkout_attempt_discard_failed', err);
        }
    };

    let session: Awaited<ReturnType<CheckoutDeps['createSession']>>;
    try {
        session = await deps.createSession(params, { idempotencyKey }, mode);
    } catch (err) {
        // A create we watched fail is a create whose key must never be used
        // again: Stripe has saved that failure against it and will replay it for
        // 24 hours, so staging it was for an attempt that cannot be resumed.
        //
        // This does not take layer 4b's job away, because an isolate that is
        // KILLED around the create never reaches this line -- it runs no catch
        // block, answers the buyer nothing, and leaves its lease to go stale.
        // The staged key survives for the attempt that takes the lease over,
        // which is the one case where replaying it is right. What is cleared
        // here is the narrower one: a failure we were still alive to see.
        //
        // The orphan is handled by clearing it rather than in spite of it. If
        // the failure was the ANSWER going missing -- a timeout, a reset -- then
        // Stripe may hold a session we never saw the id of; the next request,
        // with nothing to replay, runs layer 5 and expires every open session
        // this customer has, that one included, before opening its own.
        await discardStagedKey();
        throw err;
    }

    // Stripe answered, but with nothing payable. The key is spent on that answer
    // exactly as it would be on a failure, so it goes the same way: kept, it
    // would be replayed into the same URL-less answer for a day.
    if (!session.url) {
        await discardStagedKey();
        return unrecorded(deps.json({ error: 'Stripe did not return a checkout URL' }, 502));
    }
    if (session.id) {
        await linkConsent(consentId, session.id);
    }

    // What a REPLAY answers with is the response Stripe saved at the time, not
    // the session as it stands now, so a 24-hour-old key can hand back the URL
    // of a session that has since been paid or expired. Reading it back is the
    // difference between "here is your Checkout page" and a page that refuses
    // the buyer with no way forward: the key is discarded instead, and their
    // next request is a clean attempt through all five layers -- which answers a
    // paid session with `already_subscribed` or `checkout_pending` (layers 3 and
    // 4) and an expired one with a session of its own.
    if (resumed !== null && session.id) {
        const replayed = await deps.fetchSession(session.id, mode);
        if (!replayed.ok) {
            return unrecorded(unavailable(deps, 'checkout_session_read_failed', replayed.error));
        }
        // A session Stripe has no record of at all (`null`) goes the same way as
        // a dead one: whatever that saved URL is, it is not a page the buyer can
        // pay on.
        const status = replayed.session?.status ?? 'missing';
        if (status !== 'open') {
            deps.log(
                `checkout: the replayed key for ${caller.userId} answered with ` +
                    `${status} session ${session.id} (${mode})`,
            );
            await discardStagedKey();
            return unrecorded(
                deps.json({ error: 'Could not start checkout. Please try again.', code: 'checkout_unavailable' }, 502),
            );
        }
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
            // And this session is now an orphan nobody will ever be sent to --
            // the request that took the lease over ran its expiry BEFORE this
            // create returned, so it did not see this one. Left open it is a
            // second payable session beside the live one, which is the double
            // charge the lock exists to stop. Expired by id, so the session the
            // other request is handing out is untouched; a failure here is
            // logged rather than returned, because the buyer is already being
            // asked to retry and the next attempt's layer 5 will find it.
            if (session.id) {
                try {
                    await deps.expireSession(session.id, mode);
                    deps.log(`checkout: expired orphan session ${session.id} for ${caller.userId} (${mode})`);
                } catch (err) {
                    deps.logError('orphan_session_expire_failed', err);
                }
            }
            return unrecorded(deps.json(CHECKOUT_IN_PROGRESS, 409));
        }
        return { response: deps.json({ url: session.url }), recorded: true };
    } catch (err) {
        deps.logError('checkout_attempt_record_failed', err);
        return unrecorded(deps.json({ url: session.url }));
    }
};

/** What the pricing dialog posts. */
interface CheckoutRequestBody {
    priceId?: string;
    consent?: { accepted?: boolean; country?: string; text?: string };
}

/**
 * Free signup stays card-free -- the free tier is simply "no subscriptions row"
 * -- so nothing here runs until a teacher chooses to pay.
 */
/**
 * The cap on a request body, counted as it streams (Content-Length is not
 * trusted): readCappedJson.ts's CONTROL_BODY_MAX_BYTES. Past it the answer
 * is 413 with PAYLOAD_TOO_LARGE, before anything is parsed.
 */
export const BODY_MAX_BYTES = 16 * 1024;
const PAYLOAD_TOO_LARGE = { error: 'Request body too large', code: 'payload_too_large' } as const;

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

    const read = await deps.readJson(req, BODY_MAX_BYTES);
    if (!read.ok) {
        return read.status === 413 ? deps.json(PAYLOAD_TOO_LARGE, 413) : deps.json({ error: 'Invalid JSON body' }, 400);
    }
    if (!read.value || typeof read.value !== 'object' || Array.isArray(read.value)) {
        return deps.json({ error: 'Invalid JSON body' }, 400);
    }
    const body = read.value as CheckoutRequestBody;

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
    const slot = priceId ? deps.slotForPrice(priceId) : null;
    if (!priceId || !slot) {
        return deps.json({ error: 'Unknown price', code: 'unknown_price' }, 400);
    }

    // The consent, re-derived rather than trusted: the currency follows from the
    // country the buyer chose, the wording from the plan and that currency, and
    // what the dialog sent has to match it exactly (see billingTerms.ts).
    if (body.consent?.accepted !== true) {
        return deps.json(CONSENT_REQUIRED, 400);
    }
    const country = deps.terms.normalizeCountry(body.consent.country);
    if (!country) {
        return deps.json(
            { error: 'Choose your country to see the price you will pay.', code: 'country_required' },
            400,
        );
    }
    const currency = deps.terms.currencyForCountry(country);
    const terms = deps.terms.purchaseTermsFor(slot, currency);
    const consentText = deps.terms.autoRenewalConsentText(terms);
    if (body.consent.text !== consentText) {
        return deps.json(CONSENT_OUTDATED, 409);
    }
    const purchase: Purchase = { priceId, key: purchaseKey(priceId, currency), terms, consentText, country };

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
            if (start.reason === 'deletion_pending') {
                return deps.json(CHECKOUT_DELETION_PENDING, 409);
            }
            if (start.reason === 'deletion_check_failed') {
                deps.logError('deletion_check_failed', start.error);
                return deps.json(CHECKOUT_DELETION_CHECK_UNAVAILABLE, 503);
            }
            deps.log(`checkout: ${caller.userId} already has an attempt in flight (${mode})`);
            return deps.json(CHECKOUT_IN_PROGRESS, 409);
        }

        let recorded = false;
        try {
            const outcome = await openSessionUnderLock(req, deps, caller, mode, purchase, start.holder, start.stored);
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
