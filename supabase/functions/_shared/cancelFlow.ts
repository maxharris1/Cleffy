import type { Delivery } from './billingOutbox.ts';
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
 * same way for both routes (stripeEvents.ts isCancellationScheduled).
 *
 * NO runtime imports, for the reason checkoutFlow.ts gives.
 */

export const CANCEL_LINK_TTL_MS = 60 * 60_000;

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

type SendEmail = (
    to: string,
    message: BillingTerms.BillingEmail,
    options: { replyTo?: string; tag: string },
) => Promise<'sent' | 'failed' | 'unconfigured'>;

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
    newToken: () => string;
    userForEmail: (email: string) => Promise<string | null>;
    cancellableSubscription: (userId: string, mode: StripeMode) => Promise<CancellableSubscription | null>;
    saveToken: (token: { hash: string; userId: string; mode: StripeMode; expiresAt: string }) => Promise<void>;
    sendEmail: SendEmail;
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

/**
 * The worker's half of `start`: decide whether a queued request gets a link,
 * and send it. Runs from the billing mail outbox, so its outcome is never part
 * of any answer the person typing the address sees.
 *
 *  * `done`  -- no account, no running subscription, or a recipient already
 *               sent their share of links this hour: nothing to send, and the
 *               request (and the address in it) is deleted;
 *  * `retry` -- the mail budget is spent, the lookup failed, or Resend did:
 *               queued, and sent when it can be. Every limit counted on the way
 *               is handed back, so a retry is counted once, when it succeeds;
 *  * `sent`  -- a fresh one-time link went out.
 */
export const deliverCancelLink = async (
    deps: CancelLinkDeps,
    mode: StripeMode,
    request: CancelLinkRequest,
): Promise<Delivery> => {
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

    // Minted at send time, so a link that waited for the budget is still good
    // for its whole hour when it arrives.
    const token = deps.newToken();
    try {
        await deps.saveToken({
            hash: await deps.sha256Hex(token),
            userId,
            mode,
            expiresAt: new Date(deps.now() + CANCEL_LINK_TTL_MS).toISOString(),
        });
    } catch (err) {
        await handBack();
        deps.logError('cancel_token_save_failed', err);
        return { outcome: 'retry', reason: 'token not saved' };
    }

    const link = `${request.origin}${deps.terms.BILLING_PATHS.cancel}?token=${encodeURIComponent(token)}`;
    const sent = await deps.sendEmail(email, deps.terms.cancelLinkEmail(link, CANCEL_LINK_TTL_MS / 60_000), {
        tag: 'cancel_link',
    });
    if (sent !== 'sent') {
        await handBack();
        deps.logError('cancel_link_not_sent', new Error(sent));
        return { outcome: 'retry', reason: `resend ${sent}` };
    }
    return { outcome: 'sent' };
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
            { replyTo: resolved.email, tag: 'refund_request' },
        );
        refundRequested = sent === 'sent';
        if (!refundRequested) {
            deps.logError('refund_request_not_sent', new Error(sent));
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
