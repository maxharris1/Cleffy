import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from './cors.ts';
import type { DocumentRef, MailMessage, NoticeLogEntry } from './contentReports.ts';
import { logError } from './errorReporting.ts';
import { LEGAL_OPERATOR } from './legalVersions.ts';
import { checkRateLimit, clientKey, serviceClient } from './rateLimit.ts';

/**
 * What content-report and content-moderation run against — the Deno half of
 * _shared/contentReports.ts, which holds the control flow and says why.
 */

const RESEND_API = 'https://api.resend.com';

/**
 * The sender: the same verified domain and address as the guest-email codes
 * (DEPLOY.md §7). Replies go to the legal mailbox, which is where a reporter
 * or an uploader answering a decision should land.
 */
const mailFrom = (): string => Deno.env.get('CONTENT_NOTICE_FROM') ?? 'Cleffy <noreply@cleffy.io>';

export const common = {
    json: jsonResponse,
    options: optionsResponse,
    clientKey,
    checkRateLimit,
    operator: {
        name: LEGAL_OPERATOR.name,
        postalAddress: LEGAL_OPERATOR.postalAddress,
        legalEmail: LEGAL_OPERATOR.legalEmail,
        website: LEGAL_OPERATOR.website,
    },
    logError: (message: string, err?: unknown) =>
        logError('content-moderation', err ?? new Error(message), { code: message }),
    now: () => Date.now(),
};

export const sendEmail = async (
    to: string,
    message: MailMessage,
    options?: { bcc?: string },
): Promise<'sent' | 'failed' | 'unconfigured'> => {
    const apiKey = Deno.env.get('RESEND_API_KEY');
    if (!apiKey) {
        return 'unconfigured';
    }
    try {
        const res = await fetch(`${RESEND_API}/emails`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: mailFrom(),
                to: [to],
                ...(options?.bcc ? { bcc: [options.bcc] } : {}),
                reply_to: LEGAL_OPERATOR.legalEmail,
                ...message,
            }),
        });
        if (!res.ok) {
            // The status and Resend's reason, never the address or the body.
            logError('content-moderation', new Error(`resend returned ${res.status}`), {
                code: 'send_failed',
                detail: (await res.text()).slice(0, 300),
            });
            return 'failed';
        }
        return 'sent';
    } catch (err) {
        logError('content-moderation', err, { code: 'send_failed' });
        return 'failed';
    }
};

export const logNotice = async (entry: NoticeLogEntry): Promise<void> => {
    const admin = serviceClient();
    if (!admin) {
        return;
    }
    const { error } = await admin.from('content_notice_log').insert({
        event: entry.event,
        report_id: entry.reportId ?? null,
        takedown_id: entry.takedownId ?? null,
        recipient: entry.recipient ?? null,
        delivery: entry.delivery ?? null,
        actor_id: entry.actorId ?? null,
        detail: entry.detail ?? {},
    });
    if (error) {
        // The decision itself is already committed; a lost log row is reported, not fatal.
        logError('content-moderation', new Error(`notice log insert failed: ${error.message}`), {
            code: 'log_failed',
        });
    }
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
