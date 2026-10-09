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
}

/**
 * What fetchSubscription answers when Stripe says the id does not exist
 * (resource_missing): a subscription from the other mode's account, or a test
 * object since deleted. Distinct from `null` because the right answer differs --
 * a transient failure is retried, a missing object never will be found.
 */
export const SUBSCRIPTION_MISSING = 'missing' as const;

export interface WebhookStore {
    /** Records the event id. `false` means it was already recorded — a replay. */
    claimEvent: (id: string, type: string) => Promise<boolean>;
    userIdForCustomer: (customerId: string) => Promise<string | null>;
    linkCustomer: (customerId: string, userId: string) => Promise<void>;
    upsertSubscription: (row: SubscriptionUpsert) => Promise<void>;
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
     * retryable status.
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

export const subscriptionRowFrom = (
    sub: StripeSubscriptionLike,
    userId: string,
    priceTiers: Record<string, BillingTier>,
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
    sub: StripeSubscriptionLike,
    userId: string,
    priceTiers: Record<string, BillingTier>,
): Promise<void> => {
    await store.upsertSubscription(subscriptionRowFrom(sub, userId, priceTiers));
    if (shouldArchiveOnStatus(sub.status)) {
        await store.applyFreeTierArchival(userId);
    } else if (isEntitlingStatus(sub.status)) {
        await store.restorePlanArchivedScores(userId);
    }
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
        return { status: 200, body: { received: true, duplicate: true } };
    }

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

            await applySubscription(store, sub, userId, priceTiers);
            return { status: 200, body: { received: true, applied: 'subscription_upserted' } };
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated':
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

            await applySubscription(store, current, userId, priceTiers);
            return { status: 200, body: { received: true, applied: 'subscription_upserted' } };
        }

        case 'invoice.payment_failed': {
            const invoice = event.data.object as StripeInvoiceLike;
            const subscriptionId =
                idOf(invoice.subscription) ?? idOf(invoice.parent?.subscription_details?.subscription);
            if (!subscriptionId) {
                return { status: 200, body: { received: true, ignored: 'no_subscription' } };
            }

            // Re-read from Stripe rather than trusting the invoice: Stripe decides
            // whether this failure means past_due, unpaid, or nothing yet.
            // Same as checkout: a failed read must be retried, not acknowledged.
            const sub = await store.fetchSubscription(subscriptionId);
            if (sub === SUBSCRIPTION_MISSING) {
                return subscriptionMissing(store, event, subscriptionId);
            }
            if (!sub) {
                store.log(`invoice.payment_failed ${event.id}: subscription ${subscriptionId} not retrievable`);
                return retryLater(store, event, 'subscription_unavailable');
            }
            const customerId = idOf(invoice.customer) ?? idOf(sub.customer);
            const userId =
                (await resolveUserId(store, customerId, sub.metadata)) ?? (await store.userIdForSubscription(sub.id));
            if (!userId) {
                return { status: 200, body: { received: true, ignored: 'unknown_user' } };
            }

            await applySubscription(store, sub, userId, priceTiers);
            store.log(`invoice.payment_failed for ${userId}: subscription now ${sub.status}`);
            return { status: 200, body: { received: true, applied: 'payment_failed_recorded' } };
        }

        default:
            return { status: 200, body: { received: true, ignored: event.type } };
    }
};
