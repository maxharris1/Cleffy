/**
 * Pure Stripe webhook event handling: idempotency, dispatch, and the mapping
 * from Stripe objects to `subscriptions` rows.
 *
 * Like stripeSignature.ts this module has NO imports, so vitest loads the very
 * same file the Deno function does. All I/O arrives through `WebhookStore`, so
 * the suite drives it with a hand-rolled fake — the same shape as
 * `src/sync/syncEngine.test.ts`'s `FakeApi`.
 */

export type BillingTier = 'free' | 'personal' | 'teacher' | 'academy';

/** Statuses that actually grant paid entitlements — must match get_entitlements(). */
const ENTITLING_STATUSES = ['active', 'trialing'];

/**
 * Statuses that end a subscription for good. `past_due` is deliberately absent:
 * Stripe retries payment for days, and get_entitlements already drops the user
 * to free limits meanwhile, so there is no reason to archive their scores while
 * the card issue might still resolve.
 */
const ARCHIVING_STATUSES = ['canceled', 'unpaid', 'incomplete_expired'];

/**
 * Statuses a Stripe subscription never comes back from, which is what makes them
 * safe to treat as a floor. `unpaid` is deliberately NOT here even though it
 * archives: paying the outstanding invoice can put that same subscription back
 * to `active`, and a floor would strand the customer who just paid.
 */
const TERMINAL_STATUSES = ['canceled', 'incomplete_expired'];

export const isEntitlingStatus = (status: string): boolean => ENTITLING_STATUSES.includes(status);

export const shouldArchiveOnStatus = (status: string): boolean => ARCHIVING_STATUSES.includes(status);

export const isTerminalStatus = (status: string): boolean => TERMINAL_STATUSES.includes(status);

/**
 * Past due, inside its grace period, still pays (launch-compliance decisions 21
 * and 25): an Academy subscription, card-paid or Stripe Invoicing, and any
 * Stripe Invoicing subscription, keeps full access for 30 days after it first
 * went past due, or until an admin's later extension -- subscription_is_live()
 * in migration 20261020180900_district_paying_status.sql decides how long -- so
 * its row has to keep naming the plan it pays for. `unpaid` is not paying and
 * records free, and so does a card Personal or Teacher plan past due, as before.
 */
const keepsTierWhilePastDue = (sub: StripeSubscriptionLike, priceTiers: Record<string, BillingTier>): boolean =>
    sub.status === 'past_due' && (collectionMethodOf(sub) === 'send_invoice' || tierOf(sub, priceTiers) === 'academy');

/**
 * Whether the buyer already holds a subscription that Checkout would put a
 * SECOND one beside. Checkout always creates a new subscription, so a Personal
 * subscriber who picked Teacher there was billed for both; plan changes and
 * resuming a cancelled plan belong to the billing portal, which changes the one
 * they have.
 *
 * Running means entitling and inside its period (cancel_at_period_end included:
 * it still runs, and resuming it is one click in the portal), or past_due --
 * Stripe is still retrying it, and fixing the card there brings it back.
 * Anything that has ended, or never started (incomplete), leaves Checkout open.
 */
export const holdsRunningSubscription = (
    rows: Array<{ status: string; current_period_end: string | null }>,
    nowMs: number,
): boolean =>
    rows.some((row) => {
        if (row.status === 'past_due') {
            return true;
        }
        if (!isEntitlingStatus(row.status)) {
            return false;
        }
        if (row.current_period_end === null) {
            return true;
        }
        const endMs = Date.parse(row.current_period_end);
        return Number.isFinite(endMs) ? endMs > nowMs : true;
    });

/**
 * How Stripe collects a subscription's invoices. Checkout only ever creates
 * `charge_automatically`; `send_invoice` is Stripe Invoicing, which only an
 * admin holding the secret key can set up -- that is what a district contract
 * is, and what a studio's seat override is tied to (migration
 * 20261020180400_district_seat_overrides.sql).
 */
export type CollectionMethod = 'charge_automatically' | 'send_invoice';

export interface SubscriptionUpsert {
    stripe_subscription_id: string;
    user_id: string;
    tier: BillingTier;
    status: string;
    price_id: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    /**
     * When Stripe created the event this row was written from. The row keeps the
     * newest one it has seen and the subscriptions_refuse_stale_event trigger
     * drops any write carrying an older stamp, which is the one reordering the
     * live read-back cannot fix: two deliveries in flight at once, the one that
     * read the older state writing second (QA round 4, D3).
     */
    last_event_created_at: string | null;
    /**
     * Null only for an object that did not say. The write keeps whatever the
     * row already had in that case, so an incomplete object cannot unset it.
     */
    collection_method: CollectionMethod | null;
    /**
     * When the subscription actually ended, by Stripe's own account of it:
     * null until the status is terminal (endedAtOf). The write keeps a stored
     * one over a null, like collection_method.
     */
    ended_at: string | null;
}

/** Only the fields this handler reads — not a full mirror of Stripe's type. */
export interface StripeSubscriptionLike {
    id: string;
    status: string;
    cancel_at_period_end?: boolean | null;
    /** A scheduled cancellation (seconds), set from the dashboard or the API. */
    cancel_at?: number | null;
    /** Set by Stripe once the subscription has ended. */
    ended_at?: number | null;
    current_period_end?: number | null;
    customer?: string | { id?: string } | null;
    collection_method?: string | null;
    metadata?: Record<string, string> | null;
    items?: {
        data?: Array<{ price?: { id?: string | null } | null; current_period_end?: number | null } | undefined>;
    } | null;
}

export interface StripeCheckoutSessionLike {
    id?: string;
    customer?: string | { id?: string } | null;
    subscription?: string | { id?: string } | null;
    client_reference_id?: string | null;
    metadata?: Record<string, string> | null;
    /** What was charged, tax included, in minor units of `currency`. */
    amount_total?: number | null;
    currency?: string | null;
    total_details?: { amount_tax?: number | null; amount_discount?: number | null } | null;
    /** The billing address Checkout collected (billing_address_collection: required). */
    customer_details?: { address?: { country?: string | null } | null } | null;
    created?: number | null;
}

export interface StripeInvoiceLike {
    customer?: string | { id?: string } | null;
    subscription?: string | { id?: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id?: string } | null } | null } | null;
}

export interface StripeEventLike {
    id: string;
    type: string;
    /**
     * `previous_attributes` is on `*.updated` events only, and holds the old
     * value of exactly the fields that changed -- which is how a cancellation
     * being SCHEDULED is told apart from any other update.
     */
    data: { object: unknown; previous_attributes?: Record<string, unknown> | null };
    /** Stripe stamps the sending account's mode on every event. */
    livemode?: boolean;
    /**
     * Seconds since the epoch, stamped by Stripe when the event was created.
     * Optional only because this type describes what we READ rather than what
     * Stripe promises: an event without it writes no stamp, and the trigger
     * leaves such a write alone rather than guessing (see SubscriptionUpsert).
     */
    created?: number;
}

/**
 * What fetchSubscription answers when Stripe says the id does not exist
 * (resource_missing): a subscription from the other mode's account, or a test
 * object since deleted. Distinct from `null` because the right answer differs --
 * a transient failure is retried, a missing object never will be found.
 */
export const SUBSCRIPTION_MISSING = 'missing' as const;

/**
 * How long a claim may sit unfinished before another delivery may take it over.
 *
 * Written as a Postgres interval because that is where the comparison happens
 * (claim_stripe_event, migration 20261012120101). The window has to clear the
 * longest honest processing time by a wide margin -- an Edge Function's
 * wall-clock ceiling is low single-digit minutes, and the slowest path here is
 * a Stripe read plus two RPCs -- or a delivery that is genuinely still running
 * gets a second one beside it. And it has to be far inside Stripe's roughly
 * three days of retries, or the claim is never recovered at all. Ten minutes
 * sits between the two: a claim lost to a dead isolate is picked up by the
 * retry after it (Stripe backs off to 30 minutes, then hours), hours before
 * Stripe gives up, and no live invocation has ever been running that long.
 */
export const STRIPE_EVENT_CLAIM_STALE_AFTER = '10 minutes';

/**
 * The wall-clock ceiling an Edge Function invocation can reach before the
 * platform kills it. Here only to be compared against the lease below, which is
 * the comparison that was wrong.
 */
export const EDGE_FUNCTION_WALL_CLOCK_MS = 150_000;

/**
 * How long one delivery may hold a subscription's write lock before another may
 * take it over (claim_subscription_write, migration 20261012120105), in the two
 * forms that have to agree: the Postgres interval the comparison is made in and
 * the milliseconds a test can compare against the ceiling above.
 *
 * "An Edge Function cannot run for anything like two minutes" was simply untrue
 * (QA round 4 review of #56): the ceiling is longer than that, so a delivery
 * stalled inside its Stripe read -- which is where this lock is held across --
 * was still running when its own lease went stale. A second delivery then took
 * the lease over, read `active`, wrote it, and released; the first woke up and
 * wrote the `past_due` it had read minutes earlier, because nothing checked
 * ownership at the WRITE. The row then said a customer whose card had failed was
 * paid up until the next event about them, which is the exact D3 failure the
 * lock was added to close.
 *
 * Five minutes clears the ceiling. The write itself no longer depends on that
 * arithmetic being right, though -- `write_subscription_under_lock` (migration
 * 20261013120101) refuses a write whose lease has been taken over, in the same
 * statement as the write -- so the length only decides how long a subscription
 * is unwritable after an isolate dies holding it, which Stripe's backoff hides.
 */
export const STRIPE_SUBSCRIPTION_LOCK_STALE_AFTER_MS = 5 * 60_000;
export const STRIPE_SUBSCRIPTION_LOCK_STALE_AFTER = '5 minutes';

/**
 * What came of asking for an event's claim. The three answers want three
 * different HTTP statuses, which is the whole reason this is not a boolean
 * (QA round 4, D2 follow-up):
 *
 *  * `claimed`   -- ours; process the event.
 *  * `done`      -- applied already. A redelivery is a duplicate, and 200 is
 *                   right: Stripe may forget it.
 *  * `in_flight` -- another delivery holds the claim and has not finished. A 200
 *                   here would tell Stripe the event landed when NOBODY has
 *                   applied it; if the holder then dies, the claim goes stale
 *                   with no delivery left to take it over. So it is answered
 *                   with a 409 and Stripe keeps trying.
 */
export type ClaimOutcome = 'claimed' | 'done' | 'in_flight';

/**
 * What upsertSubscription did.
 *
 * `duplicate` is the partial unique index (subscriptions_one_entitling_per_user_mode,
 * migration 20261012120100) refusing a SECOND entitling subscription for this
 * user and Stripe account. The row is deliberately left absent; see the
 * handler's duplicate branch for what happens in Stripe.
 *
 * `lost_lock` is the write lease having been taken over before this delivery
 * got to use it (write_subscription_under_lock, migration 20261013120101). The
 * state this delivery read is older than whatever the delivery that took the
 * lease over has since written, so the write is refused rather than applied --
 * that is the whole reason the check lives in the write statement and not
 * beside it.
 */
/**
 * A purchase that has just been applied, for the confirmation email and the
 * consent record (launch packet items 14 and 18).
 */
export interface PurchaseNotice {
    userId: string;
    sessionId: string;
    subscriptionId: string;
    /** checkout_consents.id, from the session metadata stripe-checkout stamped. */
    consentId: string | null;
    priceId: string | null;
    billingCountry: string | null;
    currency: string | null;
    amountTotalMinor: number | null;
    amountTaxMinor: number | null;
    /** A promotion code's discount on that total, when there was one. */
    amountDiscountMinor: number | null;
    /** When it next renews -- the end of the period just paid for. */
    renewsAt: string | null;
    purchasedAt: string;
}

/** A subscription that has just been set to end instead of renewing. */
export interface CancellationNotice {
    userId: string;
    subscriptionId: string;
    priceId: string | null;
    /** When access ends. */
    endsAt: string | null;
    /** When the cancellation was made (the event's own clock). */
    cancelledAt: string;
}

export type SubscriptionWriteOutcome =
    { outcome: 'written' } | { outcome: 'duplicate'; otherSubscriptionId: string | null } | { outcome: 'lost_lock' };

export interface WebhookStore {
    /**
     * Takes the claim on an event id, and says what happened when it could not:
     * `done` is an event already applied (a duplicate, acknowledge it) and
     * `in_flight` is a delivery still holding the claim (nobody has applied it,
     * so ask Stripe to try again). A claim whose invocation died without
     * finishing goes stale after STRIPE_EVENT_CLAIM_STALE_AFTER and is
     * claimable again, which is what stops a dead isolate turning every Stripe
     * retry into `200 duplicate` (QA round 4, D2).
     */
    claimEvent: (id: string, type: string) => Promise<ClaimOutcome>;
    /**
     * Marks the claim finished, so every later delivery of it is a duplicate
     * rather than a claim waiting to go stale. Called for every outcome that
     * genuinely finished with the event, which is every 2xx this module returns
     * after taking the claim.
     */
    markEventDone: (id: string) => Promise<void>;
    userIdForCustomer: (customerId: string) => Promise<string | null>;
    linkCustomer: (customerId: string, userId: string) => Promise<void>;
    /**
     * Writes the row, but only while `holder` is still the lease on this
     * subscription's writes -- one statement, so there is no gap between the
     * check and the write for a takeover to land in. `holder` is the token
     * lockSubscription answered with.
     */
    upsertSubscription: (row: SubscriptionUpsert, holder: string) => Promise<SubscriptionWriteOutcome>;
    /**
     * The subscription as Stripe holds it NOW. Every event that changes a
     * subscription's entitlements except `deleted` is applied from this rather
     * than from the copy embedded in the event, which is only as fresh as the
     * event and may arrive after a newer one. `null` means Stripe could not be
     * read right now (network, rate limit, a 5xx) and a retry may succeed;
     * SUBSCRIPTION_MISSING means Stripe answered that the subscription does not
     * exist, which no retry will change.
     */
    fetchSubscription: (subscriptionId: string) => Promise<StripeSubscriptionLike | typeof SUBSCRIPTION_MISSING | null>;
    userIdForSubscription: (subscriptionId: string) => Promise<string | null>;
    /** The status already recorded for a subscription; null when there is no row yet. */
    storedStatusOf: (subscriptionId: string) => Promise<string | null>;
    applyFreeTierArchival: (userId: string) => Promise<void>;
    /**
     * Un-archives the scores a lapse archived, up to the cap of the plan the user
     * now resolves to (restore_plan_archived_scores) -- the user's own, then
     * those of every teacher seated in a studio the user owns who now resolves
     * to an unlimited plan. An owner's own archive is never touched.
     */
    restorePlanArchivedScores: (userId: string) => Promise<void>;
    /**
     * Forgets a claimed event id, so Stripe's retry of it is processed rather
     * than skipped as a duplicate. Must be called before answering with a
     * retryable status. Only ever drops the claim this invocation holds: if it
     * went stale and another delivery took it over, that one is mid-flight and
     * its claim is not ours to remove.
     */
    releaseEvent: (id: string) => Promise<void>;
    /**
     * Takes the write lock for one subscription and answers with the token to
     * give it back with, or null because another delivery holds it.
     *
     * What it buys (QA round 4, D3 follow-up): the Stripe read-back and the row
     * it writes become one step per subscription. The
     * subscriptions_refuse_stale_event trigger can only order events Stripe
     * stamped different seconds apart -- equal stamps have to pass, or a retry
     * of one event could not write its own state again -- so two events created
     * inside the same second and delivered at once could still land in the
     * wrong order: A reads `active`, B reads `past_due`, B writes, A writes.
     * Whoever holds this lock reads AFTER the other one's write, so there is no
     * older read left to land.
     */
    lockSubscription: (subscriptionId: string) => Promise<string | null>;
    /** Gives the lock back. Only ever drops the lease this delivery holds. */
    unlockSubscription: (subscriptionId: string, holder: string) => Promise<void>;
    /**
     * Cancels a duplicate subscription in Stripe and refunds what it charged.
     *
     * Called only when the partial unique index refuses a SECOND entitling
     * subscription for one user, which means the double charge D1 describes has
     * already happened in Stripe. Never throws: a duplicate it could not undo is
     * still one the alert has to name.
     */
    cancelDuplicateSubscription: (subscriptionId: string) => Promise<DuplicateUndo>;
    /**
     * The three halves of the duplicate-undo ledger (`duplicate_refunds`,
     * migration 20261013120102), which is what makes an unrefunded duplicate
     * survive the event that found it.
     *
     * `recordPendingDuplicateUndo` is written BEFORE the Stripe calls are
     * attempted, so a failure of any kind -- including the isolate dying -- still
     * leaves the money we owe written down somewhere.
     *
     * `pendingDuplicateUndo` is what every later delivery about that
     * subscription checks, and the reason the record is keyed on the
     * subscription rather than on the event: the event that found the duplicate
     * reads as applied-and-finished the moment its retry succeeds at anything,
     * and by then the duplicate is `canceled`, so the duplicate branch is never
     * reached again (see finishPendingDuplicateUndo).
     */
    pendingDuplicateUndo: (subscriptionId: string) => Promise<{ userId: string | null } | null>;
    recordPendingDuplicateUndo: (subscriptionId: string, userId: string | null) => Promise<void>;
    settleDuplicateUndo: (subscriptionId: string, state: DuplicateUndoState, undone: DuplicateUndo) => Promise<void>;
    /**
     * After a checkout is applied: completes its consent record (subscription id,
     * billing country) and writes the purchase confirmation into the durable
     * outbox (billing_mail_outbox), once per session -- the mail itself goes out
     * after the response, and is retried there until it does.
     *
     * Throws when either write fails, and the handler then fails the EVENT
     * (Codex finding 3 on #62): the old rule -- log it, acknowledge anyway --
     * marked the event done with the consent incomplete and the confirmation
     * unsent, and Stripe's redelivery then exited as a duplicate, so nothing
     * ever tried again. Failing it is safe because every step before this one is
     * idempotent: the redelivery re-applies the same subscription row (equal
     * event stamps pass the stale-event guard), re-completes the same consent
     * and finds the confirmation already queued.
     */
    recordPurchaseNotice: (notice: PurchaseNotice) => Promise<void>;
    /** After a cancellation is scheduled: the cancellation confirmation, queued once. Same failure rule. */
    recordCancellationNotice: (notice: CancellationNotice) => Promise<void>;
    /**
     * account_deletion_pending() for the user an event is about (deletionPending.ts),
     * asked before the event writes anything for them (launch-fix item 16,
     * decision 70(1)). `unknown` is a check that could not be answered.
     */
    accountDeletionPending: (userId: string) => Promise<'clear' | 'pending' | 'unknown'>;
    log: (message: string) => void;
}

/**
 * What cancelDuplicateSubscription managed to do, for the alert to report and
 * for the handler to decide whether a redelivery could do better.
 *
 * `refund` is four-valued rather than a boolean because only one of its
 * outcomes is worth retrying: a duplicate caught while still trialing has
 * nothing to hand back (`nothing_to_refund`), a paid invoice whose payment
 * cannot be identified will read the same on every retry (`needs_human`), and
 * only `failed` -- Stripe unreachable, or refusing in a way that may not repeat
 * -- gets another delivery.
 */
export interface DuplicateUndo {
    /** Whether the duplicate can still bill. */
    stopped: boolean;
    refund: 'refunded' | 'nothing_to_refund' | 'needs_human' | 'failed';
    detail: string;
}

/**
 * What the duplicate-undo ledger records about an attempt, which is also what
 * decides whether anything will try again.
 *
 *  * `resolved`     -- the duplicate cannot bill and the money is back (or there
 *                      never was any: a duplicate caught while still trialing).
 *                      Nothing left to do.
 *  * `needs_human`  -- a paid invoice whose payment cannot be identified. Reads
 *                      the same way on every retry, so retrying only buries the
 *                      alert; the row is what a human reconciles from.
 *  * `pending`      -- a cancel or a refund that failed in a way another attempt
 *                      might get past. Stays in the ledger and is retried by the
 *                      next delivery about this subscription.
 */
export type DuplicateUndoState = 'resolved' | 'needs_human' | 'pending';

/**
 * Which of the three an attempt was. `refund === 'failed'` and a cancel that did
 * not stop are the only retryable halves (see cancelAndRefundDuplicate: both are
 * safe to repeat, the refund because it carries an idempotency key per invoice).
 */
export const duplicateUndoStateOf = (undone: DuplicateUndo): DuplicateUndoState => {
    if (!undone.stopped || undone.refund === 'failed') {
        return 'pending';
    }
    return undone.refund === 'needs_human' ? 'needs_human' : 'resolved';
};

export type WebhookResult = { status: number; body: Record<string, unknown> };

/** Stripe expands some fields to objects and leaves others as bare ids. */
export const idOf = (value: string | { id?: string } | null | undefined): string | null => {
    if (typeof value === 'string') {
        return value.length > 0 ? value : null;
    }
    if (value && typeof value === 'object' && typeof value.id === 'string') {
        return value.id;
    }
    return null;
};

/**
 * Price -> tier comes from Edge Function env, never from the database. That is
 * what keeps Founding Teacher schema-free: it is a second, cheaper price on the
 * Teacher product, so it maps to 'teacher' like any other Teacher price.
 */
export const tierForPrice = (priceId: string | null, priceTiers: Record<string, BillingTier>): BillingTier => {
    if (!priceId) {
        return 'free';
    }
    return priceTiers[priceId] ?? 'free';
};

/**
 * The subscription metadata that marks a district contract. A district is
 * priced on a custom quote, so its price is in no catalogue and tierForPrice
 * alone would record it as free.
 */
export const DISTRICT_PLAN_METADATA = { key: 'cleffy_plan', value: 'district' } as const;

const collectionMethodOf = (sub: StripeSubscriptionLike): CollectionMethod | null =>
    sub.collection_method === 'send_invoice' || sub.collection_method === 'charge_automatically'
        ? sub.collection_method
        : null;

/**
 * A district contract: Stripe Invoicing AND marked as one in metadata. Both,
 * because neither is something a customer can set -- Checkout only creates
 * `charge_automatically` subscriptions and writes only server-chosen metadata --
 * but the metadata alone would be one dashboard slip from turning any
 * card-paid subscription into Academy, and send_invoice alone would do the
 * same for any invoice-billed one-off.
 */
export const isDistrictSubscription = (sub: StripeSubscriptionLike): boolean =>
    collectionMethodOf(sub) === 'send_invoice' &&
    sub.metadata?.[DISTRICT_PLAN_METADATA.key] === DISTRICT_PLAN_METADATA.value;

/**
 * A catalogue price names its plan. A district's custom-quote price is in no
 * catalogue, so a district contract is Academy by its marking instead; the
 * seat count above Academy's 5 is set separately, by an admin, against this
 * subscription -- in its own table, which nothing here writes.
 */
const tierOf = (sub: StripeSubscriptionLike, priceTiers: Record<string, BillingTier>): BillingTier => {
    const byPrice = tierForPrice(priceIdOf(sub), priceTiers);
    if (byPrice !== 'free') {
        return byPrice;
    }
    return isDistrictSubscription(sub) ? 'academy' : 'free';
};

const priceIdOf = (sub: StripeSubscriptionLike): string | null => {
    const first = sub.items?.data?.[0];
    return first?.price?.id ?? null;
};

/**
 * `current_period_end` sits on the subscription in older API versions and on the
 * subscription item in newer ones — read whichever is present.
 */
const periodEndSecondsOf = (sub: StripeSubscriptionLike): number | null => {
    const seconds = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
    return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null;
};

/**
 * When the plan stops, and whether that is instead of renewing. The portal
 * cancels with cancel_at_period_end; the dashboard's "cancel on a custom date"
 * and the API set `cancel_at` and leave that flag false. A `cancel_at` at or
 * before the period end means this period is the last one, so it counts as
 * cancelling too, and the period is cut short to it: Stripe ends the
 * subscription then, not at the period end. One later than the period end
 * still renews first, so it is left out until the renewal brings it in range.
 */
const endingOf = (sub: StripeSubscriptionLike): { periodEnd: string | null; cancelling: boolean } => {
    const periodEnd = periodEndSecondsOf(sub);
    const cancelAt = typeof sub.cancel_at === 'number' && Number.isFinite(sub.cancel_at) ? sub.cancel_at : null;
    const scheduled = cancelAt !== null && (periodEnd === null || cancelAt <= periodEnd);
    const end = scheduled ? cancelAt : periodEnd;
    return {
        periodEnd: end === null ? null : new Date(end * 1000).toISOString(),
        cancelling: sub.cancel_at_period_end === true || scheduled,
    };
};

const secondsToIso = (seconds: number | null | undefined): string | null =>
    typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;

/**
 * When the subscription actually stopped, and only once it has: Stripe's
 * ended_at, or -- for an object that lacks it -- the cancel_at it was cancelled
 * on, which a terminal status confirms happened. Never a scheduled cancellation
 * (cancel_at on a live subscription) and never a period end: a district's
 * contract end is derived from this (migration 20261020180500), and the
 * retention purge counts from that.
 */
export const endedAtOf = (sub: StripeSubscriptionLike): string | null => {
    if (!isTerminalStatus(sub.status)) {
        return null;
    }
    return secondsToIso(sub.ended_at) ?? secondsToIso(sub.cancel_at);
};

/**
 * What /cancel's "Cancel now" needs of Stripe's live subscription
 * (cancelFlow.ts LiveSubscription), by the same rule the mirror is written
 * with. billing-cancel used to count ANY `cancel_at` as already cancelling, so
 * a monthly plan with a cancellation date three months out skipped the Stripe
 * update and told the buyer "cancelled" while two renewals were still to bill
 * (Codex round 2, finding 1 on #62). Only `cancel_at_period_end`, or a
 * `cancel_at` at or before the current period end, stops the next renewal;
 * anything later is not cancelling yet, and "Cancel now" sets
 * cancel_at_period_end.
 */
export const liveSubscriptionOf = (
    sub: StripeSubscriptionLike,
): { status: string; cancelling: boolean; endsAt: string | null } => {
    const ending = endingOf(sub);
    return { status: sub.status, cancelling: ending.cancelling, endsAt: ending.periodEnd };
};

/**
 * The subscription a cancellation confirmation is owed for, when this event is
 * one being SET to cancel -- from the portal, from /cancel, or from the
 * dashboard -- and null for any other update to one that was already
 * cancelling (or a cancellation being undone).
 *
 * Whether it is the transition is read from the EVENT alone: its
 * `previous_attributes` name the fields that changed with their old values (a
 * cancel_at_period_end that WAS false, or a cancel_at that WAS null), and its
 * embedded object is the subscription as that change left it. That is what
 * makes the confirmation durable across redeliveries (Codex round 2, finding 3
 * on #62): when recording it fails, Stripe redelivers the same event, and by
 * then the subscription may have ENDED -- which the live state alone read as
 * "not cancelling", so the retry was acknowledged with nothing recorded.
 *
 * `current` (Stripe's state now) can only veto, and only for the one reason
 * worth it: a cancellation already undone -- still running, no longer
 * cancelling -- sends nothing. Ended is the cancellation having happened, and
 * is confirmed from the event; still cancelling is confirmed from `current`,
 * the fresher of the two.
 */
export const scheduledCancellationOf = (
    event: StripeEventLike,
    current: StripeSubscriptionLike,
): StripeSubscriptionLike | null => {
    if (event.type !== 'customer.subscription.updated') {
        return null;
    }
    const previous = event.data.previous_attributes ?? null;
    if (!previous) {
        return null;
    }
    const wasNotCancelling =
        ('cancel_at_period_end' in previous && previous.cancel_at_period_end === false) ||
        ('cancel_at' in previous && previous.cancel_at === null);
    const embedded = event.data.object as StripeSubscriptionLike;
    if (!wasNotCancelling || !endingOf(embedded).cancelling || isTerminalStatus(embedded.status)) {
        return null;
    }
    if (isTerminalStatus(current.status)) {
        return embedded;
    }
    return endingOf(current).cancelling ? current : null;
};

export const cancellationNoticeFrom = (
    event: StripeEventLike,
    current: StripeSubscriptionLike,
    userId: string,
): CancellationNotice => ({
    userId,
    subscriptionId: current.id,
    priceId: priceIdOf(current),
    endsAt: endingOf(current).periodEnd,
    cancelledAt: eventStampOf(event) ?? new Date().toISOString(),
});

export const purchaseNoticeFrom = (
    event: StripeEventLike,
    session: StripeCheckoutSessionLike,
    sub: StripeSubscriptionLike,
    userId: string,
): PurchaseNotice | null => {
    if (!session.id) {
        return null;
    }
    const country = session.customer_details?.address?.country?.trim().toUpperCase() ?? '';
    const periodEnd = periodEndSecondsOf(sub);
    return {
        userId,
        sessionId: session.id,
        subscriptionId: sub.id,
        consentId: session.metadata?.consent_id ?? sub.metadata?.consent_id ?? null,
        priceId: priceIdOf(sub),
        billingCountry: /^[A-Z]{2}$/.test(country) ? country : null,
        currency: session.currency?.toLowerCase() ?? null,
        amountTotalMinor: typeof session.amount_total === 'number' ? session.amount_total : null,
        amountTaxMinor: typeof session.total_details?.amount_tax === 'number' ? session.total_details.amount_tax : null,
        amountDiscountMinor:
            typeof session.total_details?.amount_discount === 'number' ? session.total_details.amount_discount : null,
        renewsAt: periodEnd === null ? null : new Date(periodEnd * 1000).toISOString(),
        purchasedAt:
            eventStampOf(event) ??
            (typeof session.created === 'number' ? new Date(session.created * 1000).toISOString() : null) ??
            new Date().toISOString(),
    };
};

/**
 * Records a notice durably, or fails the event so Stripe delivers it again
 * (Codex finding 3 on #62). A notice follows an APPLIED write, and re-applying
 * that write is harmless (see `recordPurchaseNotice`), whereas acknowledging an
 * event whose consent completion or confirmation was never written down loses
 * them for good: the redelivery would be a duplicate. Answers null when the
 * notice is recorded, else the retry to answer with.
 */
const recordNotice = async (
    store: WebhookStore,
    event: StripeEventLike,
    record: () => Promise<void>,
): Promise<WebhookResult | null> => {
    try {
        await record();
        return null;
    } catch (err) {
        store.log(
            `ALERT ${event.type} ${event.id}: notice not recorded, asking Stripe to redeliver: ` +
                (err instanceof Error ? err.message : String(err)),
        );
        return retryLater(store, event, 'notice_not_recorded');
    }
};

/**
 * The event's own clock, as the row records it. Stripe stamps `created` on every
 * event it sends, so this is the Stripe account's view of when the change
 * happened -- the only ordering both deliveries of a race can be compared on.
 */
export const eventStampOf = (event: StripeEventLike): string | null =>
    typeof event.created === 'number' && Number.isFinite(event.created)
        ? new Date(event.created * 1000).toISOString()
        : null;

export const subscriptionRowFrom = (
    sub: StripeSubscriptionLike,
    userId: string,
    priceTiers: Record<string, BillingTier>,
    lastEventCreatedAt: string | null = null,
): SubscriptionUpsert => {
    const priceId = priceIdOf(sub);
    const ending = endingOf(sub);
    return {
        stripe_subscription_id: sub.id,
        user_id: userId,
        tier:
            isEntitlingStatus(sub.status) || keepsTierWhilePastDue(sub, priceTiers) ? tierOf(sub, priceTiers) : 'free',
        status: sub.status,
        price_id: priceId,
        current_period_end: ending.periodEnd,
        cancel_at_period_end: ending.cancelling,
        last_event_created_at: lastEventCreatedAt,
        collection_method: collectionMethodOf(sub),
        ended_at: endedAtOf(sub),
    };
};

const resolveUserId = async (
    store: WebhookStore,
    customerId: string | null,
    metadata: Record<string, string> | null | undefined,
    clientReferenceId?: string | null,
): Promise<string | null> => {
    const fromMetadata = metadata?.user_id;
    if (fromMetadata) {
        return fromMetadata;
    }
    if (clientReferenceId) {
        return clientReferenceId;
    }
    if (customerId) {
        return store.userIdForCustomer(customerId);
    }
    return null;
};

/**
 * The answer for a second entitling subscription the partial unique index
 * refuses (QA round 4, D1). The row is not written, the duplicate is cancelled
 * and refunded in Stripe, and Stripe is answered 200.
 *
 * Each of those three is a decision:
 *
 *  * no row, because that is what keeps the money and the product in step:
 *    get_entitlements reads this table, so the customer is entitled by the
 *    subscription that did land and by that one only, exactly as if the
 *    duplicate had never been bought. delete-account is unaffected too -- it
 *    lists subscriptions from Stripe, not from here, so a duplicate with no row
 *    is still cancelled when the account goes.
 *  * cancelled and refunded, because the refusal IS the detection: the index
 *    only refuses when the customer has been billed twice for the same period,
 *    and the first round of fixes left that for a human reading a log line,
 *    which means the customer keeps paying until someone does. Which one to
 *    cancel is decided by which one landed: the recorded subscription is the one
 *    entitling them, so the newcomer is the one that goes. A plan they actually
 *    wanted is one portal click away from the plan they have, and a refund is
 *    the half that cannot be undone by waiting.
 *  * 200, because the constraint will refuse this write identically for the
 *    next three days: retrying only buries the failures that matter under
 *    endpoint-failure alerts. A cancel or refund that failed in a way a
 *    redelivery might get past is the exception -- that is asked for again,
 *    because an unrefunded duplicate is money we are holding that is not ours.
 *
 * The alert is loud either way, and still names both subscriptions: nothing
 * reconciles Stripe against this table on a schedule, so a human reading it is
 * how a case neither half could undo is noticed.
 *
 * The ledger write is what makes the retry real rather than nominal (QA round 4
 * review of #56, finding 2). Asking Stripe to redeliver only works if the
 * redelivery comes BACK here, and it does not: the cancel above has already
 * made the duplicate `canceled` in Stripe, so the redelivery re-reads it,
 * `canceled` is not an entitling status, the partial unique index has nothing to
 * refuse, the row is written as any other cancellation, and the event is
 * acknowledged 200 -- with the refund never attempted again and nothing left
 * saying it was owed. So the debt is recorded in `duplicate_refunds` before
 * either Stripe call, keyed on the subscription, and
 * `finishPendingDuplicateUndo` retries it from every later delivery about that
 * subscription whatever its status by then.
 */
const duplicateEntitling = async (
    store: WebhookStore,
    event: StripeEventLike,
    sub: StripeSubscriptionLike,
    userId: string,
    otherSubscriptionId: string | null,
): Promise<WebhookResult> => {
    // Before the attempt, not after it: an isolate that dies between the two
    // Stripe calls has still charged the customer twice, and this row is the
    // only thing that would know.
    await store.recordPendingDuplicateUndo(sub.id, userId);
    const undone = await store.cancelDuplicateSubscription(sub.id);
    const state = duplicateUndoStateOf(undone);
    await store.settleDuplicateUndo(sub.id, state, undone);
    store.log(
        `ALERT ${event.type} ${event.id}: user ${userId} would hold two entitling subscriptions ` +
            `(${otherSubscriptionId ?? 'unknown'} is recorded, ${sub.id} was refused as ${sub.status}); ` +
            `the duplicate is NOT recorded, and in Stripe: ${undone.detail}`,
    );
    if (state === 'pending') {
        // Both halves are safe to repeat (see cancelAndRefundDuplicate), so a
        // retry costs nothing and is the only thing that can still put this
        // right without a human. Only a failure that MIGHT not repeat is worth
        // one: an unidentifiable payment reads the same way every time, and
        // three days of 500s would bury it instead of surfacing it. The ledger
        // row outlives this answer either way.
        return retryLater(store, event, 'duplicate_not_undone');
    }
    return { status: 200, body: { received: true, ignored: 'duplicate_active_subscription' } };
};

/**
 * Finishes a duplicate undo some earlier delivery could not (QA round 4 review
 * of #56, finding 2).
 *
 * Runs under the subscription's write lock, before the event itself is applied,
 * for every delivery that names a subscription -- because the status of that
 * subscription is exactly what cannot be relied on. By the time anything retries,
 * the duplicate has usually been cancelled already, so every path that keys off
 * "is this an entitling duplicate?" is blind to it; the ledger is keyed off the
 * subscription id instead, which does not change.
 *
 * `null` is the normal answer and the cheap one: no ledger row, carry on with the
 * event. A row that is still `pending` after another attempt asks Stripe to
 * redeliver, so the next delivery tries again; one that settles (refunded, or
 * nothing to refund, or a human's now) lets the event through.
 */
const finishPendingDuplicateUndo = async (
    store: WebhookStore,
    event: StripeEventLike,
    subscriptionId: string,
): Promise<WebhookResult | null> => {
    const owed = await store.pendingDuplicateUndo(subscriptionId);
    if (!owed) {
        return null;
    }
    const undone = await store.cancelDuplicateSubscription(subscriptionId);
    const state = duplicateUndoStateOf(undone);
    await store.settleDuplicateUndo(subscriptionId, state, undone);
    store.log(
        `ALERT ${event.type} ${event.id}: duplicate ${subscriptionId} (user ${owed.userId ?? 'unknown'}) ` +
            `was still owed an undo; retried it, now ${state}: ${undone.detail}`,
    );
    return state === 'pending' ? await retryLater(store, event, 'duplicate_not_undone') : null;
};

/**
 * A district is billed through Stripe Invoicing, so no Checkout ever links its
 * customer to the owner. Without the link, stripe-portal answers no_customer
 * for the owner's own billing (Codex review of #61, minor 1). The subscription
 * write vouches for the owner: a district subscription is attributed by the
 * metadata an admin set, and the marking is not something a customer can set.
 *
 * An unmapped customer is linked to the owner, which replaces any older
 * customer the owner had in this Stripe account. That is the right account for
 * their portal now, and the runbook has them cancel any card plan first. A
 * customer already mapped to SOMEONE ELSE is left alone and logged, because a
 * mapping is never moved off another user on a subscription's say-so.
 *
 * The link is a write of its own, so the deletion check is asked again right
 * before it (Codex r2 finding 1 on #73): a deletion that begins while the row
 * is written gets no billing_customers link either. Pending: the refusal is
 * returned for the caller to answer with (claim released, 503).
 */
const linkDistrictCustomer = async (
    store: WebhookStore,
    event: StripeEventLike,
    sub: StripeSubscriptionLike,
    userId: string,
): Promise<WebhookResult | null> => {
    const customerId = idOf(sub.customer);
    if (!customerId || !isDistrictSubscription(sub)) {
        return null;
    }
    const mapped = await store.userIdForCustomer(customerId);
    if (mapped === userId) {
        return null;
    }
    if (mapped !== null) {
        store.log(
            `district subscription ${sub.id}: customer ${customerId} is already linked to another user; ` +
                `not relinking it to ${userId}`,
        );
        return null;
    }
    const beforeLink = await deletionRefusal(store, event, [userId]);
    if (beforeLink) {
        return beforeLink;
    }
    await store.linkCustomer(customerId, userId);
    return null;
};

/**
 * Writes the row, then brings the score archive in line with it. Both halves
 * read the user's entitlements AFTER the upsert, so they act on every
 * subscription the user holds, not just this one: a lapse while another plan is
 * live archives nothing, and a restore on a plan that still resolves to a
 * finite cap restores no further than that cap.
 *
 * The restore runs on every entitling write, not only on a status change: it is
 * a no-op when nothing was archived by a lapse, and keying it to transitions
 * would need the previous status, which a late or retried event cannot be
 * trusted to carry. Unpaid -> active, a new checkout after a cancellation, and a
 * trial all land here. A teacher entitled by someone else's subscription (an
 * Academy seat) gets no webhook of their own: restore_plan_archived_scores also
 * restores the teachers seated in the subscriber's studios, and a new seat
 * restores its teacher in the database (studio_members_restore_plan_archived).
 */
const applySubscription = async (
    store: WebhookStore,
    event: StripeEventLike,
    sub: StripeSubscriptionLike,
    userId: string,
    priceTiers: Record<string, BillingTier>,
    holder: string,
): Promise<WebhookResult | null> => {
    // Asked again right before each write (Codex r1 finding 3 on #73, decision
    // 72(2)): the check before the lock is a moment, and a deletion can begin
    // during the Stripe read every caller makes first, or between the row and
    // a district's customer link or the archive or restore below. Pending:
    // nothing more is written, the claim is released, 503 (deletionRefusal).
    const beforeRow = await deletionRefusal(store, event, [userId]);
    if (beforeRow) {
        return beforeRow;
    }
    const written = await store.upsertSubscription(
        subscriptionRowFrom(sub, userId, priceTiers, eventStampOf(event)),
        holder,
    );
    if (written.outcome === 'duplicate') {
        return await duplicateEntitling(store, event, sub, userId, written.otherSubscriptionId);
    }
    if (written.outcome === 'lost_lock') {
        return await leaseLost(store, event, sub.id);
    }
    const beforeLink = await linkDistrictCustomer(store, event, sub, userId);
    if (beforeLink) {
        return beforeLink;
    }
    const beforeScores = await deletionRefusal(store, event, [userId]);
    if (beforeScores) {
        return beforeScores;
    }
    if (shouldArchiveOnStatus(sub.status)) {
        await store.applyFreeTierArchival(userId);
    } else if (isEntitlingStatus(sub.status)) {
        await store.restorePlanArchivedScores(userId);
    }
    return null;
};

/**
 * The answer for an event we could not finish because Stripe itself could not
 * be read. The claim is released first: keeping it would make the retry this
 * status asks for look like a duplicate, and the event -- for a checkout, the
 * customer's whole purchase -- would be acknowledged and lost.
 */
const retryLater = async (store: WebhookStore, event: StripeEventLike, reason: string): Promise<WebhookResult> => {
    await store.releaseEvent(event.id);
    return { status: 500, body: { error: reason, retry: true } };
};

/**
 * Runs the read-and-write for one subscription with nothing else writing it
 * (QA round 4, D3 follow-up). A delivery that cannot get the lock has done
 * nothing, so it releases its event claim and asks Stripe for the redelivery
 * that will find the lock free -- 503 rather than 500, because the event is
 * fine and only the timing was wrong.
 *
 * The lock is given back on every path out, including a throw: the caller turns
 * a throw into a 500 and a released claim, and a lease nobody released would
 * refuse every later event about this subscription until it went stale.
 */
const withSubscriptionLock = async (
    store: WebhookStore,
    event: StripeEventLike,
    subscriptionId: string,
    apply: (holder: string) => Promise<WebhookResult>,
): Promise<WebhookResult> => {
    const holder = await store.lockSubscription(subscriptionId);
    if (!holder) {
        store.log(
            `${event.type} ${event.id}: ${subscriptionId} is being written by another delivery; ` +
                'asking Stripe to redeliver',
        );
        await store.releaseEvent(event.id);
        return { status: 503, body: { error: 'subscription_write_in_flight', retry: true } };
    }
    try {
        // Any money still owed on this subscription is settled before the event
        // is applied, because the event itself can no longer tell: see
        // finishPendingDuplicateUndo. Inside the lock, so two deliveries cannot
        // both be asking Stripe to refund the same invoice at once -- and inside
        // the try, so the lease is given back on the 500 it can answer with.
        const owed = await finishPendingDuplicateUndo(store, event, subscriptionId);
        if (owed) {
            return owed;
        }
        return await apply(holder);
    } finally {
        await store.unlockSubscription(subscriptionId, holder);
    }
};

/**
 * The answer for a delivery whose write lease was taken over before it could
 * write (QA round 4 review of #56, finding 3).
 *
 * It has done nothing -- the write statement refused it -- and the delivery that
 * took the lease over read Stripe AFTER this one did, so its state is at least
 * as new. 503 and a released claim, like the delivery that could not get the
 * lock at all: the event is fine, only the timing was wrong, and the redelivery
 * reads Stripe again and finds the lock free.
 */
const leaseLost = async (
    store: WebhookStore,
    event: StripeEventLike,
    subscriptionId: string,
): Promise<WebhookResult> => {
    store.log(
        `${event.type} ${event.id}: the write lease on ${subscriptionId} was taken over before this ` +
            'delivery could write; asking Stripe to redeliver',
    );
    await store.releaseEvent(event.id);
    return { status: 503, body: { error: 'subscription_write_lease_lost', retry: true } };
};

/**
 * The answer for an event about an account whose deletion is pending (launch-fix
 * item 16, decision 70(1)): 503, nothing written, the claim released.
 *
 * The deletion cancels every subscription itself and sweeps Stripe again once
 * the Auth user is gone (accountDeletion.ts), so nothing here may race it: no
 * billing_customers link, no subscriptions row, no archive or restore, no
 * notice. Releasing the claim is what makes Stripe's retry count. If the
 * deletion is abandoned, the retry finds the account clear and is processed
 * normally, once (its claim is taken and marked done like any other). If it
 * completes, the retry's write finds no user and goes through the deleted-account
 * path (deletedAccountBilling.ts), which cancels anything that can still bill.
 * A check that could not be answered is refused the same way: nothing was
 * written, and the retry asks again.
 *
 * `userIds` are every user the event was attributed to before the write, so
 * one resolved two ways is checked both ways; nulls and repeats are skipped.
 */
const deletionRefusal = async (
    store: WebhookStore,
    event: StripeEventLike,
    userIds: ReadonlyArray<string | null>,
): Promise<WebhookResult | null> => {
    const checked = new Set<string>();
    for (const userId of userIds) {
        if (!userId || checked.has(userId)) {
            continue;
        }
        checked.add(userId);
        const answer = await store.accountDeletionPending(userId);
        if (answer === 'clear') {
            continue;
        }
        store.log(
            `${event.type} ${event.id}: ` +
                (answer === 'pending'
                    ? `account ${userId} is being deleted; nothing written, asking Stripe to redeliver`
                    : `could not check whether account ${userId} is being deleted; asking Stripe to redeliver`),
        );
        await store.releaseEvent(event.id);
        return {
            status: 503,
            body: {
                error: answer === 'pending' ? 'account_deletion_pending' : 'deletion_check_unavailable',
                retry: true,
            },
        };
    }
    return null;
};

/**
 * The answer for an event whose subscription Stripe says does not exist. The
 * claim is KEPT and the answer is a 200: retrying for Stripe's three days would
 * fail identically every time and trip its endpoint-failure alerts, burying the
 * failures that matter. Logged loudly, because a checkout landing here is a
 * purchase nobody applied and someone has to look at it.
 */
const subscriptionMissing = (store: WebhookStore, event: StripeEventLike, subscriptionId: string): WebhookResult => {
    store.log(
        `ALERT ${event.type} ${event.id}: Stripe says subscription ${subscriptionId} does not exist; ` +
            'acknowledged without applying it',
    );
    return { status: 200, body: { received: true, ignored: 'subscription_missing' } };
};

/**
 * Returns 200 for anything it understands OR deliberately ignores — a non-2xx
 * makes Stripe retry, which is only useful when nobody has applied the event.
 * Every non-2xx it returns has either released the event's claim (retryLater,
 * the subscription-lock 503 beside it, and the 503 for an account whose
 * deletion is pending, deletionRefusal) or never held it (the 409 for a
 * claim another delivery is holding); a THROWN error leaves the release to the
 * caller, which does it the same way.
 *
 * Takes the claim, dispatches, and marks the claim finished on every outcome
 * that genuinely is. A 2xx IS that outcome, whatever it says in the body: an
 * `ignored:` answer -- an unattributable event, a one-off payment, a
 * subscription Stripe says is gone, a status floor, an event type we do not
 * handle -- is a decision not to apply it, not a failure, and a redelivery must
 * read as the duplicate it is rather than as an abandoned claim for some future
 * delivery to take over. The non-2xx paths all go through retryLater, which
 * releases the claim, so they are skipped here; so is a throw, which the caller
 * releases.
 */
export const handleStripeEvent = async (
    event: StripeEventLike,
    store: WebhookStore,
    priceTiers: Record<string, BillingTier>,
): Promise<WebhookResult> => {
    // Idempotency first: a replay must never re-apply, and must never re-archive.
    const claim = await store.claimEvent(event.id, event.type);
    if (claim === 'done') {
        store.log(`duplicate event ${event.id} (${event.type}) ignored`);
        // Nothing to mark: the claim belongs to the delivery that took it, and
        // it is that one's job to finish or to release it.
        return { status: 200, body: { received: true, duplicate: true } };
    }
    if (claim === 'in_flight') {
        // NOT a duplicate: nobody has applied this event yet. A 200 would make
        // Stripe forget it, and if the delivery holding the claim is dying --
        // the case the staleness window exists for -- there would be no later
        // delivery to take the claim over (QA round 4, D2 follow-up). Nothing
        // to release either: the claim is not ours.
        store.log(`event ${event.id} (${event.type}) is in flight elsewhere; asking Stripe to retry`);
        return { status: 409, body: { error: 'event_in_flight', retry: true } };
    }

    const result = await dispatchStripeEvent(event, store, priceTiers);
    if (result.status >= 200 && result.status < 300) {
        await store.markEventDone(event.id);
    }
    return result;
};

const dispatchStripeEvent = async (
    event: StripeEventLike,
    store: WebhookStore,
    priceTiers: Record<string, BillingTier>,
): Promise<WebhookResult> => {
    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object as StripeCheckoutSessionLike;
            const customerId = idOf(session.customer);
            const userId = await resolveUserId(store, customerId, session.metadata, session.client_reference_id);
            if (!userId) {
                store.log(`checkout.session.completed ${event.id}: no user could be resolved`);
                return { status: 200, body: { received: true, ignored: 'unknown_user' } };
            }
            // Before the first write, the customer link (decision 70(1)).
            const pendingCheckout = await deletionRefusal(store, event, [userId]);
            if (pendingCheckout) {
                return pendingCheckout;
            }
            if (customerId) {
                await store.linkCustomer(customerId, userId);
            }

            const subscriptionId = idOf(session.subscription);
            if (!subscriptionId) {
                // A one-off payment, not a subscription checkout.
                return { status: 200, body: { received: true, ignored: 'no_subscription' } };
            }

            // Held for the read AND the write, so a `customer.subscription.*`
            // delivery about the same subscription cannot read Stripe between
            // them and write its own older answer afterwards.
            return await withSubscriptionLock(store, event, subscriptionId, async (holder) => {
                // Not retrievable is not "nothing to do": this event is the purchase.
                // Stripe retries a 5xx with backoff for days, so a transient API
                // failure heals itself; a 200 here would have dropped it for good.
                // Only a subscription Stripe says does not exist is acknowledged.
                const sub = await store.fetchSubscription(subscriptionId);
                if (sub === SUBSCRIPTION_MISSING) {
                    return subscriptionMissing(store, event, subscriptionId);
                }
                if (!sub) {
                    store.log(`checkout.session.completed ${event.id}: subscription ${subscriptionId} not retrievable`);
                    return retryLater(store, event, 'subscription_unavailable');
                }

                const refused = await applySubscription(store, event, sub, userId, priceTiers, holder);
                if (refused) {
                    return refused;
                }
                const notice = purchaseNoticeFrom(event, session, sub, userId);
                if (notice) {
                    const unrecorded = await recordNotice(store, event, () => store.recordPurchaseNotice(notice));
                    if (unrecorded) {
                        return unrecorded;
                    }
                }
                return { status: 200, body: { received: true, applied: 'subscription_upserted' } };
            });
        }

        // paused/resumed are the same shape and want the same answer: the event
        // carries a subscription, and what gets written is that subscription as
        // Stripe holds it now. A `paused` subscription bills nothing, and
        // `paused` is not an entitling status, so applying it is also what stops
        // a pause entitling a teacher for free (QA round 4, D6).
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.paused':
        case 'customer.subscription.resumed':
        case 'customer.subscription.deleted': {
            const embedded = event.data.object as StripeSubscriptionLike;
            const customerId = idOf(embedded.customer);
            const userId =
                (await resolveUserId(store, customerId, embedded.metadata)) ??
                (await store.userIdForSubscription(embedded.id));
            if (!userId) {
                store.log(`${event.type} ${event.id}: no user could be resolved`);
                return { status: 200, body: { received: true, ignored: 'unknown_user' } };
            }
            // Before the lock and so before anything is read or written for
            // them (decision 70(1)).
            const pendingSubscription = await deletionRefusal(store, event, [userId]);
            if (pendingSubscription) {
                return pendingSubscription;
            }

            // Stripe guarantees delivery, never ORDER -- and a retry after a 500
            // (every transient failure here releases the claim and asks for one)
            // makes a late arrival the normal case rather than an exotic one. The
            // object embedded in the event is the subscription as it was when the
            // event was CREATED, so applying it would let any older copy overwrite
            // a newer state: a late `unpaid` after `active` drops a customer who
            // has paid to free limits and archives their scores until the next
            // event (a month away, or a year on an annual plan); a late `active`
            // after `unpaid` restores paid entitlements Stripe has not been paid
            // for. Idempotency cannot catch either -- each is a different event id.
            //
            // So `created` and `updated` are treated as a notice that the
            // subscription changed, and what is applied is its CURRENT state,
            // read back from Stripe -- as checkout.session.completed and
            // invoice.payment_failed already do. However late a delivery, it
            // can only ever write the latest state. A failed read is retried
            // rather than falling back to the embedded copy: falling back is
            // exactly the stale write this exists to prevent.
            //
            // `deleted` needs no read: a cancellation is final, so its event can
            // never be older than anything it overwrites. Its object can still
            // read `active`; the row must not.
            // The read and the write as one step: whoever holds the lock reads
            // Stripe after the previous delivery's write, so the two cannot
            // land in the order they read in rather than the order they wrote
            // in. `deleted` takes it too -- it writes without reading, and that
            // write must not interleave with another delivery's.
            return await withSubscriptionLock(store, event, embedded.id, async (holder) => {
                let current: StripeSubscriptionLike;
                if (event.type === 'customer.subscription.deleted') {
                    current = { ...embedded, status: 'canceled' };
                } else {
                    const live = await store.fetchSubscription(embedded.id);
                    if (live === SUBSCRIPTION_MISSING) {
                        return subscriptionMissing(store, event, embedded.id);
                    }
                    if (!live) {
                        store.log(`${event.type} ${event.id}: subscription ${embedded.id} not retrievable`);
                        return retryLater(store, event, 'subscription_unavailable');
                    }
                    current = live;
                }

                // Belt and braces for the one window the live read leaves: two
                // deliveries for the same subscription in flight at once, the older
                // read landing second. A subscription Stripe has ended never comes
                // back, so nothing may reopen a row already recorded as ended.
                // Keyed on the status being APPLIED, not the one embedded: the retry
                // of an event whose archival threw after its upsert landed reads the
                // ended status back from Stripe and must re-run that archival.
                const stored = await store.storedStatusOf(embedded.id);
                if (stored !== null && isTerminalStatus(stored) && !isTerminalStatus(current.status)) {
                    store.log(
                        `${event.type} ${event.id}: ${embedded.id} is already ${stored}; ` +
                            `refusing to reopen it as ${current.status}`,
                    );
                    return { status: 200, body: { received: true, ignored: 'terminal_status' } };
                }

                const refused = await applySubscription(store, event, current, userId, priceTiers, holder);
                if (refused) {
                    return refused;
                }
                const cancelled = scheduledCancellationOf(event, current);
                if (cancelled) {
                    const notice = cancellationNoticeFrom(event, cancelled, userId);
                    const unrecorded = await recordNotice(store, event, () => store.recordCancellationNotice(notice));
                    if (unrecorded) {
                        return unrecorded;
                    }
                }
                return { status: 200, body: { received: true, applied: 'subscription_upserted' } };
            });
        }

        // invoice.paid and invoice.payment_succeeded join payment_failed rather
        // than being handled apart from it: all three are "an invoice settled
        // one way or the other, read the subscription back and apply it". Their
        // absence was the renewal blip (QA round 4, D6) -- a renewal moves the
        // period end, and until some other event arrived the row still said the
        // old one, so get_entitlements dropped the teacher to free limits in
        // between.
        case 'invoice.paid':
        case 'invoice.payment_succeeded':
        case 'invoice.payment_failed': {
            const invoice = event.data.object as StripeInvoiceLike;
            const subscriptionId =
                idOf(invoice.subscription) ?? idOf(invoice.parent?.subscription_details?.subscription);
            if (!subscriptionId) {
                return { status: 200, body: { received: true, ignored: 'no_subscription' } };
            }
            // Before the lock (decision 70(1)): whoever the database already
            // ties this invoice to. The user the Stripe read resolves is asked
            // again before the write (applySubscription) -- after the lock,
            // where only a duplicate refund some earlier delivery still owed
            // can have run.
            const invoiceCustomer = idOf(invoice.customer);
            const pendingInvoice = await deletionRefusal(store, event, [
                invoiceCustomer ? await store.userIdForCustomer(invoiceCustomer) : null,
                await store.userIdForSubscription(subscriptionId),
            ]);
            if (pendingInvoice) {
                return pendingInvoice;
            }

            return await withSubscriptionLock(store, event, subscriptionId, async (holder) => {
                // Re-read from Stripe rather than trusting the invoice: Stripe
                // decides what the invoice means for the subscription -- past_due,
                // unpaid, or nothing yet on a failure; a moved period end, or a
                // revival out of past_due, on a payment. Same as checkout: a failed
                // read must be retried, not acknowledged.
                const sub = await store.fetchSubscription(subscriptionId);
                if (sub === SUBSCRIPTION_MISSING) {
                    return subscriptionMissing(store, event, subscriptionId);
                }
                if (!sub) {
                    store.log(`${event.type} ${event.id}: subscription ${subscriptionId} not retrievable`);
                    return retryLater(store, event, 'subscription_unavailable');
                }
                const customerId = invoiceCustomer ?? idOf(sub.customer);
                const userId =
                    (await resolveUserId(store, customerId, sub.metadata)) ??
                    (await store.userIdForSubscription(sub.id));
                if (!userId) {
                    return { status: 200, body: { received: true, ignored: 'unknown_user' } };
                }
                // The payer the Stripe read resolved is asked before the
                // write, in applySubscription, as every event's is.
                const refused = await applySubscription(store, event, sub, userId, priceTiers, holder);
                if (refused) {
                    return refused;
                }
                store.log(`${event.type} for ${userId}: subscription now ${sub.status}`);
                return { status: 200, body: { received: true, applied: 'invoice_recorded' } };
            });
        }

        default:
            return { status: 200, body: { received: true, ignored: event.type } };
    }
};
