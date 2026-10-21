import type * as BillingTerms from './billingTerms.ts';
import type { CancellationNotice, PurchaseNotice } from './stripeEvents.ts';
import type { StripeMode } from './stripeMode.ts';

/**
 * Delivering billing mail from the durable outbox (`billing_mail_outbox`,
 * migration 20261020160200) -- the half of Codex findings 3 and 4 on #62 that
 * runs after nobody is waiting on an answer.
 *
 * The webhook and /cancel only WRITE mail down; this sends it. Each row is
 * claimed under an expiring lease, delivered, and settled as one of:
 *
 *  * `sent`  -- it went out;
 *  * `done`  -- handled, nothing to send (a cancel link for an address with no
 *               subscription, an account deleted since the purchase);
 *  * `retry` -- not yet (Resend failed or is unconfigured, the mail budget is
 *               spent, a read failed), due again after a backoff.
 *
 * Nothing is dropped quietly. A confirmation is retried until it goes out, and
 * every retry past ALERT_AFTER_ATTEMPTS logs an ALERT line, which is what the
 * error log watches for; the only confirmation settled unsent is one whose
 * account no longer exists, and that is an ALERT too.
 *
 * NO runtime imports, for the reason checkoutFlow.ts gives: everything doing I/O
 * arrives in `deps`, and billingMailWorker.ts is the Deno wiring.
 */

export type OutboxKind = 'purchase_confirmation' | 'cancellation_confirmation' | 'cancel_link';

export interface OutboxRow {
    id: string;
    kind: OutboxKind;
    mode: StripeMode;
    payload: Record<string, unknown>;
    /** Including the claim that handed this row over. */
    attempts: number;
    claimToken: string;
    createdAt: string;
}

export type Delivery =
    { outcome: 'sent' } | { outcome: 'done'; reason: string } | { outcome: 'retry'; reason: string; afterMs?: number };

/** How long a worker may hold a row before another may take it (claim_billing_mail). */
export const OUTBOX_LEASE = '2 minutes';
/** Rows per claim, and claims per drain: a drain is bounded however much is queued. */
export const OUTBOX_BATCH = 10;
export const OUTBOX_MAX_ROUNDS = 5;
/** Past this many attempts, every further retry of a row is an ALERT. */
export const ALERT_AFTER_ATTEMPTS = 5;

/** One minute, doubling per attempt, at most six hours: Resend down for a day still gets there. */
export const retryDelayMs = (attempts: number): number =>
    Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60_000);

export interface OutboxDeps {
    claim: (limit: number) => Promise<OutboxRow[]>;
    /** False when the lease was taken over meanwhile; the row is then the new holder's. */
    settle: (row: OutboxRow, delivery: Delivery, retryAfterMs: number) => Promise<boolean>;
    deliver: (row: OutboxRow) => Promise<Delivery>;
    log: (message: string) => void;
    logError: (code: string, err: unknown) => void;
}

export interface DrainSummary {
    claimed: number;
    sent: number;
    done: number;
    retried: number;
}

/** Sends what is due. Never throws: a row it could not settle is retaken when its lease runs out. */
export const drainBillingMail = async (deps: OutboxDeps): Promise<DrainSummary> => {
    const summary: DrainSummary = { claimed: 0, sent: 0, done: 0, retried: 0 };
    for (let round = 0; round < OUTBOX_MAX_ROUNDS; round += 1) {
        let rows: OutboxRow[];
        try {
            rows = await deps.claim(OUTBOX_BATCH);
        } catch (err) {
            deps.logError('billing_outbox_claim_failed', err);
            return summary;
        }
        summary.claimed += rows.length;
        for (const row of rows) {
            let delivery: Delivery;
            try {
                delivery = await deps.deliver(row);
            } catch (err) {
                delivery = { outcome: 'retry', reason: err instanceof Error ? err.message : String(err) };
            }
            const retryAfterMs = delivery.outcome === 'retry' ? (delivery.afterMs ?? retryDelayMs(row.attempts)) : 0;
            if (delivery.outcome === 'retry') {
                summary.retried += 1;
                const line = `billing mail ${row.kind} ${row.id}: attempt ${row.attempts} not sent (${delivery.reason})`;
                // A cancel link waiting for the budget is the system working;
                // a confirmation that keeps failing is a human's problem.
                deps.log(row.kind !== 'cancel_link' && row.attempts >= ALERT_AFTER_ATTEMPTS ? `ALERT ${line}` : line);
            } else if (delivery.outcome === 'sent') {
                summary.sent += 1;
            } else {
                summary.done += 1;
            }
            try {
                if (!(await deps.settle(row, delivery, retryAfterMs))) {
                    deps.log(`billing mail ${row.kind} ${row.id}: lease taken over before it was settled`);
                }
            } catch (err) {
                deps.logError('billing_outbox_settle_failed', err);
            }
        }
        if (rows.length < OUTBOX_BATCH) {
            break;
        }
    }
    return summary;
};

/** What the webhook writes down for a purchase: the notice and the versions the buyer consented under. */
export interface PurchaseMail extends PurchaseNotice {
    /** From the consent record; null falls back to the versions this deployment publishes. */
    termsVersion: string | null;
    refundsVersion: string | null;
    /** The consent's amount_minor: the regular price each renewal charges. */
    recurringAmountMinor: number | null;
}

export type CancellationMail = CancellationNotice;

export interface ConfirmationDeps {
    emailOfUser: (userId: string) => Promise<string | null>;
    sendEmail: (
        to: string,
        message: BillingTerms.BillingEmail,
        options: { tag: string },
    ) => Promise<'sent' | 'failed' | 'unconfigured'>;
    slotForPrice: (priceId: string) => BillingTerms.PlanSlot | null;
    storefrontOrigin: (mode: StripeMode) => string;
    terms: Pick<
        typeof BillingTerms,
        | 'purchaseConfirmationEmail'
        | 'cancellationConfirmationEmail'
        | 'PLAN_NAMES'
        | 'PLAN_INTERVALS'
        | 'CURRENCIES'
        | 'LEGAL_VERSIONS'
        | 'PLAN_PRICES'
    >;
    log: (message: string) => void;
}

const sendOutcome = (sent: 'sent' | 'failed' | 'unconfigured'): Delivery =>
    sent === 'sent' ? { outcome: 'sent' } : { outcome: 'retry', reason: `resend ${sent}` };

/**
 * The address, or the answer for a confirmation that has nobody to go to. Read
 * at send time so a changed address gets the mail; a read that FAILS throws,
 * which the drain turns into a retry.
 */
const recipient = async (deps: ConfirmationDeps, row: OutboxRow, userId: string): Promise<string | Delivery> => {
    const email = await deps.emailOfUser(userId);
    if (email) {
        return email;
    }
    deps.log(`ALERT billing mail ${row.kind} ${row.id}: account ${userId} has no address; not sent`);
    return { outcome: 'done', reason: 'no_address' };
};

export const deliverPurchaseConfirmation = async (deps: ConfirmationDeps, row: OutboxRow): Promise<Delivery> => {
    const mail = row.payload as unknown as PurchaseMail;
    const to = await recipient(deps, row, mail.userId);
    if (typeof to !== 'string') {
        return to;
    }
    const slot = mail.priceId ? deps.slotForPrice(mail.priceId) : null;
    const currency = (deps.terms.CURRENCIES as readonly string[]).includes(mail.currency ?? '')
        ? (mail.currency as BillingTerms.Currency)
        : null;
    if (!slot || !currency || mail.amountTotalMinor === null) {
        // A price or currency this deployment does not know is configuration a
        // human can fix, so the mail waits for it rather than going unsent.
        return {
            outcome: 'retry',
            reason: `lacks ${[!slot && 'a known price', !currency && 'a known currency', mail.amountTotalMinor === null && 'an amount'].filter(Boolean).join(', ')}`,
        };
    }
    const message = deps.terms.purchaseConfirmationEmail({
        planName: deps.terms.PLAN_NAMES[slot],
        interval: deps.terms.PLAN_INTERVALS[slot],
        currency,
        amountTotalMinor: mail.amountTotalMinor,
        amountTaxMinor: mail.amountTaxMinor,
        // What the buyer consented to renew at, else this deployment's price
        // for the plan; distinct from today's charge, which a promotion code
        // may have discounted.
        recurringAmountMinor: mail.recurringAmountMinor ?? deps.terms.PLAN_PRICES[slot][currency],
        amountDiscountMinor: mail.amountDiscountMinor ?? null,
        renewsAtMs: mail.renewsAt ? Date.parse(mail.renewsAt) : null,
        purchasedAtMs: Date.parse(mail.purchasedAt),
        origin: deps.storefrontOrigin(row.mode),
        // What the buyer agreed to, not what this deployment publishes now
        // (Codex minor 2 on #62): a policy updated between Checkout and
        // completion must not rewrite the version their email names.
        termsVersion: mail.termsVersion ?? deps.terms.LEGAL_VERSIONS.terms,
        refundsVersion: mail.refundsVersion ?? deps.terms.LEGAL_VERSIONS.refunds,
    });
    return sendOutcome(await deps.sendEmail(to, message, { tag: 'purchase_confirmation' }));
};

export const deliverCancellationConfirmation = async (deps: ConfirmationDeps, row: OutboxRow): Promise<Delivery> => {
    const mail = row.payload as unknown as CancellationMail;
    const to = await recipient(deps, row, mail.userId);
    if (typeof to !== 'string') {
        return to;
    }
    const slot = mail.priceId ? deps.slotForPrice(mail.priceId) : null;
    const message = deps.terms.cancellationConfirmationEmail({
        planName: slot ? deps.terms.PLAN_NAMES[slot] : null,
        cancelledAtMs: Date.parse(mail.cancelledAt),
        endsAtMs: mail.endsAt ? Date.parse(mail.endsAt) : null,
        origin: deps.storefrontOrigin(row.mode),
    });
    return sendOutcome(await deps.sendEmail(to, message, { tag: 'cancellation_confirmation' }));
};

/** The outbox key for a cancellation: one confirmation per subscription per end date. */
export const cancellationMailKey = (notice: CancellationNotice): string =>
    `${notice.subscriptionId}:${notice.endsAt ?? 'open'}`;
