import Stripe from 'npm:stripe@18';

import {
    appOriginFrom,
    modeForOrigin as modeForOriginWith,
    priceTiers as priceTiersWith,
    resolvePrice as resolvePriceWith,
    secretKeyFor as secretKeyForWith,
    servedModes as servedModesWith,
    webhookSecretFor as webhookSecretForWith,
    type StripeMode,
} from './stripeMode.ts';

/**
 * Deno adapter over `stripeMode.ts`.
 *
 * Everything decision-making lives there, import-free, so the vitest suite can
 * load and test the same file Deno runs. All this module adds is the two things
 * only Deno has: `Deno.env` and a Stripe client.
 */

export { MODES, PUBLISHED_PRICES, keyContradictsMode, type PriceCatalog, type StripeMode } from './stripeMode.ts';

const env = (name: string): string | undefined => Deno.env.get(name);

/** Which Stripe account a caller belongs to, or null if the origin is not one of ours. */
export const modeForOrigin = (origin: string | null): StripeMode | null => modeForOriginWith(origin, env);

export const modeForRequest = (req: Request): StripeMode | null => modeForOrigin(req.headers.get('Origin'));

/** The Stripe accounts this deployment serves at all — production serves only live. */
export const servedModes = (): StripeMode[] => servedModesWith(env);

export const secretKeyFor = (mode: StripeMode): string | null => secretKeyForWith(mode, env);

export const webhookSecretFor = (mode: StripeMode): string | null => webhookSecretForWith(mode, env);

export const resolvePrice = (priceId: string, mode: StripeMode): string | null => resolvePriceWith(priceId, mode, env);

export const priceTiers = (mode: StripeMode) => priceTiersWith(mode, env);

export const appOrigin = (req: Request): string => appOriginFrom(req.headers.get('Origin'), env);

/**
 * Expires every Checkout Session the customer still has open, and answers how
 * many there were.
 *
 * Two callers, for two reasons that come to the same thing. delete-account
 * expires them so a session opened before the account went away cannot later be
 * paid for a user who no longer exists. stripe-checkout expires them before it
 * opens another, because a session stays payable for 24 hours and two open
 * sessions are two charges (QA round 4, D1) -- Stripe bills a Checkout Session
 * when it is PAID, which is long after the moment any guard of ours ran.
 *
 * It keeps nothing back. stripe-checkout used to leave alone a session stamped
 * with the idempotency key it was about to reuse, because a double-submit
 * replayed that key and would otherwise have been sent to a page we had just
 * killed. Attempt ids replaced the key's time bucket, so no new attempt can ever
 * reuse an old one's key: the session a returning buyer should get back is now
 * read out of `checkout_attempts` and handed to them BEFORE anything is expired
 * (see checkoutFlow.ts, layer 4), and by the time this runs, every open session
 * is one nobody is being sent to.
 */
export const expireOpenCheckoutSessions = async (stripe: Stripe, customerId: string): Promise<number> => {
    let expired = 0;
    for await (const session of stripe.checkout.sessions.list({
        customer: customerId,
        status: 'open',
        limit: 100,
    })) {
        await stripe.checkout.sessions.expire(session.id);
        expired += 1;
    }
    return expired;
};

/**
 * Every status Stripe holds for this customer's subscriptions -- checkout's
 * layer 3 (QA round 4, D1 follow-up).
 *
 * `status: 'all'` on purpose: the caller decides which statuses mean "already
 * subscribed", and that rule has to match the one applied to our own mirror
 * (holdsRunningSubscription), not Stripe's default of "everything except the
 * ended ones". The page limit is well past any real customer -- a buyer the app
 * allows has at most one -- and reading only the first page is deliberate: a
 * customer with a hundred subscriptions is a reason to refuse, and the statuses
 * that refuse are the common ones.
 */
export const customerSubscriptionStatuses = async (stripe: Stripe, customerId: string): Promise<string[]> => {
    const subscriptions = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    return subscriptions.data.map((subscription) => subscription.status);
};

/** Stripe's answer for an id it has never heard of. */
const isMissing = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'resource_missing';

/**
 * Expires ONE Checkout Session, for the one case where expiring the customer's
 * open sessions would be wrong: stripe-checkout opened a session, lost its lease
 * while the create was in flight, and is about to refuse the buyer (QA round 4,
 * Codex round 2 of #56). That session is an orphan -- the request that took the
 * lease over ran its own expiry before this create returned, so it never saw it
 * -- and that request has a session it IS handing out, which expiring by
 * customer would kill.
 *
 * An id Stripe has never heard of is not an error worth raising: the caller
 * wanted the session unpayable and it is. Everything else throws, including
 * Stripe's refusal to expire a session that is already finished, and the caller
 * logs it rather than failing a response the buyer has already been refused.
 */
export const expireCheckoutSession = async (stripe: Stripe, sessionId: string): Promise<void> => {
    try {
        await stripe.checkout.sessions.expire(sessionId);
    } catch (err) {
        if (isMissing(err)) {
            return;
        }
        throw err;
    }
};

/**
 * A Checkout Session as checkoutFlow.ts reads it back (layer 4), or null when
 * Stripe has no session with that id -- a stored id from the other account, or
 * one old enough that Stripe has forgotten it. Everything else throws, because
 * "could not read" must refuse the checkout rather than look like "nothing
 * there": a session we cannot see is a session we cannot rule out as payable.
 */
export const readCheckoutSession = async (
    stripe: Stripe,
    sessionId: string,
): Promise<{
    status: 'open' | 'complete' | 'expired' | 'other';
    url: string | null;
    subscriptionId: string | null;
} | null> => {
    let session: Stripe.Checkout.Session;
    try {
        session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (err) {
        if (isMissing(err)) {
            return null;
        }
        throw err;
    }
    const status = session.status;
    return {
        status: status === 'open' || status === 'complete' || status === 'expired' ? status : 'other',
        url: session.url ?? null,
        subscriptionId:
            typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null),
    };
};

/** One subscription's status, or null when Stripe has no such subscription. */
export const subscriptionStatusOf = async (stripe: Stripe, subscriptionId: string): Promise<string | null> => {
    try {
        return (await stripe.subscriptions.retrieve(subscriptionId)).status;
    } catch (err) {
        if (isMissing(err)) {
            return null;
        }
        throw err;
    }
};

/**
 * What came of undoing a duplicate, as four outcomes rather than a boolean,
 * because they want three different answers from the webhook:
 *
 *  * `refunded` / `nothing_to_refund` -- done. A duplicate caught while still
 *    trialing has been billed nothing, and there is nothing to hand back.
 *  * `needs_human` -- a paid invoice whose payment this cannot identify. A
 *    retry would read the same invoice and fail the same way, so it is
 *    acknowledged and the alert names it for a human to refund.
 *  * `failed` -- Stripe could not be reached or refused in a way that may not
 *    repeat. That one is worth asking Stripe to redeliver for.
 */
export type RefundOutcome = 'refunded' | 'nothing_to_refund' | 'needs_human' | 'failed';

export interface DuplicateUndone {
    /** Whether the duplicate can still bill. */
    stopped: boolean;
    refund: RefundOutcome;
    /** What happened, in words, for the alert the webhook logs. */
    detail: string;
}

/**
 * The payment behind an invoice, across the API versions Stripe has shipped
 * this in: a bare `payment_intent` / `charge` in the older shape, and a
 * `payments` list whose entries carry the payment intent in the current one.
 * Narrowed by hand because the SDK's type is whichever version it was built
 * for, and this has to keep working across an upgrade of it.
 */
const paymentOf = (invoice: unknown): { paymentIntent: string } | { charge: string } | null => {
    const shape = invoice as {
        payment_intent?: string | { id?: string } | null;
        charge?: string | { id?: string } | null;
        payments?: {
            data?: Array<{ payment?: { payment_intent?: string | { id?: string } | null } | null } | undefined>;
        } | null;
    };
    const idOf = (value: string | { id?: string } | null | undefined): string | null => {
        if (typeof value === 'string') {
            return value.length > 0 ? value : null;
        }
        return typeof value?.id === 'string' ? value.id : null;
    };
    for (const entry of shape.payments?.data ?? []) {
        const intent = idOf(entry?.payment?.payment_intent);
        if (intent) {
            return { paymentIntent: intent };
        }
    }
    const intent = idOf(shape.payment_intent);
    if (intent) {
        return { paymentIntent: intent };
    }
    const charge = idOf(shape.charge);
    return charge ? { charge } : null;
};

/** Stripe codes that mean this payment has already been handed back. */
const ALREADY_REFUNDED = ['charge_already_refunded', 'payment_intent_unexpected_state'];

/** Statuses a subscription bills nothing in, so there is nothing to cancel. */
const STOPPED_STATUSES = ['canceled', 'incomplete_expired'];

/** Stops the duplicate billing, and answers whether it still can. */
const stopDuplicate = async (stripe: Stripe, subscriptionId: string, notes: string[]): Promise<boolean> => {
    try {
        const current = await stripe.subscriptions.retrieve(subscriptionId);
        if (STOPPED_STATUSES.includes(current.status)) {
            notes.push(`already ${current.status}`);
            return true;
        }
        await stripe.subscriptions.cancel(subscriptionId);
        notes.push('cancelled');
        return true;
    } catch (err) {
        if (isMissing(err)) {
            // Stripe has no such subscription: nothing is billing.
            notes.push('no such subscription in Stripe');
            return true;
        }
        notes.push(`could not cancel: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
};

/** Gives back what the duplicate charged, if it charged anything. */
const refundDuplicate = async (stripe: Stripe, subscriptionId: string, notes: string[]): Promise<RefundOutcome> => {
    let paid: Stripe.Invoice | undefined;
    try {
        const invoices = await stripe.invoices.list({ subscription: subscriptionId, limit: 10 });
        paid = invoices.data.find((invoice) => invoice.status === 'paid' && (invoice.amount_paid ?? 0) > 0);
    } catch (err) {
        notes.push(`could not list invoices: ${err instanceof Error ? err.message : String(err)}`);
        return 'failed';
    }
    if (!paid) {
        // A duplicate caught while it was still trialing, or before its first
        // invoice settled: nothing has been taken.
        notes.push('nothing paid to refund');
        return 'nothing_to_refund';
    }
    const payment = paymentOf(paid);
    if (!payment) {
        notes.push(`could not identify the payment behind invoice ${paid.id} -- refund it by hand`);
        return 'needs_human';
    }
    try {
        // Keyed per invoice, so the webhook's retries ask Stripe for the SAME
        // refund rather than a second one.
        const refund = await stripe.refunds.create(
            {
                ...('paymentIntent' in payment
                    ? { payment_intent: payment.paymentIntent }
                    : { charge: payment.charge }),
                reason: 'duplicate',
            },
            { idempotencyKey: `duplicate-refund:${paid.id}` },
        );
        notes.push(`refunded ${refund.id}`);
        return 'refunded';
    } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (typeof code === 'string' && ALREADY_REFUNDED.includes(code)) {
            notes.push('already refunded');
            return 'refunded';
        }
        notes.push(`could not refund: ${err instanceof Error ? err.message : String(err)}`);
        return 'failed';
    }
};

/**
 * Stops a duplicate subscription and gives the money back (QA round 4, D1
 * follow-up).
 *
 * Called by stripe-webhook when the partial unique index refuses a SECOND
 * entitling subscription for one user: that refusal means the double charge the
 * index exists to prevent has already happened in Stripe, and leaving it to a
 * human -- which is what the first round of fixes did -- means the customer
 * keeps being billed until someone reads a log line. The subscription refused is
 * the one stopped: the one already recorded is the one entitling the customer,
 * so ending the newcomer leaves the product and the money agreeing.
 *
 * Both halves are safe to repeat, which matters because the webhook retries a
 * `failed`: a subscription that is already ended is recognised and left alone,
 * and the refund carries an idempotency key per invoice, so Stripe answers a
 * repeat with the original refund instead of making a second one.
 *
 * It never throws. A duplicate it could not undo is still one the alert has to
 * name, and an exception here would lose the alert with it.
 */
export const cancelAndRefundDuplicate = async (stripe: Stripe, subscriptionId: string): Promise<DuplicateUndone> => {
    const notes: string[] = [];
    const stopped = await stopDuplicate(stripe, subscriptionId, notes);
    // The refund is attempted even if the cancel failed: the two are
    // independent, and getting the customer's money back is the half they
    // notice. A failed cancel asks for a redelivery, which repeats both.
    const refund = await refundDuplicate(stripe, subscriptionId, notes);
    return { stopped, refund, detail: notes.join('; ') };
};

const clients = new Map<StripeMode, Stripe | null>();

export const stripeClient = (mode: StripeMode): Stripe | null => {
    const cached = clients.get(mode);
    if (cached !== undefined) {
        return cached;
    }
    const key = secretKeyFor(mode);
    if (!key) {
        // Either unset, or set to a key belonging to the other mode. Both are
        // configuration errors the caller must fail on rather than work around.
        console.error(`no usable ${mode}-mode Stripe secret key; billing is not configured for ${mode}`);
    }
    const client = key
        ? new Stripe(key, {
              // Deno has no node:http — route the SDK through fetch instead.
              httpClient: Stripe.createFetchHttpClient(),
          })
        : null;
    clients.set(mode, client);
    return client;
};
