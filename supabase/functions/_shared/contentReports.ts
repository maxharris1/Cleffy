/**
 * Notice and action: the content-report and content-moderation handlers, and
 * the emails they send. The Copyright and Content Policy (/copyright) is the
 * promise; this is what keeps it.
 *
 *  * content-report (no JWT required — a rights holder may have no account):
 *    validate, check the "I'm human" token, and store the report. Storing it
 *    also queues the acknowledgment to the reporter, with a reference and
 *    blind-copied to the legal mailbox so a person hears about it.
 *  * content-moderation (moderators only): restrict or remove a score, lift a
 *    takedown, or reject a report — each through one SQL function
 *    (20261020150000_content_moderation.sql) that also records the strike,
 *    logs the decision, and queues the statement of reasons to the uploader
 *    and the outcome to the reporter.
 *  * content-notices (pg_cron, every five minutes, with a shared secret):
 *    retries whatever is still owed.
 *
 * Every notice goes through content_notice_outbox, written in the same
 * transaction as the report or decision, so a spent mail budget or a Resend
 * outage delays a notice and never loses it. Each of the three functions then
 * delivers what is due (deliverNotices): its own notices first, within the
 * sender's mail budget, each send logged.
 *
 * NO runtime imports, like guestEmail.ts: Deno wants the `.ts` extension and
 * vitest wants it gone, so everything the handlers touch arrives in `deps` and
 * the two index.ts files are only the wiring.
 */

import type * as ReadCapped from './readCappedJson.ts';
import type { ResendResult } from './resendDelivery.ts';

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * Mirrors src/features/moderation/moderationRules.ts, which the policy text
 * quotes; tests/moderation/contentReports.test.ts holds the two equal. The SQL
 * function active_content_strikes() counts over the same 12 months.
 */
export const REPEAT_INFRINGER_STRIKES = 3;
export const STRIKE_WINDOW_MONTHS = 12;

export const REPORT_KINDS = ['copyright', 'illegal'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** What an illegal-content report can be about; copyright reports are always 'copyright'. */
export const ILLEGAL_CATEGORIES = [
    'child_safety',
    'terrorism',
    'hate',
    'violence',
    'privacy',
    'fraud',
    'other',
] as const;
export type IllegalCategory = (typeof ILLEGAL_CATEGORIES)[number];

export const TAKEDOWN_ACTIONS = ['restrict', 'remove'] as const;
export type TakedownAction = (typeof TAKEDOWN_ACTIONS)[number];

export const TAKEDOWN_GROUNDS = ['copyright', 'illegal', 'terms'] as const;
export type TakedownGround = (typeof TAKEDOWN_GROUNDS)[number];

/** Field lengths, as the table's checks enforce them. */
export const REPORT_FIELD_LIMITS = {
    contentUrl: 2000,
    workDescription: 4000,
    explanation: 8000,
    explanationMin: 10,
    name: 200,
    email: 254,
    address: 500,
    phone: 50,
    onBehalfOf: 200,
    signature: 200,
    legalBasis: 1000,
    facts: 4000,
    note: 4000,
} as const;

/**
 * Per-window ceilings. Reports are rare and a real one is a single
 * submission: these stop a script, not a person. Mail to one reporter's
 * mailbox is counted separately so the acknowledgment cannot be aimed at a
 * stranger's inbox in bulk.
 */
export const CONTENT_REPORT_LIMITS = {
    perIp: { limit: 10, windowMs: 60 * 60_000 },
    perReporterDaily: { limit: 5, windowMs: 24 * 60 * 60_000 },
} as const;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ContentReportInput {
    kind: ReportKind;
    category: 'copyright' | IllegalCategory;
    contentUrl: string;
    workDescription: string | null;
    explanation: string;
    reporterName: string;
    reporterEmail: string;
    reporterAddress: string | null;
    reporterPhone: string | null;
    onBehalfOf: string | null;
    goodFaith: true;
    perjuryStatement: boolean;
    signature: string;
}

/** The refusals the form can show, each with a stable code. */
export const CONTENT_REPORT_ERRORS = {
    invalid: (field: string, error: string) => ({ error, code: 'invalid_report', field }),
    unavailable: { error: 'We can’t take reports right now. Email legal@cleffy.io instead.', code: 'unavailable' },
    captchaMissing: { error: 'Finish the “I’m human” check, then try again.', code: 'captcha_missing' },
    captchaFailed: { error: 'That “I’m human” check didn’t go through. Try it again.', code: 'captcha_failed' },
    captchaUnavailable: {
        error: 'We can’t run the “I’m human” check right now. Try again in a moment.',
        code: 'captcha_unavailable',
    },
} as const;

const str = (body: Record<string, unknown>, key: string): string =>
    typeof body[key] === 'string' ? (body[key] as string).trim() : '';

const optional = (value: string): string | null => (value === '' ? null : value);

const EMAIL_SHAPE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+$/;

/** Lower-cased and trimmed, if it looks like an address at all. */
export const normalizeReporterEmail = (raw: string): string | null => {
    const email = raw.trim().toLowerCase();
    return email.length <= REPORT_FIELD_LIMITS.email && EMAIL_SHAPE.test(email) ? email : null;
};

type Parsed<T> = { ok: true; value: T } | { ok: false; field: string; error: string };

/** The form's body → a report the table will accept, or the first field that is wrong. */
export const parseContentReport = (body: Record<string, unknown> | null): Parsed<ContentReportInput> => {
    const fail = (field: string, error: string): Parsed<ContentReportInput> => ({ ok: false, field, error });
    if (!body) {
        return fail('body', 'Send the report as JSON.');
    }
    const kind = str(body, 'kind');
    if (!(REPORT_KINDS as readonly string[]).includes(kind)) {
        return fail('kind', 'Choose what kind of problem you are reporting.');
    }
    let category: ContentReportInput['category'] = 'copyright';
    if (kind === 'illegal') {
        const raw = str(body, 'category');
        if (!(ILLEGAL_CATEGORIES as readonly string[]).includes(raw)) {
            return fail('category', 'Choose what the content is.');
        }
        category = raw as IllegalCategory;
    }
    const contentUrl = str(body, 'contentUrl');
    if (contentUrl === '' || contentUrl.length > REPORT_FIELD_LIMITS.contentUrl) {
        return fail('contentUrl', 'Give the link to the score.');
    }
    const workDescription = optional(str(body, 'workDescription'));
    if (kind === 'copyright' && workDescription === null) {
        return fail('workDescription', 'Identify the copyrighted work.');
    }
    if (workDescription && workDescription.length > REPORT_FIELD_LIMITS.workDescription) {
        return fail('workDescription', 'Shorten the description of the work.');
    }
    const explanation = str(body, 'explanation');
    if (explanation.length < REPORT_FIELD_LIMITS.explanationMin) {
        return fail('explanation', 'Explain why you believe the content is illegal or infringing.');
    }
    if (explanation.length > REPORT_FIELD_LIMITS.explanation) {
        return fail('explanation', 'Shorten your explanation.');
    }
    const reporterName = str(body, 'reporterName');
    if (reporterName === '' || reporterName.length > REPORT_FIELD_LIMITS.name) {
        return fail('reporterName', 'Give your name.');
    }
    const reporterEmail = normalizeReporterEmail(str(body, 'reporterEmail'));
    if (!reporterEmail) {
        return fail('reporterEmail', 'Give an email address we can reply to.');
    }
    const reporterAddress = optional(str(body, 'reporterAddress'));
    if (reporterAddress && reporterAddress.length > REPORT_FIELD_LIMITS.address) {
        return fail('reporterAddress', 'Shorten the address.');
    }
    const reporterPhone = optional(str(body, 'reporterPhone'));
    if (reporterPhone && reporterPhone.length > REPORT_FIELD_LIMITS.phone) {
        return fail('reporterPhone', 'Shorten the phone number.');
    }
    const onBehalfOf = optional(str(body, 'onBehalfOf'));
    if (onBehalfOf && onBehalfOf.length > REPORT_FIELD_LIMITS.onBehalfOf) {
        return fail('onBehalfOf', 'Shorten the rights holder’s name.');
    }
    if (body['goodFaith'] !== true) {
        return fail('goodFaith', 'Confirm the statement of good faith.');
    }
    const perjuryStatement = body['perjuryStatement'] === true;
    if (kind === 'copyright' && !perjuryStatement) {
        return fail('perjuryStatement', 'Confirm the statement made under penalty of perjury.');
    }
    const signature = str(body, 'signature');
    if (signature === '' || signature.length > REPORT_FIELD_LIMITS.signature) {
        return fail('signature', 'Type your full name as your signature.');
    }
    return {
        ok: true,
        value: {
            kind: kind as ReportKind,
            category,
            contentUrl,
            workDescription,
            explanation,
            reporterName,
            reporterEmail,
            reporterAddress,
            reporterPhone,
            onBehalfOf,
            goodFaith: true,
            perjuryStatement,
            signature,
        },
    };
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type DocumentRef = { kind: 'document'; id: string } | { kind: 'share'; token: string };

/**
 * Which score a pasted link names: a viewer link (`/doc/<uuid>`), a share link
 * (`/join/<token>`), or a bare id. Anything else names nothing we can resolve,
 * and the moderator finds the score by hand.
 */
export const documentRefFromUrl = (raw: string): DocumentRef | null => {
    const text = raw.trim();
    const doc = text.match(new RegExp(`/doc/(${UUID.source})`, 'i'));
    if (doc?.[1]) {
        return { kind: 'document', id: doc[1].toLowerCase() };
    }
    const join = text.match(/\/join\/([A-Za-z0-9_-]{8,64})/);
    if (join?.[1]) {
        return { kind: 'share', token: join[1] };
    }
    const bare = text.match(new RegExp(`^(${UUID.source})$`, 'i'));
    return bare?.[1] ? { kind: 'document', id: bare[1].toLowerCase() } : null;
};

// ---------------------------------------------------------------------------
// The emails
// ---------------------------------------------------------------------------

export interface MailMessage {
    subject: string;
    text: string;
    html: string;
}

/** Who sends these notices: legalVersions.ts's LEGAL_OPERATOR. */
export interface Operator {
    name: string;
    postalAddress: string;
    legalEmail: string;
    website: string;
}

export const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/** Paragraphs → the plain and HTML bodies, every one escaped: most of this text came from a stranger. */
const render = (subject: string, paragraphs: string[]): MailMessage => ({
    subject,
    text: paragraphs.join('\n\n'),
    html: [
        '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1917;line-height:1.5">',
        ...paragraphs.map((paragraph) => `<p style="white-space:pre-wrap">${escapeHtml(paragraph)}</p>`),
        '</div>',
    ].join(''),
});

const footer = (operator: Operator): string =>
    `${operator.name}, ${operator.postalAddress} · ${operator.legalEmail} · ${operator.website}/copyright`;

const CATEGORY_LABELS: Record<ContentReportInput['category'], string> = {
    copyright: 'Copyright infringement',
    child_safety: 'Child sexual abuse material or child safety',
    terrorism: 'Terrorist content',
    hate: 'Illegal hate speech',
    violence: 'Threats or incitement to violence',
    privacy: 'Privacy violation or non-consensual imagery',
    fraud: 'Fraud or scam',
    other: 'Other illegal content',
};

export const categoryLabel = (category: ContentReportInput['category']): string => CATEGORY_LABELS[category];

/** What the acknowledgment quotes back: the report as stored. */
export type AcknowledgedReport = Pick<
    ContentReportInput,
    'reporterName' | 'category' | 'contentUrl' | 'workDescription' | 'onBehalfOf' | 'explanation'
>;

/** To the reporter, as soon as the report is stored. */
export const reportAcknowledgment = (report: AcknowledgedReport, reference: string, operator: Operator): MailMessage =>
    render(`We received your report ${reference}`, [
        `Hello ${report.reporterName},`,
        `Thank you for your report. We have received it and a person will review it. Your reference is ${reference}; please quote it if you write to us about this report.`,
        `What you reported: ${categoryLabel(report.category)}\nWhere: ${report.contentUrl}${report.workDescription ? `\nCopyrighted work: ${report.workDescription}` : ''}${report.onBehalfOf ? `\nOn behalf of: ${report.onBehalfOf}` : ''}`,
        `Your explanation:\n${report.explanation}`,
        `We will email you at this address when we have decided what to do. If you did not send this report, you can ignore this email, or reply to tell us.`,
        footer(operator),
    ]);

const ACTION_WORDING: Record<TakedownAction, string> = {
    restrict:
        'We have restricted access to it: it can no longer be shared, everyone you shared it with has lost access to it, and its share links no longer work. You can still open it yourself.',
    remove: 'We have removed it: nobody can open it, including you. It has not been deleted, so it can be restored if your challenge succeeds.',
};

const GROUND_WORDING: Record<TakedownGround, string> = {
    copyright: 'It infringes copyright, which is against the law and our Terms of Service.',
    illegal: 'It is illegal content.',
    terms: 'It breaks our Terms of Service.',
};

export interface StatementOfReasonsInput {
    documentTitle: string | null;
    action: TakedownAction;
    ground: TakedownGround;
    legalBasis: string;
    facts: string;
    /** Whether a report from someone else prompted the decision (DSA Art. 17(3)(b)). */
    fromReport: boolean;
    activeStrikes: number | null;
    decidedAt: string;
}

/**
 * To the uploader: the statement of reasons (DSA Art. 17), and the DMCA
 * counter-notice route for a copyright takedown. Never names the reporter.
 */
export const statementOfReasons = (input: StatementOfReasonsInput, operator: Operator): MailMessage => {
    const title = input.documentTitle?.trim() || 'one of your scores';
    const paragraphs = [
        'Hello,',
        `This is a statement of reasons about your score “${title}” on Cleffy.`,
        `What we did: ${ACTION_WORDING[input.action]} This applies everywhere Cleffy is used. Decided on ${input.decidedAt}.`,
        `Why: ${GROUND_WORDING[input.ground]}\n${input.ground === 'terms' ? 'The term relied on' : 'The law relied on'}: ${input.legalBasis}`,
        `The facts we relied on: ${input.facts}`,
        input.fromReport
            ? 'We acted on a report sent to us by someone else (a notice under our Copyright and Content Policy).'
            : 'We acted on our own initiative.',
        'A person reviewed this and made the decision. No automated means were used to detect the content or to decide.',
    ];
    if (input.ground === 'copyright') {
        paragraphs.push(
            `This takedown is a copyright strike against your account. Active strikes: ${input.activeStrikes ?? 1} (an account with ${REPEAT_INFRINGER_STRIKES} within ${STRIKE_WINDOW_MONTHS} months may be closed). If you believe the score was taken down by mistake or misidentification, you can send a counter-notice to ${operator.legalEmail}; our Copyright and Content Policy (${operator.website}/copyright#counter-notice) lists what it must include.`,
        );
    }
    paragraphs.push(
        `How to challenge this decision: reply to this email, or write to ${operator.legalEmail}, within six months, saying why you think it is wrong. A different person will review it. If you are in the EU you may also refer the dispute to a certified out-of-court dispute settlement body, and in any country you can go to court.`,
        footer(operator),
    );
    return render(`About your score “${title}”: ${input.action === 'remove' ? 'removed' : 'restricted'}`, paragraphs);
};

/** To the reporter, once the report is decided either way (DSA Art. 16(5)). */
export const reporterOutcome = (
    input: {
        reference: string;
        reporterName: string;
        decision: 'actioned' | 'rejected';
        action?: TakedownAction;
        note?: string | null;
    },
    operator: Operator,
): MailMessage =>
    render(`Your report ${input.reference}: ${input.decision === 'actioned' ? 'we took action' : 'our decision'}`, [
        `Hello ${input.reporterName},`,
        input.decision === 'actioned'
            ? `We reviewed your report ${input.reference} and have ${input.action === 'remove' ? 'removed the score, so nobody can open it' : 'restricted the score, so it can no longer be shared'}. We have told the uploader why, without giving them your contact details.`
            : `We reviewed your report ${input.reference} and decided not to take action against the score.${input.note ? `\nWhy: ${input.note}` : ''}`,
        'A person reviewed your report. No automated means were used to decide.',
        `If you disagree, reply to this email, or write to ${operator.legalEmail}, within six months. If you are in the EU you may also refer the dispute to a certified out-of-court dispute settlement body, and in any country you can go to court.`,
        footer(operator),
    ]);

/** To the uploader, when a takedown is lifted. */
export const takedownLifted = (
    input: { documentTitle: string | null; reason: string },
    operator: Operator,
): MailMessage => {
    const title = input.documentTitle?.trim() || 'your score';
    return render(`Your score “${title}” is available again`, [
        'Hello,',
        `We have lifted the restriction on your score “${title}” on Cleffy. It can be opened and shared again as before, and any copyright strike from it has been withdrawn.`,
        `Why: ${input.reason}`,
        footer(operator),
    ]);
};

// ---------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------

/** Whose mail budget a notice spends: MAIL_CATEGORY_CAPS' contentReportAck and moderationNotice. */
export const NOTICE_SENDERS = ['content-report-ack', 'moderation-notice'] as const;
export type NoticeSender = (typeof NOTICE_SENDERS)[number];

export const NOTICE_TEMPLATES = [
    'report_acknowledgment',
    'statement_of_reasons',
    'reporter_outcome',
    'takedown_lifted',
] as const;
export type NoticeTemplate = (typeof NOTICE_TEMPLATES)[number];

/** A claimed content_notice_outbox row. */
export interface OutboxNotice {
    id: string;
    sender: NoticeSender;
    template: NoticeTemplate;
    recipient: string;
    bccLegal: boolean;
    /** What the SQL action recorded, rendered by renderNotice(). */
    payload: Record<string, unknown>;
}

/** How one attempt ended, as finish_content_notice() takes it. */
export type NoticeOutcome = 'sent' | 'failed' | 'unconfigured' | 'deferred';

const field = (payload: Record<string, unknown>, key: string): string | null =>
    typeof payload[key] === 'string' ? (payload[key] as string) : null;

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null =>
    typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null;

/**
 * A queued notice → the email, from what the SQL action recorded. Null for a
 * payload missing what its template needs; the row is then retried as failed
 * (and counted on the moderation page) rather than sent half-written.
 */
export const renderNotice = (notice: OutboxNotice, operator: Operator): MailMessage | null => {
    const p = notice.payload;
    switch (notice.template) {
        case 'report_acknowledgment': {
            const reference = field(p, 'reference');
            const reporterName = field(p, 'reporterName');
            const category = oneOf(['copyright', ...ILLEGAL_CATEGORIES] as const, p['category']);
            const contentUrl = field(p, 'contentUrl');
            const explanation = field(p, 'explanation');
            if (!reference || !reporterName || !category || !contentUrl || !explanation) {
                return null;
            }
            return reportAcknowledgment(
                {
                    reporterName,
                    category,
                    contentUrl,
                    workDescription: field(p, 'workDescription'),
                    onBehalfOf: field(p, 'onBehalfOf'),
                    explanation,
                },
                reference,
                operator,
            );
        }
        case 'statement_of_reasons': {
            const action = oneOf(TAKEDOWN_ACTIONS, p['action']);
            const ground = oneOf(TAKEDOWN_GROUNDS, p['ground']);
            const legalBasis = field(p, 'legalBasis');
            const facts = field(p, 'facts');
            const decidedAt = field(p, 'decidedAt');
            if (!action || !ground || !legalBasis || !facts || !decidedAt) {
                return null;
            }
            return statementOfReasons(
                {
                    documentTitle: field(p, 'documentTitle'),
                    action,
                    ground,
                    legalBasis,
                    facts,
                    fromReport: p['fromReport'] === true,
                    activeStrikes: typeof p['activeStrikes'] === 'number' ? p['activeStrikes'] : null,
                    decidedAt,
                },
                operator,
            );
        }
        case 'reporter_outcome': {
            const reference = field(p, 'reference');
            const reporterName = field(p, 'reporterName');
            const decision = oneOf(['actioned', 'rejected'] as const, p['decision']);
            if (!reference || reporterName === null || !decision) {
                return null;
            }
            return reporterOutcome(
                {
                    reference,
                    reporterName,
                    decision,
                    action: oneOf(TAKEDOWN_ACTIONS, p['action']) ?? undefined,
                    note: field(p, 'note'),
                },
                operator,
            );
        }
        case 'takedown_lifted': {
            const reason = field(p, 'reason');
            return reason ? takedownLifted({ documentTitle: field(p, 'documentTitle'), reason }, operator) : null;
        }
        default:
            return null;
    }
};

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

type Gate = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * What a moderator or reporter is told about one notice: sent now; queued
 * (waiting on the mail budget, or another delivery holds it); failed or
 * unconfigured (queued, retried automatically); skipped (no address to send
 * to — follow up by hand).
 */
export type Delivery = 'sent' | 'queued' | 'failed' | 'unconfigured' | 'skipped';

/** As guestEmail.ts's CaptchaVerdict, restated for the no-runtime-imports reason. */
export type CaptchaVerdict =
    | { ok: true; verified: boolean }
    | { ok: false; code: 'captcha_missing' | 'captcha_failed' | 'captcha_unavailable'; status: number };

const CAPTCHA_REFUSALS = {
    captcha_missing: CONTENT_REPORT_ERRORS.captchaMissing,
    captcha_failed: CONTENT_REPORT_ERRORS.captchaFailed,
    captcha_unavailable: CONTENT_REPORT_ERRORS.captchaUnavailable,
} as const;

/** A window of the project's mail budget (_shared/mailBudget.ts), keyed per sender. */
export type MailBudget = { hour: { limit: number; windowMs: number }; day: { limit: number; windowMs: number } };

export interface CommonDeps {
    json: (body: unknown, status?: number) => Response;
    /**
     * _shared/readCappedJson.ts's readCappedJson, passed in because this file
     * takes no runtime imports: the body read with a streamed cap.
     */
    readJson: typeof ReadCapped.readCappedJson;
    options: () => Response;
    clientKey: (req: Request) => string;
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    /**
     * Mail through Resend (`_shared/resendDelivery.ts`, shared with #62):
     * `sent`, `rejected` (certainly not sent: refused, or no key so no
     * request) or `unknown` (a timeout, network error, 5xx, 408 or 409: it may
     * have gone out). The idempotency key is the outbox row's, the same on
     * every attempt, so a retry after an unknown outcome cannot deliver the
     * notice twice.
     */
    sendEmail: (
        to: string,
        message: MailMessage,
        options: { bcc?: string; idempotencyKey: string },
    ) => Promise<ResendResult>;
    /**
     * `_shared/resendDelivery.ts`'s resendIdempotencyKey, passed in because
     * this file takes no runtime imports. A notice's key is
     * (CONTENT_NOTICE_OUTBOX, its outbox row id): the row's, never the attempt's.
     */
    idempotencyKey: (outbox: string, rowId: string) => string;
    /** Hand back one use of a checkRateLimit bucket (refund_edge_rate_limit); best effort. */
    refundRateLimit: (key: string) => Promise<void>;
    /** Each sender's mail budget. */
    mailBudgets: Record<NoticeSender, MailBudget>;
    /** claim_content_notices(): due rows, `first` first, leased; null when the database is unreachable. */
    claimNotices: (limit: number, first: string[]) => Promise<OutboxNotice[] | null>;
    /** finish_content_notice(). */
    finishNotice: (id: string, outcome: NoticeOutcome, retryAfterSec: number | null) => Promise<void>;
    operator: Operator;
    logError: (message: string, err?: unknown) => void;
    now: () => number;
}

/** The outbox name in a notice's Idempotency-Key (content_notice_outbox). */
export const CONTENT_NOTICE_OUTBOX = 'content-notice-outbox';

/**
 * Whether a send's budget reservation goes back: only when it was certainly
 * not sent (`rejected`, which includes no key and so no request). An
 * `unknown` outcome may have gone out, and keeps it.
 */
export const refundsNoticeBudget = (result: ResendResult): boolean => result.outcome === 'rejected';

/** What the outbox records for a send: retried with backoff unless it went out (or cannot, unconfigured). */
const noticeOutcome = (result: ResendResult): Exclude<NoticeOutcome, 'deferred'> => {
    if (result.outcome === 'sent') {
        return 'sent';
    }
    return result.outcome === 'rejected' && result.reason === 'unconfigured' ? 'unconfigured' : 'failed';
};

type Reservation = { ok: true; keys: string[] } | { ok: false; retryAfterSec: number };

/**
 * The edge rate-limit bucket a sender's mail budget is counted in, per window.
 * resend-inbound's forwards spend the content-report-ack share through these
 * same keys (decision 14), so the two can never add up past the split.
 */
export const mailBudgetKey = (sender: NoticeSender, window: string): string => `mail:${sender}:${window}`;

/**
 * Reserve one unit of a sender's mail budget in every window, or say when
 * there will be some again. A window that refuses hands back what the others
 * reserved: no mail goes out, so none was spent.
 */
const takeMailBudget = async (deps: CommonDeps, sender: NoticeSender): Promise<Reservation> => {
    const keys: string[] = [];
    for (const [window, { limit, windowMs }] of Object.entries(deps.mailBudgets[sender])) {
        const key = mailBudgetKey(sender, window);
        const gate = await deps.checkRateLimit(key, limit, windowMs);
        if (!gate.ok) {
            deps.logError(`${key}: the ceiling on this mail was reached; notices stay queued`);
            await releaseMailBudget(deps, keys);
            return gate;
        }
        keys.push(key);
    }
    return { ok: true, keys };
};

const releaseMailBudget = async (deps: CommonDeps, keys: string[]): Promise<void> => {
    await Promise.all(keys.map((key) => deps.refundRateLimit(key).catch(() => undefined)));
};

/**
 * Deliver what is due from the outbox: `first` (the notices this request just
 * queued) ahead of any backlog, at most `limit`. Answers how each claimed
 * notice went; a notice not claimed (not due, or another delivery holds it)
 * is simply absent.
 *
 * Out of budget, a notice goes back in the queue until the window reopens,
 * and so does every later one from the same sender this round — not an
 * attempt, and nothing dropped. A send that was refused, whose outcome is
 * unknown, or that is not configured is retried with backoff by
 * finish_content_notice(). Only a definite non-send hands its budget back.
 */
export const deliverNotices = async (
    deps: CommonDeps,
    first: string[],
    limit: number,
): Promise<Map<string, Exclude<Delivery, 'skipped'>>> => {
    const outcomes = new Map<string, Exclude<Delivery, 'skipped'>>();
    const claimed = await deps.claimNotices(limit, first);
    if (!claimed) {
        return outcomes;
    }
    const outOfBudget = new Map<NoticeSender, number>();
    for (const notice of claimed) {
        let retryAfter = outOfBudget.get(notice.sender);
        let reserved: string[] = [];
        if (retryAfter === undefined) {
            const gate = await takeMailBudget(deps, notice.sender);
            if (!gate.ok) {
                retryAfter = gate.retryAfterSec;
                outOfBudget.set(notice.sender, retryAfter);
            } else {
                reserved = gate.keys;
            }
        }
        if (retryAfter !== undefined) {
            await deps.finishNotice(notice.id, 'deferred', retryAfter);
            outcomes.set(notice.id, 'queued');
            continue;
        }
        const message = renderNotice(notice, deps.operator);
        if (!message) {
            deps.logError(`content notice ${notice.id}: its ${notice.template} payload is incomplete`);
            // Nothing was sent: the reservation goes back.
            await releaseMailBudget(deps, reserved);
            await deps.finishNotice(notice.id, 'failed', null);
            outcomes.set(notice.id, 'failed');
            continue;
        }
        const sent = await deps.sendEmail(notice.recipient, message, {
            ...(notice.bccLegal ? { bcc: deps.operator.legalEmail } : {}),
            idempotencyKey: deps.idempotencyKey(CONTENT_NOTICE_OUTBOX, notice.id),
        });
        // Kept unless the mail definitely did not go out: an unknown outcome
        // may have spent it, and the retry (same key) cannot send it twice.
        if (refundsNoticeBudget(sent)) {
            await releaseMailBudget(deps, reserved);
        }
        const delivery = noticeOutcome(sent);
        await deps.finishNotice(notice.id, delivery, null);
        outcomes.set(notice.id, delivery);
    }
    return outcomes;
};

/** How a notice the request queued went: its outcome, queued if not claimed, skipped if never queued. */
const deliveryOf = (outcomes: Map<string, Exclude<Delivery, 'skipped'>>, id: string | null): Delivery =>
    id === null ? 'skipped' : (outcomes.get(id) ?? 'queued');

/** How many notices one request delivers, its own first: enough to clear a small backlog, never a long wait. */
const DELIVER_PER_REQUEST = 5;

/**
 * The cap on a report or moderation body, counted as it streams (Content-Length
 * is not trusted). Above readCappedJson.ts's 16 KiB control cap on purpose:
 * REPORT_FIELD_LIMITS allow about 20,000 characters of text, and a character
 * can take several bytes once UTF-8 and JSON-escaped, plus the captcha token.
 */
export const REPORT_BODY_MAX_BYTES = 128 * 1024;
const PAYLOAD_TOO_LARGE = { error: 'Request body too large', code: 'payload_too_large' } as const;

/** The body as an object; null for anything else, 'too_large' past REPORT_BODY_MAX_BYTES. */
const readBody = async (req: Request, deps: CommonDeps): Promise<Record<string, unknown> | null | 'too_large'> => {
    const read = await deps.readJson(req, REPORT_BODY_MAX_BYTES);
    if (!read.ok) {
        return read.status === 413 ? 'too_large' : null;
    }
    const body = read.value;
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
};

const tooMany = (json: CommonDeps['json'], retryAfterSec: number): Response =>
    json(
        {
            error: `Too many reports from here. Wait ${retryAfterSec < 90 ? `${retryAfterSec} seconds` : `${Math.ceil(retryAfterSec / 60)} minutes`}, or email legal@cleffy.io.`,
            code: 'rate_limited',
            retryAfterSec,
        },
        429,
    );

export interface ContentReportDeps extends CommonDeps {
    verifyCaptcha: (req: Request, body: Record<string, unknown> | null) => Promise<CaptchaVerdict>;
    /** The signed-in reporter, if the request carries a valid user JWT; null otherwise (never a refusal). */
    optionalUserId: (req: Request) => Promise<string | null>;
    /** HMAC of the reporter's mailbox, for the per-reporter limit: the bucket never holds an address. */
    reporterKey: (email: string) => Promise<string | null>;
    resolveDocument: (ref: DocumentRef) => Promise<string | null>;
    /**
     * Store the report. The insert also logs it and queues its acknowledgment
     * (content_reports_enqueue_ack), whose outbox id comes back here.
     */
    saveReport: (
        report: ContentReportInput & { documentId: string | null; reporterUserId: string | null },
    ) => Promise<{ id: string; reference: string; ackNoticeId: string | null } | null>;
}

/**
 * content-report: the form's body → a stored report and an acknowledgment.
 *
 * The answer carries the reference either way: a report whose acknowledgment
 * is still queued is still a report, and the page shows the reference so the
 * reporter has it meanwhile.
 */
export const handleContentReport = async (req: Request, deps: ContentReportDeps): Promise<Response> => {
    const { json } = deps;
    if (req.method === 'OPTIONS') {
        return deps.options();
    }
    if (req.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }
    const ipGate = await deps.checkRateLimit(
        `content-report:ip:${deps.clientKey(req)}`,
        CONTENT_REPORT_LIMITS.perIp.limit,
        CONTENT_REPORT_LIMITS.perIp.windowMs,
    );
    if (!ipGate.ok) {
        return tooMany(json, ipGate.retryAfterSec);
    }

    const body = await readBody(req, deps);
    if (body === 'too_large') {
        return json(PAYLOAD_TOO_LARGE, 413);
    }
    const parsed = parseContentReport(body);
    if (!parsed.ok) {
        return json(CONTENT_REPORT_ERRORS.invalid(parsed.field, parsed.error), 422);
    }
    const report = parsed.value;

    // After the cheap local checks, before anything that stores or mails: the
    // same placement, for the same reasons, as guest-email-start's gate.
    const captcha = await deps.verifyCaptcha(req, body);
    if (!captcha.ok) {
        return json(CAPTCHA_REFUSALS[captcha.code], captcha.status);
    }

    const reporterKey = await deps.reporterKey(report.reporterEmail);
    if (!reporterKey) {
        deps.logError('content-report: no secret to key the reporter limit with');
        return json(CONTENT_REPORT_ERRORS.unavailable, 503);
    }
    const reporterGate = await deps.checkRateLimit(
        reporterKey,
        CONTENT_REPORT_LIMITS.perReporterDaily.limit,
        CONTENT_REPORT_LIMITS.perReporterDaily.windowMs,
    );
    if (!reporterGate.ok) {
        return tooMany(json, reporterGate.retryAfterSec);
    }

    const ref = documentRefFromUrl(report.contentUrl);
    const documentId = ref ? await deps.resolveDocument(ref) : null;
    const reporterUserId = await deps.optionalUserId(req);

    const saved = await deps.saveReport({ ...report, documentId, reporterUserId });
    if (!saved) {
        return json(CONTENT_REPORT_ERRORS.unavailable, 503);
    }

    const first = saved.ackNoticeId ? [saved.ackNoticeId] : [];
    const outcomes = await deliverNotices(deps, first, DELIVER_PER_REQUEST);
    const delivery = deliveryOf(outcomes, saved.ackNoticeId);
    return json({ reference: saved.reference, acknowledged: delivery === 'sent', delivery }, 201);
};

export interface TakedownResult {
    takedownId: string;
    uploaderId: string | null;
    documentTitle: string | null;
    activeStrikes: number | null;
    /** The queued statement of reasons; null when the uploader has no address. */
    uploaderNoticeId: string | null;
    /** The queued outcome to the reporter; null without a report. */
    reporterNoticeId: string | null;
}

/** A refusal from one of the SQL actions, by its `detail` code. */
export type ActionRefusal =
    'document_not_found' | 'already_taken_down' | 'report_not_found' | 'takedown_not_found' | 'report_not_open';

export interface ContentModerationDeps extends CommonDeps {
    /** The caller's user id from the JWT, or the Response refusing it. */
    authenticate: (req: Request) => Promise<string | Response>;
    isModerator: (userId: string) => Promise<boolean | null>;
    resolveDocument: (ref: DocumentRef) => Promise<string | null>;
    applyTakedown: (input: {
        documentId: string;
        action: TakedownAction;
        ground: TakedownGround;
        legalBasis: string;
        facts: string;
        reportId: string | null;
        moderatorId: string;
    }) => Promise<TakedownResult | ActionRefusal | null>;
    liftTakedown: (input: {
        takedownId: string;
        reason: string;
        moderatorId: string;
    }) => Promise<{ uploaderNoticeId: string | null } | ActionRefusal | null>;
    rejectReport: (input: {
        reportId: string;
        note: string;
        moderatorId: string;
    }) => Promise<{ reporterNoticeId: string | null } | ActionRefusal | null>;
}

const REFUSAL_STATUS: Record<ActionRefusal, { status: number; error: string }> = {
    document_not_found: { status: 404, error: 'No score with that id or link.' },
    already_taken_down: { status: 409, error: 'That score is already taken down. Lift it first to change the action.' },
    report_not_found: { status: 404, error: 'No report with that id.' },
    takedown_not_found: { status: 404, error: 'That takedown is not live.' },
    report_not_open: { status: 409, error: 'That report has already been decided.' },
};

const isRefusal = (value: unknown): value is ActionRefusal => typeof value === 'string' && value in REFUSAL_STATUS;

const UUID_ONLY = new RegExp(`^${UUID.source}$`, 'i');

const boundedText = (body: Record<string, unknown>, key: string, max: number): string | null => {
    const value = str(body, key);
    return value === '' || value.length > max ? null : value;
};

/**
 * content-moderation: `{ action: 'takedown' | 'lift' | 'reject', … }` from a
 * moderator. The decision and the notices it owes commit together; this
 * request then tries to send them, and the answer says how each went, so the
 * moderator knows which are sent, which are queued (they go out by
 * themselves), and which have no address and need following up by hand.
 */
export const handleContentModeration = async (req: Request, deps: ContentModerationDeps): Promise<Response> => {
    const { json } = deps;
    if (req.method === 'OPTIONS') {
        return deps.options();
    }
    if (req.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }
    const caller = await deps.authenticate(req);
    if (caller instanceof Response) {
        return caller;
    }
    const moderator = await deps.isModerator(caller);
    if (moderator === null) {
        return json({ error: 'Could not check your access. Try again.', code: 'unavailable' }, 503);
    }
    if (!moderator) {
        return json({ error: 'Moderators only.', code: 'not_moderator' }, 403);
    }

    const read = await readBody(req, deps);
    if (read === 'too_large') {
        return json(PAYLOAD_TOO_LARGE, 413);
    }
    const body = read ?? {};
    const invalid = (field: string, error: string) => json({ error, code: 'invalid_request', field }, 422);

    const deliver = async (ids: Array<string | null>) =>
        deliverNotices(
            deps,
            ids.filter((id): id is string => id !== null),
            DELIVER_PER_REQUEST,
        );

    const action = str(body, 'action');
    if (action === 'takedown') {
        const mode = str(body, 'mode');
        if (!(TAKEDOWN_ACTIONS as readonly string[]).includes(mode)) {
            return invalid('mode', 'Choose restrict or remove.');
        }
        const ground = str(body, 'ground');
        if (!(TAKEDOWN_GROUNDS as readonly string[]).includes(ground)) {
            return invalid('ground', 'Choose the ground: copyright, illegal or terms.');
        }
        const legalBasis = boundedText(body, 'legalBasis', REPORT_FIELD_LIMITS.legalBasis);
        if (!legalBasis) {
            return invalid('legalBasis', 'Name the law or term relied on.');
        }
        const facts = boundedText(body, 'facts', REPORT_FIELD_LIMITS.facts);
        if (!facts) {
            return invalid('facts', 'State the facts relied on.');
        }
        const reportId = str(body, 'reportId') || null;
        if (reportId && !UUID_ONLY.test(reportId)) {
            return invalid('reportId', 'That is not a report id.');
        }
        const ref = documentRefFromUrl(str(body, 'document'));
        const documentId = ref ? await deps.resolveDocument(ref) : null;
        if (!documentId) {
            return invalid('document', 'Give the score’s link or id.');
        }

        const result = await deps.applyTakedown({
            documentId,
            action: mode as TakedownAction,
            ground: ground as TakedownGround,
            legalBasis,
            facts,
            reportId,
            moderatorId: caller,
        });
        if (result === null) {
            return json({ error: 'The takedown could not be saved. Try again.', code: 'unavailable' }, 503);
        }
        if (isRefusal(result)) {
            return json({ error: REFUSAL_STATUS[result].error, code: result }, REFUSAL_STATUS[result].status);
        }

        const outcomes = await deliver([result.uploaderNoticeId, result.reporterNoticeId]);
        return json({
            takedownId: result.takedownId,
            activeStrikes: result.activeStrikes,
            repeatInfringer: (result.activeStrikes ?? 0) >= REPEAT_INFRINGER_STRIKES,
            delivery: {
                uploader: deliveryOf(outcomes, result.uploaderNoticeId),
                reporter: reportId ? deliveryOf(outcomes, result.reporterNoticeId) : null,
            },
        });
    }

    if (action === 'lift') {
        const takedownId = str(body, 'takedownId');
        if (!UUID_ONLY.test(takedownId)) {
            return invalid('takedownId', 'That is not a takedown id.');
        }
        const reason = boundedText(body, 'reason', REPORT_FIELD_LIMITS.note);
        if (!reason) {
            return invalid('reason', 'Say why the takedown is lifted.');
        }
        const result = await deps.liftTakedown({ takedownId, reason, moderatorId: caller });
        if (result === null) {
            return json({ error: 'The change could not be saved. Try again.', code: 'unavailable' }, 503);
        }
        if (isRefusal(result)) {
            return json({ error: REFUSAL_STATUS[result].error, code: result }, REFUSAL_STATUS[result].status);
        }
        const outcomes = await deliver([result.uploaderNoticeId]);
        return json({ lifted: true, delivery: { uploader: deliveryOf(outcomes, result.uploaderNoticeId) } });
    }

    if (action === 'reject') {
        const reportId = str(body, 'reportId');
        if (!UUID_ONLY.test(reportId)) {
            return invalid('reportId', 'That is not a report id.');
        }
        const note = boundedText(body, 'note', REPORT_FIELD_LIMITS.note);
        if (!note) {
            return invalid('note', 'Say why no action is taken; the reporter is told.');
        }
        const result = await deps.rejectReport({ reportId, note, moderatorId: caller });
        if (result === null) {
            return json({ error: 'The decision could not be saved. Try again.', code: 'unavailable' }, 503);
        }
        if (isRefusal(result)) {
            return json({ error: REFUSAL_STATUS[result].error, code: result }, REFUSAL_STATUS[result].status);
        }
        const outcomes = await deliver([result.reporterNoticeId]);
        return json({ rejected: true, delivery: { reporter: deliveryOf(outcomes, result.reporterNoticeId) } });
    }

    return invalid('action', 'Unknown action.');
};

export interface ContentNoticesDeps extends CommonDeps {
    /** Whether the request carries the scheduler's secret; null when none is configured. */
    authorized: (req: Request) => Promise<boolean | null>;
}

/** Rounds of claims one scheduled run makes: 50 notices at most, inside an Edge Function's time. */
const RETRY_ROUNDS = 5;
const RETRY_BATCH = 10;

/**
 * content-notices: the retry. pg_cron (content_notice_retry_tick) posts here
 * every five minutes while anything is due; it delivers in rounds until
 * nothing due is left or a sender's budget is spent.
 */
export const handleContentNotices = async (req: Request, deps: ContentNoticesDeps): Promise<Response> => {
    const { json } = deps;
    if (req.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }
    const authorized = await deps.authorized(req);
    if (authorized === null) {
        return json({ error: 'Not configured.', code: 'unavailable' }, 503);
    }
    if (!authorized) {
        return json({ error: 'Forbidden.', code: 'forbidden' }, 403);
    }
    const counts: Record<Exclude<Delivery, 'skipped'>, number> = {
        sent: 0,
        queued: 0,
        failed: 0,
        unconfigured: 0,
    };
    for (let round = 0; round < RETRY_ROUNDS; round += 1) {
        const outcomes = await deliverNotices(deps, [], RETRY_BATCH);
        for (const outcome of outcomes.values()) {
            counts[outcome] += 1;
        }
        // Nothing more due, or everything left is waiting on a budget window.
        if (outcomes.size < RETRY_BATCH || [...outcomes.values()].every((outcome) => outcome === 'queued')) {
            break;
        }
    }
    return json(counts);
};
