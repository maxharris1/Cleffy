import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from './cors.ts';
import {
    NOTICE_SENDERS,
    NOTICE_TEMPLATES,
    type DocumentRef,
    type MailMessage,
    type NoticeOutcome,
    type OutboxNotice,
} from './contentReports.ts';
import { logError } from './errorReporting.ts';
import { LEGAL_OPERATOR } from './legalVersions.ts';
import { mailLimit } from './mailBudget.ts';
import { resendIdempotencyKey, sendViaResend, type ResendResult } from './resendDelivery.ts';
import { checkRateLimit, clientKey, refundRateLimit, serviceClient } from './rateLimit.ts';

/**
 * What content-report and content-moderation run against — the Deno half of
 * _shared/contentReports.ts, which holds the control flow and says why.
 */

/**
 * The sender: the same verified domain and address as the guest-email codes
 * (DEPLOY.md §7). Replies go to the legal mailbox, which is where a reporter
 * or an uploader answering a decision should land.
 */
const mailFrom = (): string => Deno.env.get('CONTENT_NOTICE_FROM') ?? 'Cleffy <noreply@cleffy.io>';

const env = (name: string): string | undefined => Deno.env.get(name);

/** A content_notice_outbox row as claim_content_notices() returns it → the handler's shape. */
const toNotice = (row: Record<string, unknown>): OutboxNotice | null => {
    const sender = NOTICE_SENDERS.find((value) => value === row['sender']);
    const template = NOTICE_TEMPLATES.find((value) => value === row['template']);
    const payload = row['payload'];
    if (
        typeof row['id'] !== 'string' ||
        typeof row['recipient'] !== 'string' ||
        !sender ||
        !template ||
        !payload ||
        typeof payload !== 'object'
    ) {
        return null;
    }
    return {
        id: row['id'],
        sender,
        template,
        recipient: row['recipient'],
        bccLegal: row['bcc_legal'] === true,
        payload: payload as Record<string, unknown>,
    };
};

export const common = {
    json: jsonResponse,
    options: optionsResponse,
    clientKey,
    checkRateLimit,
    refundRateLimit,
    idempotencyKey: resendIdempotencyKey,
    operator: {
        name: LEGAL_OPERATOR.name,
        postalAddress: LEGAL_OPERATOR.postalAddress,
        legalEmail: LEGAL_OPERATOR.legalEmail,
        website: LEGAL_OPERATOR.website,
    },
    logError: (message: string, err?: unknown) =>
        logError('content-moderation', err ?? new Error(message), { code: message }),
    now: () => Date.now(),
    mailBudgets: {
        'content-report-ack': {
            hour: mailLimit('contentReportAck', 'hour', env),
            day: mailLimit('contentReportAck', 'day', env),
        },
        'moderation-notice': {
            hour: mailLimit('moderationNotice', 'hour', env),
            day: mailLimit('moderationNotice', 'day', env),
        },
    },
    claimNotices: async (limit: number, first: string[]): Promise<OutboxNotice[] | null> => {
        const admin = serviceClient();
        if (!admin) {
            return null;
        }
        const { data, error } = await admin.rpc('claim_content_notices', { p_limit: limit, p_first: first });
        if (error) {
            logError('content-moderation', new Error(`claim_content_notices failed: ${error.message}`), {
                code: 'outbox_claim_failed',
            });
            return null;
        }
        return ((data ?? []) as Array<Record<string, unknown>>)
            .map(toNotice)
            .filter((notice): notice is OutboxNotice => notice !== null);
    },
    finishNotice: async (id: string, outcome: NoticeOutcome, retryAfterSec: number | null): Promise<void> => {
        const admin = serviceClient();
        if (!admin) {
            return;
        }
        const { error } = await admin.rpc('finish_content_notice', {
            p_id: id,
            p_outcome: outcome,
            p_retry_after_seconds: retryAfterSec,
        });
        if (error) {
            // The row's lease runs out and it is claimed again; the idempotency
            // key stops a sent one going out twice.
            logError('content-moderation', new Error(`finish_content_notice failed: ${error.message}`), {
                code: 'outbox_finish_failed',
            });
        }
    },
};

export const sendEmail = async (
    to: string,
    message: MailMessage,
    options: { bcc?: string; idempotencyKey: string },
): Promise<ResendResult> => {
    const result = await sendViaResend({
        apiKey: Deno.env.get('RESEND_API_KEY'),
        // The outbox row's key (content-notice-outbox-{id}), the same on every
        // attempt: Resend answers a repeat with the first send's result, so a
        // notice retried after an unknown outcome is not delivered twice.
        idempotencyKey: options.idempotencyKey,
        email: {
            from: mailFrom(),
            to: [to],
            ...(options.bcc ? { bcc: [options.bcc] } : {}),
            reply_to: LEGAL_OPERATOR.legalEmail,
            ...message,
        },
    });
    if (result.outcome !== 'sent' && result.reason !== 'unconfigured') {
        // The outcome, status and Resend's reason, never the address or the body.
        logError('content-moderation', new Error(`resend ${result.outcome}: ${result.reason}`), {
            code: 'send_failed',
            detail: result.errorName ?? result.detail ?? '',
        });
    }
    return result;
};

/** A viewer link's score if it exists, or the score a share link (live or not) points at. */
export const resolveDocument = async (ref: DocumentRef): Promise<string | null> => {
    const admin = serviceClient();
    if (!admin) {
        return null;
    }
    if (ref.kind === 'document') {
        const { data } = await admin.from('documents').select('id').eq('id', ref.id).maybeSingle();
        return (data as { id?: string } | null)?.id ?? null;
    }
    const { data } = await admin.from('share_links').select('document_id').eq('token', ref.token).maybeSingle();
    return (data as { document_id?: string } | null)?.document_id ?? null;
};

/**
 * The caller's user id when the request carries a valid user JWT, for a
 * function deployed without JWT verification. Anything else — no header, the
 * bare anon key, an expired token — is a signed-out caller, never a refusal.
 */
export const optionalUserId = async (req: Request): Promise<string | null> => {
    const header = req.headers.get('Authorization');
    const url = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!header?.startsWith('Bearer ') || !url || !anonKey || header === `Bearer ${anonKey}`) {
        return null;
    }
    try {
        const client = createClient(url, anonKey, {
            global: { headers: { Authorization: header } },
            auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data } = await client.auth.getUser();
        return data.user?.id ?? null;
    } catch {
        return null;
    }
};

/** The `detail` code a SQL action raised, if it is one the handler knows. */
export const refusalCode = (error: { details?: string | null } | null): string | null => {
    if (!error?.details) {
        return null;
    }
    try {
        const parsed = JSON.parse(error.details) as { code?: unknown };
        return typeof parsed.code === 'string' ? parsed.code : null;
    } catch {
        return null;
    }
};
