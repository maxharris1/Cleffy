import type { ChargeSubscription, ImmediateCancel, StripeChargeLike } from './stripeEvents.ts';

export interface RefundCancelStripe {
    invoices: { retrieve: (id: string) => Promise<unknown> };
    invoicePayments: {
        list: (params: {
            payment: { type: 'payment_intent'; payment_intent: string };
            limit: number;
        }) => Promise<{ data: Array<{ invoice?: unknown }> }>;
    };
    subscriptions: {
        cancel: (id: string, params: Record<string, never>, options: { idempotencyKey: string }) => Promise<unknown>;
    };
}

type Ref = string | { id?: unknown } | null | undefined;

const idOf = (value: unknown): string | null => {
    const ref = value as Ref;
    if (typeof ref === 'string') {
        return ref.length > 0 ? ref : null;
    }
    return typeof ref?.id === 'string' && ref.id.length > 0 ? ref.id : null;
};

const isMissing = (err: unknown): boolean => (err as { code?: unknown } | null)?.code === 'resource_missing';

/**
 * API version basil dropped `invoice` from Charge, so a current payload is
 * traced through its payment intent's invoice payment. An endpoint pinned to an
 * older version still names the invoice, which is read first.
 */
const invoiceIdOf = async (stripe: RefundCancelStripe, charge: StripeChargeLike): Promise<string | null> => {
    const named = idOf(charge.invoice);
    if (named) {
        return named;
    }
    const paymentIntent = idOf(charge.payment_intent);
    if (!paymentIntent) {
        return null;
    }
    const payments = await stripe.invoicePayments.list({
        payment: { type: 'payment_intent', payment_intent: paymentIntent },
        limit: 1,
    });
    return idOf(payments.data[0]?.invoice);
};

export const subscriptionForCharge = async (
    stripe: RefundCancelStripe,
    charge: StripeChargeLike,
): Promise<ChargeSubscription> => {
    try {
        const invoiceId = await invoiceIdOf(stripe, charge);
        if (!invoiceId) {
            return { kind: 'no_invoice' };
        }
        const invoice = (await stripe.invoices.retrieve(invoiceId)) as {
            subscription?: Ref;
            parent?: { subscription_details?: { subscription?: Ref } | null } | null;
        };
        const subscriptionId = idOf(invoice.subscription) ?? idOf(invoice.parent?.subscription_details?.subscription);
        return subscriptionId ? { kind: 'subscription', subscriptionId } : { kind: 'no_subscription' };
    } catch (err) {
        if (isMissing(err)) {
            return { kind: 'no_invoice' };
        }
        console.error(`could not trace charge ${charge.id} to its invoice:`, err);
        return { kind: 'unavailable' };
    }
};

export const cancelSubscriptionNow = async (
    stripe: RefundCancelStripe,
    subscriptionId: string,
): Promise<ImmediateCancel> => {
    try {
        await stripe.subscriptions.cancel(subscriptionId, {}, { idempotencyKey: `refund-cancel:${subscriptionId}` });
        return 'cancelled';
    } catch (err) {
        if (isMissing(err)) {
            return 'already_ended';
        }
        console.error(`could not cancel subscription ${subscriptionId} after its refund:`, err);
        return 'failed';
    }
};
