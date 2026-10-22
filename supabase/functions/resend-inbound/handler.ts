import type * as ReadCapped from '../_shared/readCappedJson.ts';
import type { ResendEmail, ResendResult } from '../_shared/resendDelivery.ts';
import type * as SupportMail from '../_shared/supportMail.ts';

/**
 * Inbound support mail, delivered by Resend as an `email.received` webhook —
 * the control flow, apart from the clients it runs against. index.ts wires it;
 * tests/support/resendInbound.test.ts drives it. No runtime imports, for the
 * reason student-login/handler.ts gives.
 *
 * Deployed with `verify_jwt = false` (see supabase/config.toml) for the same
 * structural reason `stripe-webhook` is: the caller has no Supabase JWT to
 * present. The Svix signature is the whole of the authentication, so a failure
 * to verify has to be a refusal rather than a warning.
 *
 * Deliberately no rate limit on intake: throttling here would drop Svix's
 * retries, and a dropped retry is a support request nobody ever sees. What IS
 * limited is what we send: every forward ATTEMPT reserves one unit of the
 * supportInbound share of the shared mail budget (_shared/mailBudget.ts,
 * buckets of its own, so inbound can never spend the content-report
 * acknowledgments' share) BEFORE it is sent, and is sent through
 * _shared/resendDelivery.ts with an Idempotency-Key derived from Resend's email
 * id, so a resumed or retried forward does not deliver twice while Resend
 * still remembers the key.
 *
 * The webhook carries metadata only — Resend's docs are explicit that the body,
 * headers and attachments are not in it — so the message itself is fetched from
 * the Received Emails API before anything is forwarded.
 *
 * Every message moves through a row in support_messages
 * (20261022110200_support_inbound_lease.sql), claimed under a lease:
 *
 *  * a COMPLETED row is the only duplicate (200, nothing done);
 *  * a row another delivery holds answers 503, so Svix tries again later;
 *  * anything else — new, interrupted, or deferred — is claimed and carried on
 *    from where it stopped: a body already stored is not fetched again.
 *
 * Persist, then forward. A body that cannot be fetched or stored answers 5xx so
 * Resend retries (the row is resumable; nothing is lost). A spent budget leaves
 * the message stored as forward_deferred and answers 200: the retry path —
 * pg_cron's support_inbound_retry_tick, POSTing here with
 * x-support-retry-secret — forwards it when the window reopens. A forward whose
 * outcome is unknown keeps its reservation, answers 502, and is retried with
 * the same key.
 *
 * Every attempt pays for itself (the billingOutbox.ts pattern): a retry after
 * an unknown outcome reserves again in the windows it sends in, and the earlier
 * charge stays where it was. That may count one email twice; it never lets a
 * send through that this window did not pay for, which is what a held
 * reservation carried across a window boundary used to do.
 *
 * And retries stop before Resend forgets the key. Resend keeps an
 * Idempotency-Key for 24 hours; past that a replay is a new email. The row
 * records when its first send was attempted (begin_support_forward,
 * 20261022110300_support_inbound_retry_window.sql), and once ~23 hours have
 * gone by no further send is made: the row is marked `failed` for a person to
 * look at, and later deliveries treat it as finished.
 */

/** The cap on a webhook body: readCappedJson.ts's WEBHOOK_BODY_MAX_BYTES. */
export const WEBHOOK_BODY_MAX_BYTES = 256 * 1024;
const PAYLOAD_TOO_LARGE = { error: 'Request body too large', code: 'payload_too_large' } as const;

/**
 * The edge rate-limit bucket inbound forwards are counted in, per window. Their
 * own: content-report acknowledgments count under `mail:content-report-ack:*`,
 * so no amount of inbound mail can delay them.
 */
export const supportInboundBudgetKey = (window: string): string => `mail:support-inbound:${window}`;

/** The outbox name in a forward's Idempotency-Key: `support-forward-<Resend email id>`. */
export const SUPPORT_FORWARD_OUTBOX = 'support-forward';

/** Resend's email ids are UUIDs; anything else cannot key a forward and is refused. */
const EMAIL_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** How many due messages one retry run takes. */
export const RETRY_BATCH = 10;

/** Bodies are stored up to this many characters each. */
const BODY_MAX_CHARS = 100_000;

export const LOOP_GUARD_ERROR = 'not forwarded: message is from our own forwarding address (loop guard)';

interface ReceivedEvent {
    type?: string;
    data?: {
        email_id?: string;
        created_at?: string;
        from?: string;
        to?: string[];
        received_for?: string[];
        message_id?: string;
        subject?: string;
        attachments?: unknown[];
    };
}

/** What claim_support_message records from the webhook. */
export interface InboundMeta {
    emailId: string;
    messageId: string | null;
    from: string;
    to: string[];
    receivedFor: string[];
    subject: string | null;
    attachments: unknown[];
    receivedAt: string;
}

/** A support_messages row as its lease holder sees it. */
export interface InboundMessage {
    id: string;
    holder: string;
    resendEmailId: string;
    fromAddress: string;
    toAddresses: string[];
    receivedFor: string[];
    subject: string | null;
    textBody: string | null;
    htmlBody: string | null;
}

export type ClaimAnswer =
    | { status: 'claimed'; message: InboundMessage }
    | { status: 'duplicate' }
    | { status: 'busy'; retryAfterSec: number };

export type FinishOutcome = 'forwarded' | 'stored' | 'refused' | 'deferred' | 'retry';

/** support_messages through its RPCs. Null answers mean the database could not be reached. */
export interface InboundStore {
    claim: (meta: InboundMeta) => Promise<ClaimAnswer | null>;
    claimDue: (limit: number) => Promise<InboundMessage[] | null>;
    /** True when stored; false when this holder no longer holds the row; null on error. */
    saveBody: (id: string, holder: string, text: string | null, html: string | null) => Promise<boolean | null>;
    /** True when recorded; false when this holder no longer holds the row; null on error. */
    finish: (id: string, holder: string, outcome: FinishOutcome, detail?: FinishDetail) => Promise<boolean | null>;
    /**
     * begin_support_forward, right before a send: 'send' (the first send's time
     * is recorded if this is it), 'expired' (the retry window since the first
     * send has closed; the row is now failed and nothing may be sent), 'lost'
     * (this holder no longer holds the row), null on error.
     */
    beginSend: (id: string, holder: string) => Promise<'send' | 'expired' | 'lost' | null>;
}

export interface FinishDetail {
    error?: string;
    retryAfterSec?: number;
    forwardId?: string;
    /** On 'retry': this attempt's outcome is unknown and its reservation was kept (recorded, never read back). */
    budgetHeld?: boolean;
}

export type BudgetReservation = { ok: true; release: () => Promise<void> } | { ok: false; retryAfterSec: number };

export interface InboundDeps {
    json: (body: unknown, status?: number) => Response;
    options: () => Response;
    /** _shared/readCappedJson.ts's readCappedText. */
    readText: typeof ReadCapped.readCappedText;
    /** Svix verification of the raw body (svixSignature.ts, with the signing secret and the clock). */
    verifySignature: (rawBody: string, req: Request) => Promise<{ ok: true } | { ok: false; reason: string }>;
    /** Null when the request does not ask for a retry run; otherwise whether its secret is right. */
    retryAuthorized: (req: Request) => Promise<boolean | null>;
    config: {
        signingSecret: string | null;
        apiKey: string | null;
        /** Where forwards land. Null means store-only, which is a valid mode. */
        forwardTo: string | null;
        /** The From of a forward: a sending domain, never an address this endpoint receives at. */
        forwardFrom: string;
    };
    store: InboundStore | null;
    /** The body from Resend's Received Emails API. */
    fetchBody: (
        emailId: string,
    ) => Promise<{ ok: true; text?: string | null; html?: string | null } | { ok: false; detail: string }>;
    /** One unit of supportInbound, every window, or when there will be some again. */
    reserveBudget: () => Promise<BudgetReservation>;
    /** resendDelivery.ts's sendViaResend, with the API key bound. */
    send: (email: ResendEmail, idempotencyKey: string) => Promise<ResendResult>;
    /** resendDelivery.ts's resendIdempotencyKey. */
    idempotencyKey: (outbox: string, rowId: string) => string;
    mail: Pick<typeof SupportMail, 'isOwnForward' | 'inboxTagFor' | 'forwardedSubject'>;
    logError: (code: string, message: string) => void;
}

/** How one message's processing ended: the HTTP answer for a webhook, and what it was. */
interface Processed {
    status: number;
    body: Record<string, unknown>;
}

const truncate = (value: string | null | undefined): string | null => {
    if (!value) {
        return null;
    }
    return value.length > BODY_MAX_CHARS ? `${value.slice(0, BODY_MAX_CHARS)}\n\n[truncated]` : value;
};

/**
 * Carry one claimed message as far as it can go, and record where it stopped.
 * Shared by the webhook and the retry run.
 */
export const processMessage = async (message: InboundMessage, deps: InboundDeps): Promise<Processed> => {
    const store = deps.store as InboundStore;
    const { id, holder } = message;
    const stored = { stored: id };

    const finish = async (outcome: FinishOutcome, detail?: FinishDetail): Promise<boolean> => {
        const done = await store.finish(id, holder, outcome, detail);
        if (done === null) {
            deps.logError('finish_failed', `could not record ${outcome} for inbound ${message.resendEmailId}`);
        }
        return done === true;
    };

    // 1. The body: fetched once, then kept on the row, so a resumed delivery
    //    does not fetch it again.
    let text = message.textBody;
    let html = message.htmlBody;
    if (!text && !html) {
        const fetched = await deps.fetchBody(message.resendEmailId);
        if (!fetched.ok) {
            // Recorded on the row, and answered 5xx so Resend retries: the
            // message is stored and resumable, and nothing has been sent.
            deps.logError('body_fetch_failed', `${message.resendEmailId}: ${fetched.detail}`);
            await finish('retry', { error: `no body yet (${fetched.detail})` });
            return { status: 502, body: { ...stored, forwarded: false, reason: 'body_fetch_failed' } };
        }
        text = truncate(fetched.text);
        html = truncate(fetched.html);
        if (!text && !html) {
            // Fetched fine, and there is nothing in it: nothing to forward, ever.
            await finish('refused', { error: 'no body to forward' });
            return { status: 200, body: { ...stored, forwarded: false, reason: 'no_body' } };
        }
        const saved = await store.saveBody(id, holder, text, html);
        if (saved !== true) {
            // Not ignored any more: a body we could not store is a message we
            // cannot vouch for. 5xx, and Resend tries again.
            if (saved === null) {
                deps.logError('body_persist_failed', `could not store the body of ${message.resendEmailId}`);
                await finish('retry', { error: 'body persist failed' });
            }
            return { status: saved === null ? 500 : 503, body: { error: 'Could not store the message' } };
        }
    }

    // 2. Store-only is a deliberate mode, not a failure: the row is the record.
    if (!deps.config.forwardTo) {
        return (await finish('stored'))
            ? { status: 200, body: { ...stored, forwarded: false } }
            : { status: 500, body: { error: 'Could not record the message' } };
    }

    // 3. The loop guard: stored, so the loop is visible in the table, never re-sent.
    if (deps.mail.isOwnForward(message.fromAddress, deps.config.forwardFrom)) {
        await finish('refused', { error: LOOP_GUARD_ERROR });
        return { status: 200, body: { ...stored, forwarded: false, reason: 'loop_guard' } };
    }

    // 4. The budget, BEFORE the send, on EVERY attempt. Spent: stored as
    //    forward_deferred, and the retry path forwards it when the window
    //    reopens. A retry after an unknown outcome pays again: its earlier
    //    charge may belong to a window that has since reset, and this send
    //    happens in this one.
    const budget = await deps.reserveBudget();
    if (!budget.ok) {
        deps.logError('budget_deferred', `inbound ${message.resendEmailId} deferred: the forward budget is spent`);
        return (await finish('deferred', { retryAfterSec: budget.retryAfterSec }))
            ? { status: 200, body: { ...stored, forwarded: false, reason: 'budget_deferred' } }
            : { status: 500, body: { error: 'Could not record the message' } };
    }

    // 5. The send window. Resend replays a key for 24 hours; after ~23 hours
    //    since the first send attempt, a retry could mail a second copy, so
    //    none is made. The database marks the row failed (manual review).
    const window = await store.beginSend(id, holder);
    if (window !== 'send') {
        await budget.release();
        if (window === 'expired') {
            deps.logError(
                'forward_window_closed',
                `inbound ${message.resendEmailId}: the retry window since its first send has closed; marked failed for review`,
            );
            return { status: 200, body: { ...stored, forwarded: false, reason: 'retry_window_closed' } };
        }
        return window === 'lost'
            ? { status: 503, body: { inProgress: true } }
            : { status: 500, body: { error: 'Could not record the message' } };
    }

    // 6. The forward. Tagged by the inbox it reached, so privacy@ and legal@
    //    stand out in the one mailbox all three forward to; replying goes to the
    //    person who wrote in, not to our own relay.
    const from = message.fromAddress || 'unknown sender';
    const sent = await deps.send(
        {
            from: deps.config.forwardFrom,
            to: [deps.config.forwardTo],
            reply_to: from,
            subject: deps.mail.forwardedSubject(
                deps.mail.inboxTagFor(message.receivedFor, message.toAddresses),
                message.subject,
            ),
            ...(text ? { text } : {}),
            ...(html ? { html } : {}),
            headers: { 'X-Cleffy-Inbound-Id': message.resendEmailId },
        },
        deps.idempotencyKey(SUPPORT_FORWARD_OUTBOX, message.resendEmailId),
    );

    if (sent.outcome === 'sent') {
        if (!(await finish('forwarded', { forwardId: sent.id }))) {
            // Sent, but not recorded: the retry re-sends with the same key and
            // Resend answers with this send rather than mailing again.
            return { status: 500, body: { error: 'Could not record the forward' } };
        }
        return { status: 200, body: { ...stored, forwarded: true } };
    }

    if (sent.outcome === 'rejected') {
        // Certainly not sent: the reservation goes back.
        await budget.release();
        const detail = [sent.reason, sent.errorName, sent.detail].filter(Boolean).join(' ').slice(0, 500);
        if (sent.status === 429) {
            await finish('deferred', {
                error: `forward deferred: ${detail}`,
                retryAfterSec: Math.ceil((sent.retryAfterMs ?? 60_000) / 1000),
            });
            return { status: 200, body: { ...stored, forwarded: false, reason: 'rate_limited' } };
        }
        if (sent.reason === 'unconfigured' || sent.status === 401 || sent.status === 403) {
            // Our configuration, not the message: a missing, revoked or rotated
            // API key, or a sending domain that is not verified. Retried (and
            // 5xx, so Resend retries too) rather than recorded as refused, so
            // fixing the configuration delivers what arrived meanwhile.
            deps.logError('forward_unconfigured', `forward of ${message.resendEmailId} refused: ${detail}`);
            await finish('retry', { error: `forward not configured: ${detail}` });
            return { status: 500, body: { error: 'Server misconfigured' } };
        }
        deps.logError('forward_rejected', `forward of ${message.resendEmailId} rejected: ${detail}`);
        // Refused for good (a 4xx Resend will refuse again): recorded on the row.
        await finish('refused', { error: detail });
        return { status: 200, body: { ...stored, forwarded: false } };
    }

    // Unknown: it may have gone. This attempt's reservation stays spent, and
    // the retry (which reserves again) uses the same Idempotency-Key, so Resend
    // replays rather than re-sends while the window is open.
    deps.logError('forward_unknown', `forward of ${message.resendEmailId}: ${sent.reason}`);
    await finish('retry', { error: `forward outcome unknown: ${sent.reason}`, budgetHeld: true });
    return { status: 502, body: { ...stored, forwarded: false, reason: 'forward_unknown' } };
};

/** The retry run: every due message, one after another. */
const handleRetry = async (deps: InboundDeps): Promise<Response> => {
    const due = await (deps.store as InboundStore).claimDue(RETRY_BATCH);
    if (!due) {
        return deps.json({ error: 'Could not read the queue' }, 502);
    }
    const outcomes: Array<{ id: string; status: number; reason?: unknown }> = [];
    for (const message of due) {
        const result = await processMessage(message, deps);
        outcomes.push({ id: message.id, status: result.status, reason: result.body['reason'] });
    }
    return deps.json({ processed: due.length, outcomes });
};

export const handleResendInbound = async (req: Request, deps: InboundDeps): Promise<Response> => {
    const { json } = deps;
    if (req.method === 'OPTIONS') {
        return deps.options();
    }
    if (req.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }

    // The retry tick's request: authenticated by its own secret, never by Svix.
    const retry = await deps.retryAuthorized(req);
    if (retry !== null) {
        if (!retry) {
            return json({ error: 'Unauthorized' }, 401);
        }
        if (!deps.store || !deps.config.apiKey) {
            return json({ error: 'Server misconfigured' }, 500);
        }
        return handleRetry(deps);
    }

    if (!deps.config.signingSecret || !deps.config.apiKey) {
        // 500 so Svix retries once we are configured again.
        return json({ error: 'Server misconfigured' }, 500);
    }

    // The RAW body — verification is over the exact bytes Svix signed, so this
    // must be read before (and instead of) any JSON parsing. Capped as it
    // streams: the signature is checked over exactly the bytes read here.
    const raw = await deps.readText(req, WEBHOOK_BODY_MAX_BYTES);
    if (!raw.ok) {
        return raw.status === 413 ? json(PAYLOAD_TOO_LARGE, 413) : json({ error: 'Could not read the body' }, 400);
    }
    const check = await deps.verifySignature(raw.value, req);
    if (!check.ok) {
        // 400, not 401: Svix treats 4xx as "do not retry", which is right for a
        // signature that will never become valid.
        return json({ error: 'Invalid signature', code: check.reason }, 400);
    }

    let event: ReceivedEvent;
    try {
        event = JSON.parse(raw.value) as ReceivedEvent;
    } catch {
        return json({ error: 'Invalid JSON body' }, 400);
    }
    if (!event || typeof event !== 'object') {
        return json({ error: 'Invalid JSON body' }, 400);
    }

    // Resend sends other event types to the same endpoint if it is subscribed to
    // them; acknowledge and ignore rather than 4xx, which would look like a
    // delivery failure on their side.
    if (event.type !== 'email.received') {
        return json({ ignored: event.type ?? 'unknown' }, 200);
    }

    const emailId = event.data?.email_id;
    if (typeof emailId !== 'string' || !EMAIL_ID.test(emailId)) {
        return json({ error: 'Malformed event' }, 400);
    }

    const store = deps.store;
    if (!store) {
        return json({ error: 'Server misconfigured' }, 500);
    }

    const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    const claimed = await store.claim({
        emailId,
        messageId: typeof event.data?.message_id === 'string' ? event.data.message_id : null,
        from: typeof event.data?.from === 'string' ? event.data.from : 'unknown',
        to: strings(event.data?.to),
        receivedFor: strings(event.data?.received_for),
        subject: typeof event.data?.subject === 'string' ? event.data.subject : null,
        attachments: Array.isArray(event.data?.attachments) ? event.data.attachments : [],
        receivedAt: typeof event.data?.created_at === 'string' ? event.data.created_at : new Date().toISOString(),
    });
    if (!claimed) {
        // Not recorded, so not acknowledged: Svix retries.
        return json({ error: `could not record ${emailId}` }, 500);
    }
    if (claimed.status === 'duplicate') {
        return json({ duplicate: true }, 200);
    }
    if (claimed.status === 'busy') {
        // Another delivery is working on it right now. Not a 200: if that one
        // dies, this retry (or the retry tick) is what finishes the job.
        return json({ inProgress: true, retryAfterSec: claimed.retryAfterSec }, 503);
    }

    const result = await processMessage(claimed.message, deps);
    return json(result.body, result.status);
};
