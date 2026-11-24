import { describe, expect, it } from 'vitest';

import {
    cancelSubscriptionNow,
    type RefundCancelStripe,
    subscriptionForCharge,
} from '../../supabase/functions/_shared/refundCancel';

const stripeError = (code: string) => Object.assign(new Error(code), { type: 'StripeInvalidRequestError', code });

const fakeStripe = (
    invoices: Record<string, unknown> = {},
    paymentInvoices: Record<string, string[]> = {},
    failures: { invoices?: Error; payments?: Error; cancel?: Error } = {},
) => {
    const calls: unknown[][] = [];
    const client: RefundCancelStripe = {
        invoices: {
            retrieve: async (id: string) => {
                calls.push(['invoices.retrieve', id]);
                if (failures.invoices) {
                    throw failures.invoices;
                }
                if (!(id in invoices)) {
                    throw stripeError('resource_missing');
                }
                return invoices[id];
            },
        },
        invoicePayments: {
            list: async (params) => {
                calls.push(['invoicePayments.list', params]);
                if (failures.payments) {
                    throw failures.payments;
                }
                return { data: (paymentInvoices[params.payment.payment_intent] ?? []).map((invoice) => ({ invoice })) };
            },
        },
        subscriptions: {
            cancel: async (id, params, options) => {
                calls.push(['subscriptions.cancel', id, params, options]);
                if (failures.cancel) {
                    throw failures.cancel;
                }
                return { id, status: 'canceled' };
            },
        },
    };
    return { client, calls };
};

describe('subscriptionForCharge', () => {
    const subscriptionInvoice = { id: 'in_1', parent: { subscription_details: { subscription: 'sub_1' } } };

    it('reads the invoice a pre-basil charge names', async () => {
        const { client } = fakeStripe({ in_1: subscriptionInvoice });
        expect(await subscriptionForCharge(client, { id: 'ch_1', invoice: 'in_1' })).toEqual({
            kind: 'subscription',
            subscriptionId: 'sub_1',
        });
    });

    it('finds the invoice through the payment intent on a basil charge', async () => {
        const { client, calls } = fakeStripe({ in_1: subscriptionInvoice }, { pi_1: ['in_1'] });
        expect(await subscriptionForCharge(client, { id: 'ch_1', payment_intent: 'pi_1' })).toEqual({
            kind: 'subscription',
            subscriptionId: 'sub_1',
        });
        expect(calls[0]).toEqual([
            'invoicePayments.list',
            { payment: { type: 'payment_intent', payment_intent: 'pi_1' }, limit: 1 },
        ]);
    });

    it('reads an older invoice that names its subscription directly', async () => {
        const { client } = fakeStripe({ in_1: { id: 'in_1', subscription: { id: 'sub_1' } } });
        expect(await subscriptionForCharge(client, { id: 'ch_1', invoice: { id: 'in_1' } })).toEqual({
            kind: 'subscription',
            subscriptionId: 'sub_1',
        });
    });

    it('answers no_invoice for a charge no invoice was paid by', async () => {
        expect(await subscriptionForCharge(fakeStripe().client, { id: 'ch_1' })).toEqual({ kind: 'no_invoice' });
        expect(await subscriptionForCharge(fakeStripe().client, { id: 'ch_1', payment_intent: 'pi_9' })).toEqual({
            kind: 'no_invoice',
        });
    });

    it('answers no_subscription for a one-off invoice', async () => {
        const { client } = fakeStripe({ in_1: { id: 'in_1', parent: null } });
        expect(await subscriptionForCharge(client, { id: 'ch_1', invoice: 'in_1' })).toEqual({
            kind: 'no_subscription',
        });
    });

    it('answers unavailable when Stripe cannot be read, so the event is retried', async () => {
        const down = new Error('connect ECONNRESET');
        expect(
            await subscriptionForCharge(fakeStripe({}, {}, { invoices: down }).client, { id: 'ch_1', invoice: 'in_1' }),
        ).toEqual({ kind: 'unavailable' });
        expect(
            await subscriptionForCharge(fakeStripe({}, {}, { payments: down }).client, {
                id: 'ch_1',
                payment_intent: 'pi_1',
            }),
        ).toEqual({ kind: 'unavailable' });
    });
});

describe('cancelSubscriptionNow', () => {
    it('cancels immediately, keyed so a retry asks Stripe for the same cancel', async () => {
        const { client, calls } = fakeStripe();
        expect(await cancelSubscriptionNow(client, 'sub_1')).toBe('cancelled');
        expect(calls).toEqual([['subscriptions.cancel', 'sub_1', {}, { idempotencyKey: 'refund-cancel:sub_1' }]]);
    });

    it('sends the same key for every cancel of one subscription, so Stripe applies at most one', async () => {
        const { client, calls } = fakeStripe();
        await cancelSubscriptionNow(client, 'sub_1');
        await cancelSubscriptionNow(client, 'sub_1');
        await cancelSubscriptionNow(client, 'sub_2');
        expect(calls.map((call) => call[3])).toEqual([
            { idempotencyKey: 'refund-cancel:sub_1' },
            { idempotencyKey: 'refund-cancel:sub_1' },
            { idempotencyKey: 'refund-cancel:sub_2' },
        ]);
    });

    it('answers already_ended for a subscription Stripe no longer has', async () => {
        const { client } = fakeStripe({}, {}, { cancel: stripeError('resource_missing') });
        expect(await cancelSubscriptionNow(client, 'sub_1')).toBe('already_ended');
    });

    it('answers failed for anything else, so the event is retried', async () => {
        const { client } = fakeStripe({}, {}, { cancel: new Error('rate limited') });
        expect(await cancelSubscriptionNow(client, 'sub_1')).toBe('failed');
    });
});
