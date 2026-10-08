/**
 * The webhook's last line against billing a deleted account.
 *
 * delete-account cancels every subscription before it deletes anything and
 * sweeps Stripe again after the auth user is gone (accountDeletion.ts, steps 2
 * and 7). Stripe can still report a subscription for that user afterwards: a
 * Checkout opened from another tab during the deletion and completed after it,
 * or a late sweep that failed. Its write then hits 23503 — the user_id FK on
 * billing_customers / subscriptions, which only ever fails because the auth
 * user no longer exists — and a plain 500 would only have Stripe retry the
 * event for days while the card keeps being charged.
 *
 * So the webhook stops it: anything that can still bill is cancelled
 * immediately, then the event is acknowledged. A failure to cancel is thrown,
 * so the webhook answers 500 and Stripe's retry tries the cancellation again —
 * the one case where retrying for days is exactly right.
 *
 * NO imports, like stripeEvents.ts, so vitest drives this same file.
 */

/** Statuses that can never bill again; matches accountDeletion.ts. */
const ENDED = new Set(['canceled', 'incomplete_expired']);

/** Postgres foreign_key_violation. */
export const FOREIGN_KEY_VIOLATION = '23503';

export interface DeletedAccountStripe {
    /** The subscription's live status, or null when Stripe has no such subscription. */
    retrieveStatus: (subscriptionId: string) => Promise<string | null>;
    /** Immediate cancellation. */
    cancel: (subscriptionId: string) => Promise<void>;
}

/**
 * Called when a subscription write was refused because its user is gone.
 * `reportedStatus` is what the event said; Stripe is asked for the live status
 * before cancelling, because a second event for the same subscription (Stripe
 * sends checkout.session.completed AND customer.subscription.created) may have
 * cancelled it already, and the cancellation's own `deleted` event lands here too.
 */
export const stopDeletedAccountSubscription = async (
    subscriptionId: string,
    reportedStatus: string,
    stripe: DeletedAccountStripe,
    log: (message: string) => void,
): Promise<'canceled' | 'already_ended'> => {
    if (ENDED.has(reportedStatus)) {
        log(`subscription ${subscriptionId} belongs to a deleted account and has ended; ignored`);
        return 'already_ended';
    }
    const live = await stripe.retrieveStatus(subscriptionId);
    if (live === null || ENDED.has(live)) {
        log(`subscription ${subscriptionId} belongs to a deleted account and has ended; ignored`);
        return 'already_ended';
    }
    await stripe.cancel(subscriptionId);
    log(`subscription ${subscriptionId} belonged to a deleted account; cancelled it`);
    return 'canceled';
};
