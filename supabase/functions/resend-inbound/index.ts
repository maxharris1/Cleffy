import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { logError } from '../_shared/errorReporting.ts';
import { mailLimit, MAIL_WINDOWS } from '../_shared/mailBudget.ts';
import { checkRateLimit, refundRateLimit, serviceClient } from '../_shared/rateLimit.ts';
import { readCappedText } from '../_shared/readCappedJson.ts';
import { RESEND_TIMEOUT_MS, resendIdempotencyKey, sendViaResend } from '../_shared/resendDelivery.ts';
import { secretsEqual } from '../_shared/secretCompare.ts';
import { forwardedSubject, inboxTagFor, isOwnForward } from '../_shared/supportMail.ts';
import { verifySvixSignature } from '../_shared/svixSignature.ts';
import {
    type BudgetReservation,
    handleResendInbound,
    type InboundMessage,
    type InboundStore,
    supportInboundBudgetKey,
} from './handler.ts';

/**
 * Inbound support mail. The control flow — the lease, the budget, the order of
 * persist and forward — lives in handler.ts, which says why; this file is only
 * what it runs against.
 */

const RESEND_API = 'https://api.resend.com';

/** The retry batch's lease: RETRY_BATCH messages, each a fetch and a send of up to RESEND_TIMEOUT_MS. */
const RETRY_BATCH_LEASE_SECONDS = 600;

const env = (name: string): string | undefined => Deno.env.get(name);

/**
 * The address forwards are sent FROM. It must be on a domain verified for
 * sending — `send.cleffy.io` is, the apex is not — and it must NOT be an address
 * this endpoint also receives at, or a forward would arrive back here and loop.
 */
const forwardFrom = (): string => env('SUPPORT_FORWARD_FROM') ?? 'Cleffy support <support@send.cleffy.io>';

/** The forward's share of the mail split: supportInbound, every window, in buckets of its own. */
const BUDGET = MAIL_WINDOWS.map(
    (window) => [supportInboundBudgetKey(window), mailLimit('supportInbound', window, env)] as const,
);

const reserveBudget = async (): Promise<BudgetReservation> => {
    const reserved: string[] = [];
    const release = async (): Promise<void> => {
        await Promise.all(reserved.map((key) => refundRateLimit(key).catch(() => undefined)));
    };
    for (const [key, { limit, windowMs }] of BUDGET) {
        const gate = await checkRateLimit(key, limit, windowMs);
        if (!gate.ok) {
            await release();
            return { ok: false, retryAfterSec: gate.retryAfterSec };
        }
        reserved.push(key);
    }
    return { ok: true, release };
};

const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const toMessage = (row: Record<string, unknown>, holder: string): InboundMessage => ({
    id: String(row['id']),
    holder,
    resendEmailId: String(row['resend_email_id']),
    fromAddress: typeof row['from_address'] === 'string' ? row['from_address'] : 'unknown',
    toAddresses: strings(row['to_addresses']),
    receivedFor: strings(row['received_for']),
    subject: typeof row['subject'] === 'string' ? row['subject'] : null,
    textBody: typeof row['text_body'] === 'string' ? row['text_body'] : null,
    htmlBody: typeof row['html_body'] === 'string' ? row['html_body'] : null,
});

const store = (): InboundStore | null => {
    const admin = serviceClient();
    if (!admin) {
        return null;
    }
    return {
        claim: async (meta) => {
            const { data, error } = await admin.rpc('claim_support_message', {
                p_email_id: meta.emailId,
                p_message_id: meta.messageId,
                p_from: meta.from,
                p_to: meta.to,
                p_received_for: meta.receivedFor,
                p_subject: meta.subject,
                p_attachments: meta.attachments,
                p_received_at: meta.receivedAt,
            });
            if (error || !data || typeof data !== 'object') {
                console.error(`claim_support_message failed for ${meta.emailId}: ${error?.message ?? 'no answer'}`);
                return null;
            }
            const row = data as Record<string, unknown>;
            if (row['status'] === 'duplicate') {
                return { status: 'duplicate' };
            }
            if (row['status'] === 'busy') {
                return { status: 'busy', retryAfterSec: Number(row['retry_after_seconds']) || 60 };
            }
            return { status: 'claimed', message: toMessage(row, String(row['holder'])) };
        },
        claimDue: async (limit) => {
            // A lease long enough for the whole batch: it is processed one
            // message after another, each up to a fetch and a send.
            const { data, error } = await admin.rpc('claim_due_support_messages', {
                p_limit: limit,
                p_lease_seconds: RETRY_BATCH_LEASE_SECONDS,
            });
            if (error) {
                console.error(`claim_due_support_messages failed: ${error.message}`);
                return null;
            }
            return ((data ?? []) as Array<Record<string, unknown>>).map((row) =>
                toMessage(row, String(row['lease_holder'])),
            );
        },
        saveBody: async (id, holder, text, html) => {
            const { data, error } = await admin.rpc('save_support_message_body', {
                p_id: id,
                p_holder: holder,
                p_text: text,
                p_html: html,
            });
            if (error) {
                console.error(`save_support_message_body failed for ${id}: ${error.message}`);
                return null;
            }
            return data === true;
        },
        finish: async (id, holder, outcome, detail = {}) => {
            const { data, error } = await admin.rpc('finish_support_message', {
                p_id: id,
                p_holder: holder,
                p_outcome: outcome,
                p_error: detail.error ?? null,
                p_retry_after_seconds: detail.retryAfterSec ?? null,
                p_forward_id: detail.forwardId ?? null,
                p_budget_held: detail.budgetHeld ?? null,
            });
            if (error) {
                console.error(`finish_support_message failed for ${id}: ${error.message}`);
                return null;
            }
            return data === true;
        },
        beginSend: async (id, holder) => {
            const { data, error } = await admin.rpc('begin_support_forward', { p_id: id, p_holder: holder });
            if (error) {
                console.error(`begin_support_forward failed for ${id}: ${error.message}`);
                return null;
            }
            return data === 'send' || data === 'expired' || data === 'lost' ? data : null;
        },
    };
};

const fetchBody = async (
    emailId: string,
): Promise<{ ok: true; text?: string | null; html?: string | null } | { ok: false; detail: string }> => {
    try {
        const res = await fetch(`${RESEND_API}/emails/receiving/${encodeURIComponent(emailId)}`, {
            headers: { Authorization: `Bearer ${env('RESEND_API_KEY') ?? ''}` },
            signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
        });
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            return { ok: false, detail: `fetch ${res.status}` };
        }
        const email = (await res.json()) as { text?: unknown; html?: unknown };
        return {
            ok: true,
            text: typeof email.text === 'string' ? email.text : null,
            html: typeof email.html === 'string' ? email.html : null,
        };
    } catch (err) {
        return { ok: false, detail: String(err).slice(0, 200) };
    }
};

Deno.serve((req) =>
    handleResendInbound(req, {
        json: jsonResponse,
        options: optionsResponse,
        readText: readCappedText,
        verifySignature: async (rawBody, request) => {
            const check = await verifySvixSignature(
                rawBody,
                {
                    id: request.headers.get('svix-id'),
                    timestamp: request.headers.get('svix-timestamp'),
                    signature: request.headers.get('svix-signature'),
                },
                env('RESEND_WEBHOOK_SECRET') ?? '',
                Math.floor(Date.now() / 1000),
            );
            return check.ok ? { ok: true } : { ok: false, reason: check.reason };
        },
        // Present only on the retry tick's POST (support_inbound_retry_tick):
        // compared in constant time with SUPPORT_RETRY_SECRET. Absent, this is a
        // webhook delivery and the Svix signature decides.
        retryAuthorized: async (request) => {
            const given = request.headers.get('x-support-retry-secret');
            if (given === null) {
                return null;
            }
            return secretsEqual(given, env('SUPPORT_RETRY_SECRET'));
        },
        config: {
            signingSecret: env('RESEND_WEBHOOK_SECRET') ?? null,
            apiKey: env('RESEND_API_KEY') ?? null,
            forwardTo: env('SUPPORT_FORWARD_TO') ?? null,
            forwardFrom: forwardFrom(),
        },
        store: store(),
        fetchBody,
        reserveBudget,
        send: (email, idempotencyKey) => sendViaResend({ apiKey: env('RESEND_API_KEY'), idempotencyKey, email }),
        idempotencyKey: resendIdempotencyKey,
        mail: { isOwnForward, inboxTagFor, forwardedSubject },
        logError: (code, message) => logError('resend-inbound', new Error(message), { code }),
    }),
);
