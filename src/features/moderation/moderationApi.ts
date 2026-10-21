import { callEdgeFunction } from '@/features/billing/billingApi';
import { getSupabase, requireSupabaseConfig } from '@/lib/supabase';
import { z } from '@/lib/zod';

/**
 * The browser's side of notice and action: submit a report (signed in or
 * not), and — for moderators — read the queue and act on it. The rules and
 * the emails live in supabase/functions/_shared/contentReports.ts.
 */

export type ReportKind = 'copyright' | 'illegal';

export const ILLEGAL_CATEGORY_LABELS = {
    child_safety: 'Child sexual abuse material or child safety',
    terrorism: 'Terrorist content',
    hate: 'Illegal hate speech',
    violence: 'Threats or incitement to violence',
    privacy: 'Privacy violation or non-consensual imagery',
    fraud: 'Fraud or scam',
    other: 'Other illegal content',
} as const;

export type IllegalCategory = keyof typeof ILLEGAL_CATEGORY_LABELS;

export interface ContentReportPayload {
    kind: ReportKind;
    category?: IllegalCategory;
    contentUrl: string;
    workDescription?: string;
    explanation: string;
    reporterName: string;
    reporterEmail: string;
    reporterAddress?: string;
    reporterPhone?: string;
    onBehalfOf?: string;
    goodFaith: boolean;
    perjuryStatement: boolean;
    signature: string;
}

/** A refusal the form can show next to the field it is about. */
export class ReportError extends Error {
    constructor(
        message: string,
        readonly code: string,
        readonly field: string | null = null,
    ) {
        super(message);
    }
}

const errorBody = z.object({
    error: z.string().optional(),
    code: z.string().optional(),
    field: z.string().optional(),
});

const refusalFrom = async (response: Response, fallback: string): Promise<ReportError> => {
    try {
        const body = errorBody.parse(await response.json());
        return new ReportError(body.error ?? fallback, body.code ?? 'unknown', body.field ?? null);
    } catch {
        return new ReportError(fallback, 'unknown');
    }
};

/**
 * Send a report. A bare fetch, like the student sign-in functions: the
 * function is deployed without JWT verification so a rights holder with no
 * account can use it. A signed-in reporter's token rides along so the report
 * is linked to their account — the server checks it, and treats anything it
 * cannot verify as a signed-out report rather than refusing.
 */
export const submitContentReport = async (
    payload: ContentReportPayload,
    captchaToken: string | null,
): Promise<{ reference: string; acknowledged: boolean }> => {
    const { url, anonKey } = requireSupabaseConfig();
    const { data } = await getSupabase().auth.getSession();
    const accessToken = data.session?.access_token;

    let response: Response;
    try {
        response = await fetch(`${url}/functions/v1/content-report`, {
            method: 'POST',
            headers: {
                apikey: anonKey,
                'Content-Type': 'application/json',
                ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
            },
            body: JSON.stringify({ ...payload, captchaToken }),
        });
    } catch {
        throw new ReportError('Could not reach Cleffy. Check your connection and try again.', 'network');
    }
    if (!response.ok) {
        throw await refusalFrom(response, 'Could not send the report. Try again, or email legal@cleffy.io.');
    }
    const body = z.object({ reference: z.string(), acknowledged: z.boolean() }).parse(await response.json());
    return body;
};

/** Whether the signed-in account is a moderator. False on any failure: the server decides anyway. */
export const isContentModerator = async (): Promise<boolean> => {
    try {
        const { data, error } = await getSupabase().rpc('is_content_moderator');
        return !error && data === true;
    } catch {
        return false;
    }
};

const reportRow = z.object({
    id: z.string(),
    reference: z.string(),
    created_at: z.string(),
    kind: z.enum(['copyright', 'illegal']),
    category: z.string(),
    content_url: z.string(),
    document_id: z.string().nullable(),
    document_title: z.string().nullable(),
    work_description: z.string().nullable(),
    explanation: z.string(),
    reporter_name: z.string(),
    reporter_email: z.string(),
    on_behalf_of: z.string().nullable(),
    status: z.enum(['received', 'actioned', 'rejected']),
    decided_at: z.string().nullable(),
    decision_note: z.string().nullable(),
    acknowledged_at: z.string().nullable(),
    active_takedown_id: z.string().nullable(),
});

const takedownRow = z.object({
    id: z.string(),
    document_id: z.string().nullable(),
    document_title: z.string().nullable(),
    report_id: z.string().nullable(),
    uploader_id: z.string().nullable(),
    action: z.enum(['restrict', 'remove']),
    ground: z.enum(['copyright', 'illegal', 'terms']),
    legal_basis: z.string(),
    facts: z.string(),
    created_at: z.string(),
    lifted_at: z.string().nullable(),
    lift_reason: z.string().nullable(),
    uploader_active_strikes: z.number(),
});

const logRow = z.object({
    id: z.number(),
    created_at: z.string(),
    report_id: z.string().nullable(),
    takedown_id: z.string().nullable(),
    event: z.string(),
    recipient: z.string().nullable(),
    delivery: z.string().nullable(),
});

const queueSchema = z.object({
    reports: z.array(reportRow),
    takedowns: z.array(takedownRow),
    log: z.array(logRow),
});

export type ModerationQueue = z.infer<typeof queueSchema>;
export type ContentReportRow = z.infer<typeof reportRow>;
export type TakedownRow = z.infer<typeof takedownRow>;

/** The queue, the takedowns and the notice log (moderation_queue, which refuses non-moderators). */
export const fetchModerationQueue = async (): Promise<ModerationQueue> => {
    const { data, error } = await getSupabase().rpc('moderation_queue');
    if (error) {
        throw new Error(error.code === '42501' ? 'Moderators only.' : 'Could not load the reports.');
    }
    return queueSchema.parse(data);
};

export type ModerationAction =
    | {
          action: 'takedown';
          document: string;
          reportId?: string;
          mode: 'restrict' | 'remove';
          ground: 'copyright' | 'illegal' | 'terms';
          legalBasis: string;
          facts: string;
      }
    | { action: 'lift'; takedownId: string; reason: string }
    | { action: 'reject'; reportId: string; note: string };

const deliveryWords: Record<string, string> = {
    sent: 'emailed',
    failed: 'email FAILED — follow up by hand',
    unconfigured: 'email not configured on this deploy — follow up by hand',
    skipped: 'not emailed (no address, or the mail budget is spent) — follow up by hand',
};

/** One line for each email the action sent, for the moderator to read. */
export const describeDeliveries = (delivery: Record<string, string | null> | undefined): string =>
    Object.entries(delivery ?? {})
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .map(
            ([who, outcome]) => `${who === 'uploader' ? 'Uploader' : 'Reporter'}: ${deliveryWords[outcome] ?? outcome}`,
        )
        .join('. ');

/** Take a moderation action; resolves to a sentence saying what happened, mail included. */
export const moderate = async (request: ModerationAction): Promise<string> => {
    const response = await callEdgeFunction('content-moderation', request);
    if (!response.ok) {
        throw await refusalFrom(response, 'The action failed. Try again.');
    }
    const body = z
        .object({
            activeStrikes: z.number().nullable().optional(),
            repeatInfringer: z.boolean().optional(),
            delivery: z.record(z.string(), z.string().nullable()).optional(),
        })
        .parse(await response.json());
    const done =
        request.action === 'takedown'
            ? `Score ${request.mode === 'remove' ? 'removed' : 'restricted'}.`
            : request.action === 'lift'
              ? 'Takedown lifted.'
              : 'Report rejected.';
    const strikes =
        request.action === 'takedown' && typeof body.activeStrikes === 'number'
            ? ` Uploader’s active strikes: ${body.activeStrikes}${body.repeatInfringer ? ' — repeat-infringer threshold reached; consider closing the account.' : '.'}`
            : '';
    const mail = describeDeliveries(body.delivery);
    return `${done}${strikes}${mail ? ` ${mail}.` : ''}`;
};
