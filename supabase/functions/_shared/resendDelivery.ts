/**
 * Sending one email through Resend from a durable outbox, without ever
 * mistaking "we do not know" for "it did not go".
 *
 * Every outbox that mails through Resend reserves a share of the mail budget
 * (mailBudget.ts) before it sends, and hands the reservation back when nothing
 * went out. Handing it back is only right when nothing CAN have gone out: if
 * Resend accepted the email and the connection dropped before the answer came
 * back, the email is on its way, and a refund lets real sends past the 60/hour
 * and 300/day ceiling while the retry mails the customer a second copy.
 *
 * So every send carries an `Idempotency-Key` derived from its outbox row
 * (`resendIdempotencyKey`), the same on every retry of that row, and every
 * result is one of exactly three things (`sendViaResend`):
 *
 *  * `sent`     -- Resend answered 2xx with the email's id;
 *  * `rejected` -- certainly not sent: Resend refused it (a 4xx other than 408
 *                  and 409), or it never left this process (no API key, a bad
 *                  key or payload caught before fetch). Refund, then retry or
 *                  give up as the outbox decides;
 *  * `unknown`  -- it may have been sent: fetch threw (timeout, abort,
 *                  connection reset, DNS, TLS) once the request was attempted,
 *                  any 5xx, a 408, a 409, a redirect, or a 2xx whose body is
 *                  not Resend's answer. KEEP the reservation and retry with the
 *                  SAME key: Resend replays its first answer for a key it has
 *                  already sent, rather than sending again.
 *
 * Anything this module cannot place for certain is `unknown`; a refund is
 * never made on doubt.
 *
 * Two statuses decided deliberately:
 *
 *  * 429 (rate_limit_exceeded, daily/monthly quota) is `rejected`. Resend
 *    refuses before it accepts anything, so this attempt sent nothing and its
 *    own reservation is handed back; `retryAfterMs` carries Resend's
 *    Retry-After so the outbox waits as long as it is told. A 429 says nothing
 *    about an EARLIER attempt with the same key, whose reservation (if it was
 *    `unknown`) stays where it is.
 *  * 409 is `unknown`. Resend answers it for `concurrent_idempotent_requests`
 *    (the first request with this key is still being processed, and may yet
 *    send) and for `invalid_idempotent_request` (this key already went with a
 *    different payload). Either way an earlier request with this key reached
 *    Resend and may have sent, so nothing is refunded. Senders keep a row's
 *    payload identical across retries so the second case does not arise.
 *
 * Resend keeps a key for 24 hours (1-256 characters; a malformed one is a 400,
 * `invalid_idempotency_key`, which `resendIdempotencyKey` cannot produce). A
 * row still retrying after that can be sent again; outboxes alert long before.
 *
 * Self-contained on purpose -- no imports, no Deno globals, the API key and
 * fetch handed in -- so every outbox can use this one file as it is, and
 * vitest can load the exact file Deno runs.
 */

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

/** Resend's limit on an Idempotency-Key. */
export const RESEND_IDEMPOTENCY_KEY_MAX = 256;

/** Long enough for a slow Resend, short enough that a batch finishes inside its outbox lease. */
export const RESEND_TIMEOUT_MS = 10_000;

export type ResendOutcome = 'sent' | 'rejected' | 'unknown';

export interface ResendResult {
    outcome: ResendOutcome;
    /**
     * Why, for logs: `sent`, `unconfigured`, `invalid_request`, `timeout`,
     * `network`, `unparseable_response`, or `http_<status>`. Never an address.
     */
    reason: string;
    /** The HTTP status, or null when no response came back (or no request was made). */
    status: number | null;
    /** Resend's id for the email, on `sent`. */
    id?: string;
    /** Resend's error name (`validation_error`, `concurrent_idempotent_requests`, ...), when it gave one. */
    errorName?: string;
    /** On a 429: how long Resend asked us to wait. */
    retryAfterMs?: number;
    /** The start of Resend's error body, for the error log. */
    detail?: string;
}

/** The body of POST /emails; anything else Resend accepts may ride along. */
export interface ResendEmail {
    from: string;
    to: string[];
    subject: string;
    text?: string;
    html?: string;
    reply_to?: string;
    [field: string]: unknown;
}

export interface ResendSend {
    /** RESEND_API_KEY; missing or empty is `rejected` / `unconfigured`, before any request. */
    apiKey: string | null | undefined;
    /** From resendIdempotencyKey: the same on every retry of one outbox row. */
    idempotencyKey: string;
    email: ResendEmail;
    /** Defaults to the global fetch. */
    fetch?: typeof fetch;
    timeoutMs?: number;
    url?: string;
}

const OUTBOX_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROW_ID = /^[A-Za-z0-9_-]+$/;
/** What sendViaResend accepts as a key: visible ASCII, within Resend's limit. */
const KEY = /^[\x21-\x7e]+$/;

/**
 * `<outbox>-<row id>`, e.g. `billing-outbox-1b2c...`: derived from the row and
 * nothing else, so it is identical on every retry of that row and different
 * for every other row. Both parts are limited to letters, digits, `-` and `_`
 * (an outbox name to lower-case words joined by `-`), so an address, a name
 * or anything else with an `@`, a `.` or a space can never end up in a key.
 * Throws on anything else: a key that cannot be built is a bug, not a send.
 */
export const resendIdempotencyKey = (outbox: string, rowId: string): string => {
    if (!OUTBOX_NAME.test(outbox)) {
        throw new Error('resendIdempotencyKey: the outbox name must be lower-case words joined by "-"');
    }
    if (!ROW_ID.test(rowId)) {
        throw new Error('resendIdempotencyKey: the row id must be letters, digits, "-" or "_"');
    }
    const key = `${outbox}-${rowId}`;
    if (key.length > RESEND_IDEMPOTENCY_KEY_MAX) {
        throw new Error(`resendIdempotencyKey: longer than Resend's ${RESEND_IDEMPOTENCY_KEY_MAX} characters`);
    }
    return key;
};

/** What a status means on its own, before the body is read: a 2xx still has to show an id. */
export const classifyResendStatus = (status: number): ResendOutcome => {
    if (status >= 200 && status < 300) {
        return 'sent';
    }
    // 408: the server gave up on the request -- but a proxy in front of
    // Resend can say it after Resend had it. 409: see the module comment.
    if (status === 408 || status === 409) {
        return 'unknown';
    }
    if (status >= 400 && status < 500) {
        return 'rejected';
    }
    // 5xx (Resend, or a gateway in front of it, failed somewhere after the
    // request arrived) and anything stranger.
    return 'unknown';
};

/** Retry-After as seconds or an HTTP date, in ms; undefined when absent or unreadable. */
const retryAfterMs = (header: string | null): number | undefined => {
    if (!header) {
        return undefined;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }
    const at = Date.parse(header);
    return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
};

const isTimeout = (err: unknown): boolean =>
    err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

const rejected = (reason: string): ResendResult => ({ outcome: 'rejected', reason, status: null });

/**
 * POSTs one email to Resend with its Idempotency-Key and says which of
 * `sent`, `rejected` or `unknown` happened. Never throws.
 */
export const sendViaResend = async (send: ResendSend): Promise<ResendResult> => {
    // Everything that can be wrong before a request exists is a certain
    // non-send: nothing has left this process.
    if (!send.apiKey) {
        return rejected('unconfigured');
    }
    if (
        typeof send.idempotencyKey !== 'string' ||
        send.idempotencyKey.length > RESEND_IDEMPOTENCY_KEY_MAX ||
        !KEY.test(send.idempotencyKey)
    ) {
        return rejected('invalid_request');
    }
    const email = send.email;
    if (
        !email ||
        typeof email.from !== 'string' ||
        !email.from ||
        typeof email.subject !== 'string' ||
        !Array.isArray(email.to) ||
        email.to.length === 0 ||
        email.to.some((to) => typeof to !== 'string' || !to)
    ) {
        return rejected('invalid_request');
    }
    let body: string;
    try {
        body = JSON.stringify(email);
    } catch {
        return rejected('invalid_request');
    }
    const doFetch = send.fetch ?? globalThis.fetch;

    // From here on the request may have reached Resend.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), send.timeoutMs ?? RESEND_TIMEOUT_MS);
    try {
        let res: Response;
        try {
            res = await doFetch(send.url ?? RESEND_EMAILS_URL, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${send.apiKey}`,
                    'Content-Type': 'application/json',
                    'Idempotency-Key': send.idempotencyKey,
                },
                body,
                signal: controller.signal,
            });
        } catch (err) {
            return {
                outcome: 'unknown',
                reason: controller.signal.aborted || isTimeout(err) ? 'timeout' : 'network',
                status: null,
            };
        }

        const outcome = classifyResendStatus(res.status);
        let text: string | null = null;
        try {
            text = await res.text();
        } catch {
            // The body was cut off: for a 2xx that is not an answer we can
            // trust, and for anything else the status has already decided.
        }

        if (outcome === 'sent') {
            let id: unknown;
            try {
                id = text === null ? undefined : (JSON.parse(text) as { id?: unknown } | null)?.id;
            } catch {
                id = undefined;
            }
            return typeof id === 'string' && id
                ? { outcome: 'sent', reason: 'sent', status: res.status, id }
                : { outcome: 'unknown', reason: 'unparseable_response', status: res.status };
        }

        let errorName: string | undefined;
        try {
            const parsed = text === null ? null : (JSON.parse(text) as { name?: unknown } | null);
            errorName = typeof parsed?.name === 'string' ? parsed.name.slice(0, 64) : undefined;
        } catch {
            errorName = undefined;
        }
        return {
            outcome,
            reason: `http_${res.status}`,
            status: res.status,
            ...(errorName ? { errorName } : {}),
            ...(res.status === 429 ? { retryAfterMs: retryAfterMs(res.headers.get('retry-after')) } : {}),
            ...(text ? { detail: text.slice(0, 300) } : {}),
        };
    } finally {
        clearTimeout(timer);
    }
};
