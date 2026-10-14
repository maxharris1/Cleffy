import { describe, expect, it } from 'vitest';

import {
    type DeletedAccountStripe,
    stopDeletedAccountSubscription,
} from '../../supabase/functions/_shared/deletedAccountBilling';

/**
 * The webhook's last line against billing a deleted account: a subscription
 * whose write hit the user_id FK is cancelled if it can still bill, and only
 * then acknowledged.
 */

const fakeStripe = (statuses: Record<string, string>, failCancel = false) => {
    const canceled: string[] = [];
    const stripe: DeletedAccountStripe = {
        retrieveStatus: async (id) => statuses[id] ?? null,
        cancel: async (id) => {
            if (failCancel) {
                throw new Error('stripe is down');
            }
            canceled.push(id);
            statuses[id] = 'canceled';
        },
    };
    return { stripe, canceled };
};

describe('stopDeletedAccountSubscription', () => {
    it('cancels a subscription that can still bill', async () => {
        const { stripe, canceled } = fakeStripe({ sub_1: 'active' });
        const logs: string[] = [];
        await expect(stopDeletedAccountSubscription('sub_1', 'active', stripe, (m) => logs.push(m))).resolves.toBe(
            'canceled',
        );
        expect(canceled).toEqual(['sub_1']);
        expect(logs[0]).toContain('cancelled');
    });

    it('trusts Stripe over the event: a sibling event may have cancelled it already', async () => {
        const { stripe, canceled } = fakeStripe({ sub_1: 'canceled' });
        await expect(stopDeletedAccountSubscription('sub_1', 'active', stripe, () => undefined)).resolves.toBe(
            'already_ended',
        );
        expect(canceled).toEqual([]);
    });

    it('acknowledges the cancellation’s own event without calling Stripe', async () => {
        const { stripe, canceled } = fakeStripe({});
        for (const status of ['canceled', 'incomplete_expired']) {
            await expect(stopDeletedAccountSubscription('sub_1', status, stripe, () => undefined)).resolves.toBe(
                'already_ended',
            );
        }
        expect(canceled).toEqual([]);
    });

    it('treats a subscription Stripe no longer has as ended', async () => {
        const { stripe } = fakeStripe({});
        await expect(stopDeletedAccountSubscription('sub_gone', 'trialing', stripe, () => undefined)).resolves.toBe(
            'already_ended',
        );
    });

    it('throws when the cancellation fails, so the webhook answers 500 and Stripe retries it', async () => {
        const { stripe } = fakeStripe({ sub_1: 'past_due' }, true);
        await expect(stopDeletedAccountSubscription('sub_1', 'past_due', stripe, () => undefined)).rejects.toThrow(
            'stripe is down',
        );
    });
});
