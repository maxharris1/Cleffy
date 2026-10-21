/**
 * One send through Resend, and what its outcome means for the mail budget.
 *
 * The contract (Cleffy, October 2026; Codex found the bug in #62's outbox):
 *
 *  * A send whose outcome is UNKNOWN — a timeout, a network error, a 5xx, or
 *    a 408/409/429 — may have gone out. Its budget reservation is KEPT: handing
 *    it back would let one more mail out than the ceiling allows.
 *  * Only a DEFINITE refusal hands the reservation back: any other 4xx (Resend
 *    validated the request and rejected it), or no API key at all (no request
 *    was made).
 *  * Every send carries a stable Idempotency-Key derived from its outbox row —
 *    table and row id, never the attempt — so a retry after an unknown outcome
 *    cannot deliver the mail twice: Resend answers a repeated key with the
 *    first request's result for 24 hours.
 *
 * #62 (checkout) is writing the shared version of this helper under
 * `_shared/`. Until it is on origin/mh/launch-checkout this file implements the
 * same contract; once it is, that file replaces this one byte for byte.
 *
 * No runtime imports, so the Node test suite loads it as it is.
 */

export type MailSendOutcome = 'sent' | 'rejected' | 'unknown' | 'unconfigured';

/** Long enough for Resend on a slow day; short of an edge function's wall clock. */
export const RESEND_TIMEOUT_MS = 10_000;

const RESEND_EMAILS = 'https://api.resend.com/emails';

/** The Idempotency-Key for an outbox row: the same on every attempt at it. */
export const outboxIdempotencyKey = (table: string, rowId: string): string => `${table}/${rowId}`;

/** What an HTTP status from Resend says about whether the mail went out. */
export const resendStatusOutcome = (status: number): Exclude<MailSendOutcome, 'unconfigured'> => {
    if (status >= 200 && status < 300) {
        return 'sent';
    }
    // A timeout, a concurrent request with the same key, or Resend's own rate
    // limit: whether it went out is not something to bet the ceiling on.
    if (status === 408 || status === 409 || status === 429) {
        return 'unknown';
    }
    if (status >= 400 && status < 500) {
        return 'rejected';
    }
    return 'unknown';
};

/** Whether a send's budget reservation is handed back: only when no mail can have gone out. */
export const refundsMailBudget = (outcome: MailSendOutcome): boolean =>
    outcome === 'rejected' || outcome === 'unconfigured';

export interface ResendSend {
    apiKey: string | undefined;
    idempotencyKey: string;
    /** The Resend /emails body: from, to, subject, text, and so on. */
    body: Record<string, unknown>;
    /** Told the status (null for a network error) and Resend's reason; never the address or body. */
    onFailure?: (status: number | null, detail: string) => void;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

export const sendViaResend = async (send: ResendSend): Promise<MailSendOutcome> => {
    if (!send.apiKey) {
        return 'unconfigured';
    }
    const doFetch = send.fetch ?? fetch;
    try {
        const res = await doFetch(RESEND_EMAILS, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${send.apiKey}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': send.idempotencyKey,
            },
            body: JSON.stringify(send.body),
            signal: AbortSignal.timeout(send.timeoutMs ?? RESEND_TIMEOUT_MS),
        });
        const outcome = resendStatusOutcome(res.status);
        if (outcome !== 'sent') {
            const detail = await res.text().catch(() => '');
            send.onFailure?.(res.status, detail.slice(0, 300));
        }
        return outcome;
    } catch (err) {
        // Timed out or never answered: it may have been accepted all the same.
        send.onFailure?.(null, String(err).slice(0, 300));
        return 'unknown';
    }
};
