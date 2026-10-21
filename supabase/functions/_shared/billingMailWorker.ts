import {
    cancellableSubscription,
    cancelLinkMailBudget,
    cancelSecret,
    confirmationMailBudget,
    newToken,
    saveToken,
    sha256Hex,
    userForEmail,
} from './billingCancelStore.ts';
import { emailOfUser, sendBillingEmail, storefrontOrigin } from './billingMail.ts';
import {
    type BudgetedSendDeps,
    deliverCancellationConfirmation,
    deliverPurchaseConfirmation,
    type ConfirmationDeps,
    type Delivery,
    drainBillingMail,
    type DrainSummary,
    OUTBOX_LEASE,
    type OutboxRow,
    sendWithinBudget,
} from './billingOutbox.ts';
import * as billingTerms from './billingTerms.ts';
import { type CancelLinkDeps, type CancelLinkRequest, deliverCancelLink } from './cancelFlow.ts';
import { logError } from './errorReporting.ts';
import { checkRateLimit, refundRateLimit, serviceClient } from './rateLimit.ts';
import { slotForPrice } from './stripe.ts';

/**
 * The Deno wiring of the billing mail outbox (billingOutbox.ts holds the
 * decisions): claiming and settling rows through the RPCs in migration
 * 20261020160200, and the send itself.
 *
 * Drained from three places, all of them safe to overlap (claims are SKIP
 * LOCKED and leased): straight after the webhook or /cancel enqueues something
 * (`drainInBackground`, after the response has gone), and every minute by
 * the billing-mail-outbox function the cron pokes, which is the retry path.
 */

interface OutboxRecord {
    id: string;
    kind: OutboxRow['kind'];
    mode: OutboxRow['mode'];
    payload: Record<string, unknown>;
    attempts: number;
    claim_token: string;
    created_at: string;
}

const admin = () => {
    const client = serviceClient();
    if (!client) {
        throw new Error('Billing is not configured');
    }
    return client;
};

const budgetedSendDeps = (): BudgetedSendDeps => ({
    checkRateLimit,
    refundRateLimit,
    mailBudget: confirmationMailBudget(),
    sendEmail: sendBillingEmail,
});

/**
 * Billing mail sent from a request rather than the outbox (billing-cancel's
 * refund request to support), inside the same budget share as the
 * confirmations. A spent window reads as a failed send, which the cancel page
 * already answers by telling the buyer to write to support themselves.
 */
export const sendBillingEmailWithinBudget = async (
    to: string,
    message: billingTerms.BillingEmail,
    options: { replyTo?: string; tag: string },
): Promise<'sent' | 'failed'> =>
    (await sendWithinBudget(budgetedSendDeps(), to, message, options)).outcome === 'sent' ? 'sent' : 'failed';

const confirmationDeps = (): ConfirmationDeps => ({
    ...budgetedSendDeps(),
    emailOfUser,
    slotForPrice,
    storefrontOrigin,
    terms: billingTerms,
    log: (message) => console.log(message),
});

const cancelLinkDeps = (): CancelLinkDeps => ({
    checkRateLimit,
    refundRateLimit,
    mailBudget: cancelLinkMailBudget(),
    sha256Hex,
    secret: cancelSecret,
    newToken,
    userForEmail,
    cancellableSubscription,
    saveToken,
    sendEmail: sendBillingEmail,
    terms: billingTerms,
    now: () => Date.now(),
    logError: (code, err) => logError('billing-cancel', err, { code }),
});

const deliver = async (row: OutboxRow): Promise<Delivery> => {
    switch (row.kind) {
        case 'purchase_confirmation':
            return deliverPurchaseConfirmation(confirmationDeps(), row);
        case 'cancellation_confirmation':
            return deliverCancellationConfirmation(confirmationDeps(), row);
        case 'cancel_link':
            return deliverCancelLink(cancelLinkDeps(), row.mode, row.payload as unknown as CancelLinkRequest);
        default:
            return { outcome: 'retry', reason: `no deliverer for ${row.kind as string}` };
    }
};

export const drainBillingMailNow = (): Promise<DrainSummary> =>
    drainBillingMail({
        claim: async (limit) => {
            const { data, error } = await admin().rpc('claim_billing_mail', {
                p_limit: limit,
                p_lease: OUTBOX_LEASE,
            });
            if (error) {
                throw new Error(`could not claim billing mail: ${error.message}`);
            }
            return ((data as OutboxRecord[] | null) ?? []).map((record) => ({
                id: record.id,
                kind: record.kind,
                mode: record.mode,
                payload: record.payload,
                attempts: record.attempts,
                claimToken: record.claim_token,
                createdAt: record.created_at,
            }));
        },
        settle: async (row, delivery, retryAfterMs) => {
            const { data, error } = await admin().rpc('settle_billing_mail', {
                p_id: row.id,
                p_claim: row.claimToken,
                p_outcome: delivery.outcome,
                p_error: delivery.outcome === 'sent' ? null : delivery.reason,
                p_retry_after: delivery.outcome === 'retry' ? `${Math.ceil(retryAfterMs / 1000)} seconds` : null,
            });
            if (error) {
                throw new Error(`could not settle billing mail ${row.id}: ${error.message}`);
            }
            return data === true;
        },
        deliver,
        log: (message) => console.log(message),
        logError: (code, err) => logError('billing-mail', err, { code }),
    });

interface EdgeRuntimeLike {
    waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Drains after the response, so nobody waits on Resend -- and, for /cancel, so
 * nothing about whether a mail is sent can show in the answer or its timing.
 * Where waitUntil is missing (an older local runtime) the drain still runs,
 * unawaited; the cron catches anything it does not finish.
 */
export const drainInBackground = (): void => {
    const pending = drainBillingMailNow().catch((err) => logError('billing-mail', err, { code: 'drain_failed' }));
    const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeLike }).EdgeRuntime;
    if (runtime?.waitUntil) {
        runtime.waitUntil(pending);
    }
};
