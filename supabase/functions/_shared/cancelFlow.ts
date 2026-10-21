import type { Delivery, SendResult } from './billingOutbox.ts';
import type * as BillingTerms from './billingTerms.ts';
import type { StripeMode } from './stripeMode.ts';

/**
 * Cancelling a subscription without signing in (launch packet item 19): the
 * footer's "Cancel subscription" leads to /cancel, which asks for an email
 * address, mails a one-time link to it, and that link opens a page with a
 * "Cancel now" button -- plus an optional "request my 14-day refund" box that
 * emails support@. California's BPC §17602(d) and New York's GBL §527-a want
 * cancellation online, as easy as the purchase; a buyer locked out of their
 * account must still be able to stop the charges.
 *
 * Three actions, one function (`billing-cancel`, verify_jwt = false):
 *
 *  * `start`  {email}          -> 200 {sent: true}, ALWAYS the same answer
 *  * `peek`   {token}          -> what the link would cancel, or 404
 *  * `cancel` {token, refund}  -> cancels at period end, spends the link
 *
 * `start` answers identically whether or not the address has an account or a
 * subscription, so the form is not a way to learn who subscribes -- and it
 * does so by not knowing (Codex finding 4 on #62). It writes every well-formed
 * address into the billing mail outbox and answers; the lookup, the limits and
 * the send happen afterwards in `deliverCancelLink`, run by the outbox worker
 * once the response has gone. The answer used to be decided after the lookup,
 * so a spent mail budget or a failed send answered 503 for a subscriber and
 * 200 for everyone else, and the time the lookup and send took showed too.
 * Now every address costs the same one insert and gets the same 200; a link
 * the budget holds back is queued and goes out when the window reopens.
 *
 * What stops it being a way to spam strangers: mail only goes to an address
 * that already holds a running subscription with us, and three limits sit in
 * front of it -- per IP (here), per recipient and the project's share of the
 * mail budget (`billingCancelLink` in mailBudget.ts), both in the worker.
 *
 * Cancelling is `cancel_at_period_end`, exactly what the Customer Portal does:
 * the buyer keeps what they paid for, nothing is refunded automatically, and
 * the webhook mirrors the change and sends the cancellation confirmation the
 * same way for both routes (stripeEvents.ts scheduledCancellationOf).
 *
 * NO runtime imports, for the reason checkoutFlow.ts gives.
 */

/**
 * How long a cancel link works, counted from when it was asked for. The
 * database sets it, once, on the outbox row (`link_expires_at`, migration
 * 20261020160300 -- an hour after `created_at`); this is the same hour, for
 * the tests that hold the two together.
 */
export const CANCEL_LINK_TTL_MS = 60 * 60_000;

/**
 * The least of a link's hour that must be left, on the DATABASE's clock, for
 * it to be sent (Codex round 5 on #62, decision 30): save_cancel_link_token_v2
 * (migrations 20261020160400 and 20261020160500) refuses below it and answers how many seconds
 * are left, and the send is decided on that answer, never on this function's
 * own clock -- which may be behind. What it leaves covers the send itself.
 */
export const CANCEL_LINK_SEND_MARGIN_S = 120;

export const CANCEL_LIMITS = {
    startPerIp: { limit: 5, windowMs: 60 * 60_000 },
    startPerRecipient: { limit: 3, windowMs: 60 * 60_000 },
    tokenPerIp: { limit: 30, windowMs: 10 * 60_000 },
} as const;

/** The subscription statuses a buyer can still cancel: anything that might charge again. */
export const CANCELLABLE_STATUSES = ['active', 'trialing', 'past_due'];

export const CANCEL_ERRORS = {
    badEmail: { error: 'Enter the email address you use for Cleffy.', code: 'invalid_email' },
    linkInvalid: {
        error: 'This cancellation link has expired or has already been used. Ask for a new one below.',
        code: 'link_invalid',
    },
    nothingToCancel: {
        error: 'There is no active subscription on this account to cancel.',
        code: 'nothing_to_cancel',
    },
    unavailable: { error: 'We could not reach our billing system. Please try again in a minute.', code: 'unavailable' },
    tooMany: { error: 'Too many attempts. Please wait a few minutes and try again.', code: 'rate_limited' },
} as const;

export interface CancellableSubscription {
    subscriptionId: string;
    priceId: string | null;
    status: string;
    /** End of the paid period (ISO). */
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
}

/**
 * The subscription as STRIPE holds it right now, which is what the link acts on
 * and reports (Codex finding 2 on #62). The `subscriptions` mirror is only as
 * fresh as the last webhook: a buyer who resumed in the portal a moment ago is
 * still `cancelAtPeriodEnd` there, and a "Cancel now" that believed it would
 * skip Stripe and promise a cancellation Stripe was not going to make.
 */
export interface LiveSubscription {
    status: string;
    /** cancel_at_period_end, or a cancel_at date set some other way. */
    cancelling: boolean;
    /** When access ends if it is cancelling, else when the paid period does (ISO). */
    endsAt: string | null;
}

export interface StoredCancelToken {
    userId: string;
    mode: StripeMode;
    expiresAt: string;
    usedAt: string | null;
}

type Gate = { ok: true } | { ok: false; retryAfterSec: number };

export interface MailWindow {
    limit: number;
    windowMs: number;
}

/** What /cancel writes into the outbox for an address: the lookup still to make, and where to link. */
export interface CancelLinkRequest {
    email: string;
    /** The storefront the request came from, for the link. */
    origin: string;
}

/**
 * The outbox row's lease and the link's expiry, as claim_billing_mail handed
 * them over: the token is saved under the lease, with the row's expiry.
 */
export interface CancelLinkLease {
    claimToken: string;
    /** billing_mail_outbox.link_expires_at (ISO), fixed when the request was written down. */
    linkExpiresAt: string | null;
}

/** What saving a link's token answered (save_cancel_link_token_v2). */
export interface SaveTokenResult {
    answer:
        /** Stored -- now, or by an earlier attempt at this row, whose expiry and used_at stand. */
        | 'saved'
        /** Under CANCEL_LINK_SEND_MARGIN_S left: nothing saved, the row settled, nothing to send. */
        | 'expired'
        /** This link, or its request, was deleted before: nothing saved, the row settled, nothing to send. */
        | 'spent'
        /** This worker no longer holds the row's lease: it must not send. */
        | 'not_held';
    /** What is left of the link's hour, in seconds, on the database's clock after the row's lock. */
    remainingSeconds: number;
}

/** Resend, with an Idempotency-Key that is the same on every attempt at one mail (resendDelivery.ts). */
type SendEmail = (
    to: string,
    message: BillingTerms.BillingEmail,
    options: { replyTo?: string; tag: string; idempotencyKey: string },
) => Promise<SendResult>;

/** resendDelivery.ts resendIdempotencyKey, handed in so this module has no runtime imports. */
type IdempotencyKey = (outbox: string, rowId: string) => string;

/** The outbox name in a cancel link's Resend key: billingOutbox.ts BILLING_OUTBOX_KEY, the row's own key. */
const BILLING_OUTBOX_KEY = 'billing-outbox';
/** One refund request per spent link: keyed by the link's stored hash, never the address. */
const REFUND_REQUEST_KEY = 'billing-refund-request';

/** What delivering a queued link needs; billingMailWorker.ts wires it. */
export interface CancelLinkDeps {
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    refundRateLimit: (key: string) => Promise<void>;
    /** mailLimit('billingCancelLink', …) from mailBudget.ts. */
    mailBudget: { hour: MailWindow; day: MailWindow };
    /** SHA-256, lower-case hex. */
    sha256Hex: (value: string) => Promise<string>;
    /** Server-side pepper for the per-recipient limiter key, so the rate table holds no address. */
    secret: () => string | null;
    /**
     * The link's token for one outbox row, from the secret and the row id
     * (billingCancelStore.ts cancelLinkToken): the same on every retry, so a
     * retry's email is byte-identical and Resend can answer it under the
     * row's Idempotency-Key without sending a second.
     */
    linkToken: (secret: string, rowId: string) => Promise<string>;
    userForEmail: (email: string) => Promise<string | null>;
    cancellableSubscription: (userId: string, mode: StripeMode) => Promise<CancellableSubscription | null>;
    /**
     * Saves the token's hash for its outbox row, with the row's expiry, under
     * the row's lease. A token an earlier attempt saved is left exactly as it
     * is: its expiry is never moved and its used_at never touched. Answers how
     * long the link has left on the database's clock, which decides the send.
     */
    saveToken: (token: {
        hash: string;
        userId: string;
        outboxId: string;
        claimToken: string;
    }) => Promise<SaveTokenResult>;
    sendEmail: SendEmail;
    idempotencyKey: IdempotencyKey;
    terms: Pick<typeof BillingTerms, 'cancelLinkEmail' | 'BILLING_PATHS'>;
    now: () => number;
    logError: (code: string, err: unknown) => void;
}

export interface CancelDeps {
    json: (body: unknown, status?: number) => Response;
    options: () => Response;
    clientKey: (req: Request) => string;
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    modeForRequest: (req: Request) => StripeMode | null;
    appOrigin: (req: Request) => string;
    /** SHA-256, lower-case hex. */
    sha256Hex: (value: string) => Promise<string>;
    /** Writes a link request into billing_mail_outbox. Throws when it cannot. */
    queueCancelLink: (request: CancelLinkRequest, mode: StripeMode) => Promise<void>;
    /** Sends what is queued, after the response (billingMailWorker.ts drainInBackground). */
    sendQueued: () => void;
    emailOfUser: (userId: string) => Promise<string | null>;
    cancellableSubscription: (userId: string, mode: StripeMode) => Promise<CancellableSubscription | null>;
    /** Earliest subscription this account ever started in this mode (ms), for the refund window. */
    firstPurchaseAt: (userId: string, mode: StripeMode) => Promise<number | null>;
    readToken: (hash: string) => Promise<StoredCancelToken | null>;
    /** Marks the token used if it still is not; false when another request got there first. */
    consumeToken: (hash: string, nowIso: string) => Promise<boolean>;
    /** Stripe's own copy of the subscription; null when Stripe has no such subscription. */
    liveSubscription: (subscriptionId: string, mode: StripeMode) => Promise<LiveSubscription | null>;
    /**
     * Stripe: cancel_at_period_end = true. Answers with the subscription as the
     * update left it, which is what decides whether the buyer is told it worked.
     */
    cancelAtPeriodEnd: (subscriptionId: string, mode: StripeMode) => Promise<LiveSubscription>;
    sendEmail: SendEmail;
    idempotencyKey: IdempotencyKey;
    terms: Pick<typeof BillingTerms, 'refundRequestEmail' | 'withinRefundWindow' | 'TRADER'>;
    planNameForPrice: (priceId: string | null) => string | null;
    now: () => number;
    logError: (code: string, err: unknown) => void;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const normalizeEmail = (value: unknown): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const email = value.trim().toLowerCase();
    return email.length <= 254 && EMAIL.test(email) ? email : null;
};

/** `a•••@example.com` -- enough for the buyer to recognise, too little to harvest. */
export const maskEmail = (email: string): string => {
    const [local = '', domain = ''] = email.split('@');
    return `${local.slice(0, 1)}•••@${domain}`;
};

const tooMany = (deps: CancelDeps, retryAfterSec: number) =>
    deps.json({ ...CANCEL_ERRORS.tooMany, retryAfterSec }, 429);

const startCancel = async (req: Request, deps: CancelDeps, body: Record<string, unknown>): Promise<Response> => {
    // Everything this function does before answering is the same for every
    // address: a per-IP limit, a format check, and one insert. Nothing that
    // depends on whether the address subscribes -- the lookup, the per-recipient
    // limit, the mail budget, the send -- runs until the answer has gone.
    const ipGate = await deps.checkRateLimit(
        `billing-cancel:start:ip:${deps.clientKey(req)}`,
        CANCEL_LIMITS.startPerIp.limit,
        CANCEL_LIMITS.startPerIp.windowMs,
    );
    if (!ipGate.ok) {
        return tooMany(deps, ipGate.retryAfterSec);
    }
    const email = normalizeEmail(body.email);
    if (!email) {
        return deps.json(CANCEL_ERRORS.badEmail, 400);
    }
    const mode = deps.modeForRequest(req);
    if (!mode) {
        return deps.json({ error: 'Unrecognised origin', code: 'unknown_origin' }, 400);
    }
    try {
        await deps.queueCancelLink({ email, origin: deps.appOrigin(req) }, mode);
    } catch (err) {
        // The one failure we cannot hide, and it does not depend on the address.
        deps.logError('cancel_link_queue_failed', err);
        return deps.json(CANCEL_ERRORS.unavailable, 503);
    }
    deps.sendQueued();
    return deps.json({ sent: true });
};

/** What a cancel link past its expiry is settled as: never sent, never tried again. */
const EXPIRED: Delivery = { outcome: 'expired', reason: 'expired before delivery' };
/** A link whose token, or whose request, was deleted before: never sent again (migration 20261020160400). */
const SPENT: Delivery = { outcome: 'expired', reason: 'cancel link already spent or removed' };

/**
 * The worker's half of `start`: decide whether a queued request gets a link,
 * and send it. Runs from the billing mail outbox, so its outcome is never part
 * of any answer the person typing the address sees.
 *
 *  * `done`  -- no account, no running subscription, or a recipient already
 *               sent their share of links this hour: nothing to send, and the
 *               request (and the address in it) is deleted;
 *  * `retry` -- the mail budget is spent, the lookup failed, Resend refused
 *               the send, or Resend may have taken it without our hearing
 *               back: queued, and sent when it can be. Every limit counted on
 *               the way is handed back when nothing can have gone out; when
 *               something may have (`unknown`), the mail budget stays spent
 *               (Codex round 3, new major on #62) and the retry carries the
 *               same Idempotency-Key and the same link, so it is not a second
 *               email;
 *  * `expired` -- the link's hour, counted from when it was asked for, ran out
 *               before it could go (Codex round 4 on #62), or the database
 *               says less than CANCEL_LINK_SEND_MARGIN_S of it is left, or the
 *               link was spent and deleted before (Codex round 5): nothing is
 *               sent, the row is settled for good, and what earlier attempts
 *               reserved stays reserved -- one of them may have reached
 *               Resend, and a reservation is only handed back when nothing
 *               can have gone;
 *  * `sent`  -- the row's one-time link went out.
 */

export const deliverCancelLink = async (
    deps: CancelLinkDeps,
    mode: StripeMode,
    request: CancelLinkRequest,
    /** The billing_mail_outbox row: what the link's token and the Resend key derive from. */
    rowId: string,
    lease: CancelLinkLease,
): Promise<Delivery> => {
    // Before anything is counted or looked up: an expired link is never
    // emailed, and its row is never tried again. A row without an expiry is
    // one nobody can say is still good, so it is treated the same. This
    // clock may only ever refuse early; whether the link is sent is the
    // database's answer below.
    const expiresAtMs = Date.parse(lease.linkExpiresAt ?? '');
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= deps.now()) {
        return EXPIRED;
    }
    const secret = deps.secret();
    if (!secret) {
        deps.logError('cancel_secret_missing', new Error('no secret for the recipient limiter'));
        return { outcome: 'retry', reason: 'no limiter secret' };
    }
    const email = normalizeEmail(request.email);
    if (!email) {
        return { outcome: 'done', reason: 'invalid_email' };
    }

    // Counted as it goes, and handed back on every way out that did not send.
    const counted: string[] = [];
    const handBack = async () => {
        await Promise.all(counted.map((key) => deps.refundRateLimit(key).catch(() => undefined)));
    };

    const recipientKey = `billing-cancel:start:to:${await deps.sha256Hex(`${secret}:${email}`)}`;
    const recipientGate = await deps.checkRateLimit(
        recipientKey,
        CANCEL_LIMITS.startPerRecipient.limit,
        CANCEL_LIMITS.startPerRecipient.windowMs,
    );
    if (!recipientGate.ok) {
        // A link is already on its way to this address.
        return { outcome: 'done', reason: 'recipient_limited' };
    }
    counted.push(recipientKey);

    let userId: string | null;
    let subscription: CancellableSubscription | null;
    try {
        userId = await deps.userForEmail(email);
        subscription = userId ? await deps.cancellableSubscription(userId, mode) : null;
    } catch (err) {
        await handBack();
        deps.logError('cancel_lookup_failed', err);
        return { outcome: 'retry', reason: 'lookup failed' };
    }
    if (!userId || !subscription) {
        await handBack();
        return { outcome: 'done', reason: 'no_subscription' };
    }

    // The project's share of the mail budget. Spent, the link waits in the
    // outbox for the window to reopen rather than being refused -- which is
    // what used to show in the answer.
    for (const [key, window] of [
        ['billing-cancel:global', deps.mailBudget.hour],
        ['billing-cancel:global-day', deps.mailBudget.day],
    ] as const) {
        const gate = await deps.checkRateLimit(key, window.limit, window.windowMs);
        if (!gate.ok) {
            await handBack();
            deps.logError('cancel_mail_budget_reached', new Error(`${key} is spent`));
            return {
                outcome: 'retry',
                reason: 'mail budget spent',
                afterMs: Math.max(60, gate.retryAfterSec) * 1000,
            };
        }
        counted.push(key);
    }

    // Derived from the row, so every retry mails the same link, and saved with
    // the row's expiry -- fixed when the link was asked for, never refreshed
    // by a retry (Codex round 4 on #62): a link that waited is good for what
    // is left of its hour, and the email says until when.
    let token: string;
    let saved: SaveTokenResult;
    try {
        token = await deps.linkToken(secret, rowId);
        saved = await deps.saveToken({
            hash: await deps.sha256Hex(token),
            userId,
            outboxId: rowId,
            claimToken: lease.claimToken,
        });
    } catch (err) {
        await handBack();
        deps.logError('cancel_token_save_failed', err);
        return { outcome: 'retry', reason: 'token not saved' };
    }
    if (saved.answer === 'not_held') {
        // Another worker holds the row now and sends it under the same key.
        await handBack();
        return { outcome: 'retry', reason: 'lease taken over' };
    }
    // Every other refusal keeps what this attempt reserved, as for every
    // attempt at a row whose earlier outcome may be unknown.
    if (saved.answer === 'spent') {
        return SPENT;
    }
    // The final send decision: the database's count of the seconds left,
    // read on its clock once it held the row (Codex round 5 on #62). This
    // function's clock is not consulted -- behind, it would send a link the
    // database has already called expired.
    if (saved.answer !== 'saved' || saved.remainingSeconds < CANCEL_LINK_SEND_MARGIN_S) {
        return EXPIRED;
    }
    const link = `${request.origin}${deps.terms.BILLING_PATHS.cancel}?token=${encodeURIComponent(token)}`;
    const sent = await deps.sendEmail(email, deps.terms.cancelLinkEmail(link, expiresAtMs), {
        tag: 'cancel_link',
        idempotencyKey: deps.idempotencyKey(BILLING_OUTBOX_KEY, rowId),
    });
    if (sent.outcome === 'sent') {
        return { outcome: 'sent' };
    }
    if (sent.outcome === 'rejected') {
        await handBack();
        deps.logError('cancel_link_not_sent', new Error(`rejected: ${sent.reason}`));
        return {
            outcome: 'retry',
            reason: `resend rejected: ${sent.reason}`,
            ...(sent.retryAfterMs !== undefined ? { afterMs: Math.max(60_000, sent.retryAfterMs) } : {}),
        };
    }
    // `unknown`: the link may be on its way. The mail budget keeps it -- each
    // attempt reserves its own place, as billingOutbox.ts sendWithinBudget
    // explains, so a retry that does send is counted in its own window. The
    // per-recipient count is handed back: it limits links to an address, this
    // row can only ever be one (same key, same link), and its retry counts it
    // again; kept, a few lost answers would use up the address's hour and
    // drop the row as `recipient_limited` before its link ever went.
    await deps.refundRateLimit(recipientKey).catch(() => undefined);
    deps.logError('cancel_link_unknown', new Error(`unknown: ${sent.reason}`));
    return { outcome: 'retry', reason: `resend unknown: ${sent.reason}`, uncertain: true };
};

/** The token's row, if it can still be used. */
const liveToken = async (
    deps: CancelDeps,
    token: unknown,
): Promise<{ hash: string; row: StoredCancelToken } | null | 'error'> => {
    if (typeof token !== 'string' || token.length < 16 || token.length > 200) {
        return null;
    }
    try {
        const hash = await deps.sha256Hex(token);
        const row = await deps.readToken(hash);
        if (!row || row.usedAt !== null || Date.parse(row.expiresAt) <= deps.now()) {
            return null;
        }
        return { hash, row };
    } catch (err) {
        deps.logError('cancel_token_read_failed', err);
        return 'error';
    }
};

interface Resolved {
    hash: string;
    row: StoredCancelToken;
    email: string | null;
    subscription: CancellableSubscription | null;
    firstPurchaseAt: number | null;
}

const resolveToken = async (deps: CancelDeps, token: unknown): Promise<Resolved | Response> => {
    const live = await liveToken(deps, token);
    if (live === 'error') {
        return deps.json(CANCEL_ERRORS.unavailable, 503);
    }
    if (!live) {
        return deps.json(CANCEL_ERRORS.linkInvalid, 404);
    }
    try {
        const [email, mirrored, firstPurchaseAt] = await Promise.all([
            deps.emailOfUser(live.row.userId),
            deps.cancellableSubscription(live.row.userId, live.row.mode),
            deps.firstPurchaseAt(live.row.userId, live.row.mode),
        ]);
        // The mirror only says WHICH subscription; everything the page shows
        // and the button acts on is read back from Stripe. A subscription
        // Stripe has ended (or no longer has) is nothing to cancel, whatever
        // the mirror still says.
        let subscription: CancellableSubscription | null = null;
        if (mirrored) {
            const current = await deps.liveSubscription(mirrored.subscriptionId, live.row.mode);
            if (current && CANCELLABLE_STATUSES.includes(current.status)) {
                subscription = {
                    ...mirrored,
                    status: current.status,
                    periodEnd: current.endsAt ?? mirrored.periodEnd,
                    cancelAtPeriodEnd: current.cancelling,
                };
            }
        }
        return { ...live, email, subscription, firstPurchaseAt };
    } catch (err) {
        deps.logError('cancel_lookup_failed', err);
        return deps.json(CANCEL_ERRORS.unavailable, 503);
    }
};

const summaryOf = (deps: CancelDeps, resolved: Resolved) => ({
    email: resolved.email ? maskEmail(resolved.email) : null,
    plan: deps.planNameForPrice(resolved.subscription?.priceId ?? null),
    status: resolved.subscription?.status ?? null,
    periodEnd: resolved.subscription?.periodEnd ?? null,
    alreadyCancelling: resolved.subscription?.cancelAtPeriodEnd ?? false,
    refundEligible: deps.terms.withinRefundWindow(resolved.firstPurchaseAt, deps.now()),
});

const peekCancel = async (deps: CancelDeps, body: Record<string, unknown>): Promise<Response> => {
    const resolved = await resolveToken(deps, body.token);
    if (resolved instanceof Response) {
        return resolved;
    }
    if (!resolved.subscription) {
        return deps.json(CANCEL_ERRORS.nothingToCancel, 404);
    }
    return deps.json(summaryOf(deps, resolved));
};

const confirmCancel = async (deps: CancelDeps, body: Record<string, unknown>): Promise<Response> => {
    const resolved = await resolveToken(deps, body.token);
    if (resolved instanceof Response) {
        return resolved;
    }
    const subscription = resolved.subscription;
    if (!subscription) {
        return deps.json(CANCEL_ERRORS.nothingToCancel, 404);
    }

    // Stripe first, the token after: a Stripe failure leaves the link usable for
    // a retry, and setting cancel_at_period_end twice is harmless. The token's
    // conditional update then decides which of two racing clicks sends the
    // refund request, so support hears about it once.
    //
    // `subscription` is Stripe's live copy (resolveToken), so "already
    // cancelling" is Stripe's answer and not the mirror's. And success is only
    // reported when Stripe's answer to the update SAYS cancelling: a buyer told
    // "cancelled" while Stripe is still going to renew is the one outcome this
    // page must never produce.
    let endsAt: string | null = subscription.periodEnd;
    if (!subscription.cancelAtPeriodEnd) {
        let updated: LiveSubscription;
        try {
            updated = await deps.cancelAtPeriodEnd(subscription.subscriptionId, resolved.row.mode);
        } catch (err) {
            deps.logError('cancel_stripe_failed', err);
            return deps.json(CANCEL_ERRORS.unavailable, 502);
        }
        if (!updated.cancelling) {
            deps.logError(
                'cancel_not_confirmed',
                new Error(`Stripe did not confirm the cancellation of ${subscription.subscriptionId}`),
            );
            return deps.json(CANCEL_ERRORS.unavailable, 502);
        }
        endsAt = updated.endsAt ?? endsAt;
    }

    const cancelledAt = new Date(deps.now()).toISOString();
    let first: boolean;
    try {
        first = await deps.consumeToken(resolved.hash, cancelledAt);
    } catch (err) {
        // Cancelled in Stripe already; only the link stays usable a little longer.
        deps.logError('cancel_token_consume_failed', err);
        first = false;
    }

    const wantsRefund = body.requestRefund === true;
    const refundEligible = deps.terms.withinRefundWindow(resolved.firstPurchaseAt, deps.now());
    let refundRequested = false;
    if (first && wantsRefund && refundEligible && resolved.email) {
        const sent = await deps.sendEmail(
            deps.terms.TRADER.supportEmail,
            deps.terms.refundRequestEmail({
                userId: resolved.row.userId,
                email: resolved.email,
                subscriptionId: subscription.subscriptionId,
                planName: deps.planNameForPrice(subscription.priceId),
                mode: resolved.row.mode,
                firstPurchaseAtMs: resolved.firstPurchaseAt,
                requestedAtMs: deps.now(),
            }),
            // Keyed by this link's hash: one request per spent link, never
            // the address. Resend answers a repeat under it without mailing
            // support again.
            {
                replyTo: resolved.email,
                tag: 'refund_request',
                idempotencyKey: deps.idempotencyKey(REFUND_REQUEST_KEY, resolved.hash),
            },
        );
        // Only a send Resend confirmed counts. On `unknown` support may have
        // it, but the buyer is still told to write in: a second note to
        // support is harmless, a 14-day refund request lost is not.
        refundRequested = sent.outcome === 'sent';
        if (!refundRequested) {
            deps.logError('refund_request_not_sent', new Error(`${sent.outcome}: ${sent.reason}`));
        }
    }

    return deps.json({
        cancelled: true,
        cancelledAt,
        endsAt,
        refundRequested,
        // Said so the page can tell the buyer to email support themselves.
        refundRequestFailed: first && wantsRefund && refundEligible && !refundRequested,
    });
};

export const handleCancel = async (req: Request, deps: CancelDeps): Promise<Response> => {
    if (req.method === 'OPTIONS') {
        return deps.options();
    }
    if (req.method !== 'POST') {
        return deps.json({ error: 'Method not allowed' }, 405);
    }
    let body: Record<string, unknown>;
    try {
        const parsed = (await req.json()) as unknown;
        body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
        return deps.json({ error: 'Invalid JSON body' }, 400);
    }

    if (body.action === 'start') {
        return startCancel(req, deps, body);
    }
    if (body.action !== 'peek' && body.action !== 'cancel') {
        return deps.json({ error: 'Unknown action', code: 'unknown_action' }, 400);
    }
    // A token is 256 random bits, so guessing is hopeless; this only keeps a
    // scripted caller from spending our database on trying.
    const gate = await deps.checkRateLimit(
        `billing-cancel:token:ip:${deps.clientKey(req)}`,
        CANCEL_LIMITS.tokenPerIp.limit,
        CANCEL_LIMITS.tokenPerIp.windowMs,
    );
    if (!gate.ok) {
        return tooMany(deps, gate.retryAfterSec);
    }
    return body.action === 'peek' ? peekCancel(deps, body) : confirmCancel(deps, body);
};
