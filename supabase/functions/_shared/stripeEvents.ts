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
}

/** Only the fields this handler reads — not a full mirror of Stripe's type. */
export interface StripeSubscriptionLike {
    id: string;
    status: string;
    cancel_at_period_end?: boolean | null;
    /** A scheduled cancellation (seconds), set from the dashboard or the API. */
    cancel_at?: number | null;
    current_period_end?: number | null;
    customer?: string | { id?: string } | null;
    metadata?: Record<string, string> | null;
    items?: {
        data?: Array<{ price?: { id?: string | null } | null; current_period_end?: number | null } | undefined>;
    } | null;
}

export interface StripeCheckoutSessionLike {
    customer?: string | { id?: string } | null;
    subscription?: string | { id?: string } | null;
    client_reference_id?: string | null;
    metadata?: Record<string, string> | null;
}

export interface StripeInvoiceLike {
    customer?: string | { id?: string } | null;
    subscription?: string | { id?: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id?: string } | null } | null } | null;
}

export interface StripeEventLike {
    id: string;
    type: string;
    data: { object: unknown };
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
 * What upsertSubscription did.
 *
 * `duplicate` is the partial unique index (subscriptions_one_entitling_per_user_mode,
 * migration 20261012120100) refusing a SECOND entitling subscription for this
 * user and Stripe account. The row is deliberately left absent; see the
 * handler's duplicate branch for why nothing is cancelled in Stripe.
 */
export type SubscriptionWriteOutcome = { duplicate: false } | { duplicate: true; otherSubscriptionId: string | null };

export interface WebhookStore {
    /**
     * Takes the claim on an event id. `false` means someone else holds it — a
     * replay of an event already applied, or a delivery genuinely in flight
     * right now. A claim whose invocation died without finishing goes stale
     * after STRIPE_EVENT_CLAIM_STALE_AFTER and is claimable again, which is
     * what stops a dead isolate turning every Stripe retry into `200 duplicate`
     * (QA round 4, D2).
     */
    claimEvent: (id: string, type: string) => Promise<boolean>;
    /**
     * Marks the claim finished, so every later delivery of it is a duplicate
     * rather than a claim waiting to go stale. Called for every outcome that
     * genuinely finished with the event, which is every 2xx this module returns
     * after taking the claim.
     */
    markEventDone: (id: string) => Promise<void>;
    userIdForCustomer: (customerId: string) => Promise<string | null>;
    linkCustomer: (customerId: string, userId: string) => Promise<void>;
    upsertSubscription: (row: SubscriptionUpsert) => Promise<SubscriptionWriteOutcome>;
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
    log: (message: string) => void;
}

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
        tier: isEntitlingStatus(sub.status) ? tierForPrice(priceId, priceTiers) : 'free',
        status: sub.status,
        price_id: priceId,
        current_period_end: ending.periodEnd,
        cancel_at_period_end: ending.cancelling,
        last_event_created_at: lastEventCreatedAt,
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
 * refuses (QA round 4, D1). It is a 200 with no row written, and that is a
 * decision rather than a shrug:
 *
 *  * Stripe is NOT asked to retry. The constraint will refuse the write
 *    identically for the next three days, so retrying only buries the
 *    failures that matter under endpoint-failure alerts.
 *  * the duplicate is NOT cancelled in Stripe from here. Cancelling bills
 *    nobody back and cannot be undone, and nothing in this process can tell
 *    which of two subscriptions the customer meant to have -- the one they
 *    opened first, or the one whose plan they actually wanted. A human reads
 *    the alert, cancels the right one in the dashboard and refunds it.
 *  * the row's ABSENCE is what keeps the money and the product in step:
 *    get_entitlements reads this table, so the customer is entitled by the
 *    subscription that did land and by that one only, exactly as if the
 *    duplicate had never been bought. delete-account is unaffected too --
 *    it lists subscriptions from Stripe, not from here, so a duplicate with
 *    no row is still cancelled when the account goes.
 *
 * What it leaves open, and what the alert is for: nothing reconciles Stripe
 * against this table on a schedule, and the alert's only destination today is
 * the function log. A sweep that compares the two (and a place for it to shout)
 * is the follow-up.
 */
const duplicateEntitling = (
    store: WebhookStore,
    event: StripeEventLike,
    sub: StripeSubscriptionLike,
    userId: string,
    otherSubscriptionId: string | null,
): WebhookResult => {
    store.log(
        `ALERT ${event.type} ${event.id}: user ${userId} would hold two entitling subscriptions ` +
            `(${otherSubscriptionId ?? 'unknown'} is recorded, ${sub.id} was refused as ${sub.status}); ` +
            'the duplicate is NOT recorded and NOT cancelled -- cancel and refund the right one in Stripe',
    );
    return { status: 200, body: { received: true, ignored: 'duplicate_active_subscription' } };
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
): Promise<WebhookResult | null> => {
    const written = await store.upsertSubscription(subscriptionRowFrom(sub, userId, priceTiers, eventStampOf(event)));
    if (written.duplicate) {
        return duplicateEntitling(store, event, sub, userId, written.otherSubscriptionId);
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
 * makes Stripe retry, which is only useful when we genuinely failed. Every
 * non-2xx it returns has already released the event's claim (see retryLater);
 * a THROWN error leaves that to the caller, which releases it the same way.
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
    const fresh = await store.claimEvent(event.id, event.type);
    if (!fresh) {
        store.log(`duplicate event ${event.id} (${event.type}) ignored`);
        // Nothing to mark: the claim belongs to the delivery that took it, and
        // it is that one's job to finish or to release it.
        return { status: 200, body: { received: true, duplicate: true } };
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
            if (customerId) {
                await store.linkCustomer(customerId, userId);
            }

            const subscriptionId = idOf(session.subscription);
            if (!subscriptionId) {
                // A one-off payment, not a subscription checkout.
                return { status: 200, body: { received: true, ignored: 'no_subscription' } };
            }

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

            return (
                (await applySubscription(store, event, sub, userId, priceTiers)) ?? {
                    status: 200,
                    body: { received: true, applied: 'subscription_upserted' },
                }
            );
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

            return (
                (await applySubscription(store, event, current, userId, priceTiers)) ?? {
                    status: 200,
                    body: { received: true, applied: 'subscription_upserted' },
                }
            );
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
            const customerId = idOf(invoice.customer) ?? idOf(sub.customer);
            const userId =
                (await resolveUserId(store, customerId, sub.metadata)) ?? (await store.userIdForSubscription(sub.id));
            if (!userId) {
                return { status: 200, body: { received: true, ignored: 'unknown_user' } };
            }

            const duplicate = await applySubscription(store, event, sub, userId, priceTiers);
            if (duplicate) {
                return duplicate;
            }
            store.log(`${event.type} for ${userId}: subscription now ${sub.status}`);
            return { status: 200, body: { received: true, applied: 'invoice_recorded' } };
        }

        default:
            return { status: 200, body: { received: true, ignored: event.type } };
    }
};
