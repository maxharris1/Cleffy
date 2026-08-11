/**
 * Pure Stripe webhook event handling: idempotency, dispatch, and the mapping
 * from Stripe objects to `subscriptions` rows.
 *
 * Like stripeSignature.ts this module has NO imports, so vitest loads the very
 * same file the Deno function does. All I/O arrives through `WebhookStore`, so
 * the suite drives it with a hand-rolled fake — the same shape as
 * `src/sync/syncEngine.test.ts`'s `FakeApi`.
 */

export type BillingTier = 'free' | 'pro' | 'studio';

/** Statuses that actually grant paid entitlements — must match get_entitlements(). */
const ENTITLING_STATUSES = ['active', 'trialing'];

/**
 * Statuses that end a subscription for good. `past_due` is deliberately absent:
 * Stripe retries payment for days, and get_entitlements already drops the user
 * to free limits meanwhile, so there is no reason to archive their scores while
 * the card issue might still resolve.
 */
const ARCHIVING_STATUSES = ['canceled', 'unpaid', 'incomplete_expired'];

export const isEntitlingStatus = (status: string): boolean => ENTITLING_STATUSES.includes(status);

export const shouldArchiveOnStatus = (status: string): boolean => ARCHIVING_STATUSES.includes(status);

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
}

export interface WebhookStore {
    /** Records the event id. `false` means it was already recorded — a replay. */
    claimEvent: (id: string, type: string) => Promise<boolean>;
    userIdForCustomer: (customerId: string) => Promise<string | null>;
    linkCustomer: (customerId: string, userId: string) => Promise<void>;
    upsertSubscription: (row: SubscriptionUpsert) => Promise<void>;
    /** checkout.session.completed carries only a subscription id, so it must be fetched. */
    fetchSubscription: (subscriptionId: string) => Promise<StripeSubscriptionLike | null>;
    userIdForSubscription: (subscriptionId: string) => Promise<string | null>;
    applyFreeTierArchival: (userId: string) => Promise<void>;
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
 * what keeps Founding Teacher schema-free: it is a second price on the Pro
 * product, so it maps to 'pro' like any other Pro price.
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
const periodEndOf = (sub: StripeSubscriptionLike): string | null => {
    const seconds = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        return null;
    }
    return new Date(seconds * 1000).toISOString();
};

export const subscriptionRowFrom = (
    sub: StripeSubscriptionLike,
    userId: string,
    priceTiers: Record<string, BillingTier>,
): SubscriptionUpsert => {
    const priceId = priceIdOf(sub);
    return {
        stripe_subscription_id: sub.id,
        user_id: userId,
        tier: isEntitlingStatus(sub.status) ? tierForPrice(priceId, priceTiers) : 'free',
        status: sub.status,
        price_id: priceId,
        current_period_end: periodEndOf(sub),
        cancel_at_period_end: sub.cancel_at_period_end === true,
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

const applySubscription = async (
    store: WebhookStore,
    sub: StripeSubscriptionLike,
    userId: string,
    priceTiers: Record<string, BillingTier>,
): Promise<void> => {
    await store.upsertSubscription(subscriptionRowFrom(sub, userId, priceTiers));
    if (shouldArchiveOnStatus(sub.status)) {
        await store.applyFreeTierArchival(userId);
    }
};

/**
 * Returns 200 for anything it understands OR deliberately ignores — a non-2xx
 * makes Stripe retry, which is only useful when we genuinely failed.
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

            const sub = await store.fetchSubscription(subscriptionId);
            if (!sub) {
                store.log(`checkout.session.completed ${event.id}: subscription ${subscriptionId} not retrievable`);
                return { status: 200, body: { received: true, ignored: 'subscription_missing' } };
            }

            await applySubscription(store, sub, userId, priceTiers);
            return { status: 200, body: { received: true, applied: 'subscription_upserted' } };
        }

        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
            const sub = event.data.object as StripeSubscriptionLike;
            const customerId = idOf(sub.customer);
            const userId =
                (await resolveUserId(store, customerId, sub.metadata)) ?? (await store.userIdForSubscription(sub.id));
            if (!userId) {
                store.log(`${event.type} ${event.id}: no user could be resolved`);
                return { status: 200, body: { received: true, ignored: 'unknown_user' } };
            }

            // A delete event's object can still read `active`; the row must not.
            const normalized: StripeSubscriptionLike =
                event.type === 'customer.subscription.deleted' ? { ...sub, status: 'canceled' } : sub;

            await applySubscription(store, normalized, userId, priceTiers);
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
            const sub = await store.fetchSubscription(subscriptionId);
            if (!sub) {
                return { status: 200, body: { received: true, ignored: 'subscription_missing' } };
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
