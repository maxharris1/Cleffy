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
 * subscription, so the form is not a way to learn who subscribes. What stops
 * it being a way to spam strangers: mail only goes to an address that already
 * holds a running subscription with us, and three limits sit in front of it --
 * per IP, per recipient, and the project's share of the mail budget
 * (`billingCancelLink` in mailBudget.ts).
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

export interface CancelDeps {
    json: (body: unknown, status?: number) => Response;
    options: () => Response;
    clientKey: (req: Request) => string;
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    refundRateLimit: (key: string) => Promise<void>;
    /** mailLimit('billingCancelLink', …) from mailBudget.ts. */
    mailBudget: { hour: MailWindow; day: MailWindow };
    modeForRequest: (req: Request) => StripeMode | null;
    appOrigin: (req: Request) => string;
    /** SHA-256, lower-case hex. */
    sha256Hex: (value: string) => Promise<string>;
    /** Server-side pepper for the per-recipient limiter key, so the rate table holds no address. */
    secret: () => string | null;
    newToken: () => string;
    userForEmail: (email: string) => Promise<string | null>;
    emailOfUser: (userId: string) => Promise<string | null>;
    cancellableSubscription: (userId: string, mode: StripeMode) => Promise<CancellableSubscription | null>;
    /** Earliest subscription this account ever started in this mode (ms), for the refund window. */
    firstPurchaseAt: (userId: string, mode: StripeMode) => Promise<number | null>;
    saveToken: (token: { hash: string; userId: string; mode: StripeMode; expiresAt: string }) => Promise<void>;
    readToken: (hash: string) => Promise<StoredCancelToken | null>;
    /** Marks the token used if it still is not; false when another request got there first. */
    consumeToken: (hash: string, nowIso: string) => Promise<boolean>;
    /** Stripe: cancel_at_period_end = true. Answers when access ends. */
    cancelAtPeriodEnd: (subscriptionId: string, mode: StripeMode) => Promise<{ endsAt: string | null }>;
    sendEmail: (
        to: string,
        message: BillingTerms.BillingEmail,
        options: { replyTo?: string; tag: string },
    ) => Promise<'sent' | 'failed' | 'unconfigured'>;
    terms: Pick<
        typeof BillingTerms,
        'cancelLinkEmail' | 'refundRequestEmail' | 'withinRefundWindow' | 'TRADER' | 'BILLING_PATHS'
    >;
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
    const secret = deps.secret();
    if (!secret) {
        deps.logError('cancel_secret_missing', new Error('no secret for the recipient limiter'));
        return deps.json(CANCEL_ERRORS.unavailable, 503);
    }

    // The same answer for every address, so the form cannot be used to learn
    // who subscribes. Only failures we cannot hide (the limiter, a dead
    // database) answer differently, and those do not depend on the address.
    const accepted = deps.json({ sent: true });

    const recipientKey = `billing-cancel:start:to:${await deps.sha256Hex(`${secret}:${email}`)}`;
    const recipientGate = await deps.checkRateLimit(
        recipientKey,
        CANCEL_LIMITS.startPerRecipient.limit,
        CANCEL_LIMITS.startPerRecipient.windowMs,
    );
    if (!recipientGate.ok) {
        // Said as accepted: a link is already on its way to this address.
        return accepted;
    }

    let userId: string | null;
    let subscription: CancellableSubscription | null;
    try {
        userId = await deps.userForEmail(email);
        subscription = userId ? await deps.cancellableSubscription(userId, mode) : null;
    } catch (err) {
        deps.logError('cancel_lookup_failed', err);
        return deps.json(CANCEL_ERRORS.unavailable, 503);
    }
    if (!userId || !subscription) {
        await deps.refundRateLimit(recipientKey).catch(() => undefined);
        return accepted;
    }

    // The project's share of the mail budget, reserved before the send and
    // handed back if nothing goes out (the guestEmail.ts pattern).
    const reserved: string[] = [];
    const release = async () => {
        await Promise.all(reserved.map((key) => deps.refundRateLimit(key).catch(() => undefined)));
    };
    for (const [key, window] of [
        ['billing-cancel:global', deps.mailBudget.hour],
        ['billing-cancel:global-day', deps.mailBudget.day],
    ] as const) {
        const gate = await deps.checkRateLimit(key, window.limit, window.windowMs);
        if (!gate.ok) {
            await release();
            deps.logError('cancel_mail_budget_reached', new Error(`${key} is spent`));
            return deps.json(CANCEL_ERRORS.unavailable, 503);
        }
        reserved.push(key);
    }

    const token = deps.newToken();
    try {
        await deps.saveToken({
            hash: await deps.sha256Hex(token),
            userId,
            mode,
            expiresAt: new Date(deps.now() + CANCEL_LINK_TTL_MS).toISOString(),
        });
    } catch (err) {
        await release();
        deps.logError('cancel_token_save_failed', err);
        return deps.json(CANCEL_ERRORS.unavailable, 503);
    }

    const link = `${deps.appOrigin(req)}${deps.terms.BILLING_PATHS.cancel}?token=${encodeURIComponent(token)}`;
    const sent = await deps.sendEmail(email, deps.terms.cancelLinkEmail(link, CANCEL_LINK_TTL_MS / 60_000), {
        tag: 'cancel_link',
    });
    if (sent !== 'sent') {
        await release();
        deps.logError('cancel_link_not_sent', new Error(sent));
        return deps.json(CANCEL_ERRORS.unavailable, 503);
    }
    return accepted;
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
        const [email, subscription, firstPurchaseAt] = await Promise.all([
            deps.emailOfUser(live.row.userId),
            deps.cancellableSubscription(live.row.userId, live.row.mode),
            deps.firstPurchaseAt(live.row.userId, live.row.mode),
        ]);
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
    let endsAt: string | null = subscription.periodEnd;
    if (!subscription.cancelAtPeriodEnd) {
        try {
            endsAt = (await deps.cancelAtPeriodEnd(subscription.subscriptionId, resolved.row.mode)).endsAt ?? endsAt;
        } catch (err) {
            deps.logError('cancel_stripe_failed', err);
            return deps.json(CANCEL_ERRORS.unavailable, 502);
        }
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
