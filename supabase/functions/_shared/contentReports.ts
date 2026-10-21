/**
 * Notice and action: the content-report and content-moderation handlers, and
 * the emails they send. The Copyright and Content Policy (/copyright) is the
 * promise; this is what keeps it.
 *
 *  * content-report (no JWT required — a rights holder may have no account):
 *    validate, check the "I'm human" token, store the report, and email the
 *    reporter an acknowledgment with a reference, blind-copied to the legal
 *    mailbox so a person hears about it.
 *  * content-moderation (moderators only): restrict or remove a score, lift a
 *    takedown, or reject a report — each through one SQL function
 *    (20261020150000_content_moderation.sql) that also records the strike and
 *    logs the decision — then email the uploader a statement of reasons and
 *    the reporter the outcome, and log each email and how it went.
 *
 * NO runtime imports, like guestEmail.ts: Deno wants the `.ts` extension and
 * vitest wants it gone, so everything the handlers touch arrives in `deps` and
 * the two index.ts files are only the wiring.
 */

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

/** To the reporter, as soon as the report is stored. */
export const reportAcknowledgment = (report: ContentReportInput, reference: string, operator: Operator): MailMessage =>
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
// The handlers
// ---------------------------------------------------------------------------

type Gate = { ok: true } | { ok: false; retryAfterSec: number };
type Delivery = 'sent' | 'failed' | 'unconfigured' | 'skipped';

/** As guestEmail.ts's CaptchaVerdict, restated for the no-runtime-imports reason. */
export type CaptchaVerdict =
    | { ok: true; verified: boolean }
    | { ok: false; code: 'captcha_missing' | 'captcha_failed' | 'captcha_unavailable'; status: number };

const CAPTCHA_REFUSALS = {
    captcha_missing: CONTENT_REPORT_ERRORS.captchaMissing,
    captcha_failed: CONTENT_REPORT_ERRORS.captchaFailed,
    captcha_unavailable: CONTENT_REPORT_ERRORS.captchaUnavailable,
} as const;

export interface NoticeLogEntry {
    event:
        | 'report_received'
        | 'report_acknowledged'
        | 'report_rejected'
        | 'reporter_notified'
        | 'statement_of_reasons'
        | 'uploader_notified_lift';
    reportId?: string | null;
    takedownId?: string | null;
    recipient?: string | null;
    delivery?: Delivery | null;
    actorId?: string | null;
    detail?: Record<string, unknown>;
}

interface CommonDeps {
    json: (body: unknown, status?: number) => Response;
    options: () => Response;
    clientKey: (req: Request) => string;
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    /** Mail through Resend; 'unconfigured' on a deploy without a key. */
    sendEmail: (to: string, message: MailMessage, options?: { bcc?: string }) => Promise<Exclude<Delivery, 'skipped'>>;
    logNotice: (entry: NoticeLogEntry) => Promise<void>;
    operator: Operator;
    logError: (message: string, err?: unknown) => void;
    now: () => number;
}

/** A window of the project's mail budget (_shared/mailBudget.ts), keyed per sender. */
type MailBudget = { hour: { limit: number; windowMs: number }; day: { limit: number; windowMs: number } };

/** Spend one unit of a sender's mail budget, or say there is none left. */
const takeMailBudget = async (deps: CommonDeps, sender: string, budget: MailBudget): Promise<boolean> => {
    for (const [window, { limit, windowMs }] of Object.entries(budget)) {
        const gate = await deps.checkRateLimit(`mail:${sender}:${window}`, limit, windowMs);
        if (!gate.ok) {
            deps.logError(`mail:${sender}:${window}: the ceiling on this mail was reached`);
            return false;
        }
    }
    return true;
};

const readBody = async (req: Request): Promise<Record<string, unknown> | null> => {
    try {
        const body: unknown = await req.json();
        return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
        return null;
    }
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
    mailBudget: MailBudget;
    /** The signed-in reporter, if the request carries a valid user JWT; null otherwise (never a refusal). */
    optionalUserId: (req: Request) => Promise<string | null>;
    /** HMAC of the reporter's mailbox, for the per-reporter limit: the bucket never holds an address. */
    reporterKey: (email: string) => Promise<string | null>;
    resolveDocument: (ref: DocumentRef) => Promise<string | null>;
    saveReport: (
        report: ContentReportInput & { documentId: string | null; reporterUserId: string | null },
    ) => Promise<{ id: string; reference: string } | null>;
    markAcknowledged: (reportId: string) => Promise<void>;
}

/**
 * content-report: the form's body → a stored report and an acknowledgment.
 *
 * The answer carries the reference either way: a report that was stored but
 * whose acknowledgment could not be mailed is still a report, and the page
 * shows the reference so the reporter has it.
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

    const body = await readBody(req);
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
    await deps.logNotice({
        event: 'report_received',
        reportId: saved.id,
        actorId: reporterUserId,
        detail: { kind: report.kind, category: report.category, resolved: documentId !== null },
    });

    let delivery: Delivery = 'skipped';
    if (await takeMailBudget(deps, 'content-report-ack', deps.mailBudget)) {
        delivery = await deps.sendEmail(
            report.reporterEmail,
            reportAcknowledgment(report, saved.reference, deps.operator),
            { bcc: deps.operator.legalEmail },
        );
    }
    if (delivery === 'sent') {
        await deps.markAcknowledged(saved.id);
    }
    await deps.logNotice({
        event: 'report_acknowledged',
        reportId: saved.id,
        recipient: report.reporterEmail,
        delivery,
    });

    return json({ reference: saved.reference, acknowledged: delivery === 'sent' }, 201);
};

export interface TakedownResult {
    takedownId: string;
    uploaderId: string | null;
    documentTitle: string | null;
    activeStrikes: number | null;
}

export interface ReportContact {
    reference: string;
    reporterName: string;
    reporterEmail: string;
}

/** A refusal from one of the SQL actions, by its `detail` code. */
export type ActionRefusal =
    'document_not_found' | 'already_taken_down' | 'report_not_found' | 'takedown_not_found' | 'report_not_open';

export interface ContentModerationDeps extends CommonDeps {
    /** The caller's user id from the JWT, or the Response refusing it. */
    authenticate: (req: Request) => Promise<string | Response>;
    isModerator: (userId: string) => Promise<boolean | null>;
    mailBudget: MailBudget;
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
    }) => Promise<{ uploaderId: string | null; documentTitle: string | null } | ActionRefusal | null>;
    rejectReport: (input: {
        reportId: string;
        note: string;
        moderatorId: string;
    }) => Promise<ReportContact | ActionRefusal | null>;
    reportContact: (reportId: string) => Promise<ReportContact | null>;
    /** The uploader's sign-in email (admin API); null for an account with none, or a failure. */
    userEmail: (userId: string) => Promise<string | null>;
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
 * moderator. The decision is committed (and logged) before any email goes
 * out; an email that fails is logged as failed, and the answer says so, so
 * the moderator knows to follow up by hand rather than the decision being
 * lost to a mail outage.
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

    const body = (await readBody(req)) ?? {};
    const invalid = (field: string, error: string) => json({ error, code: 'invalid_request', field }, 422);
    const decidedAt = new Date(deps.now()).toISOString();

    const mail = async (
        to: string | null,
        message: MailMessage,
        entry: Omit<NoticeLogEntry, 'recipient' | 'delivery'>,
    ): Promise<Delivery> => {
        let delivery: Delivery = 'skipped';
        if (to && (await takeMailBudget(deps, 'moderation-notice', deps.mailBudget))) {
            delivery = await deps.sendEmail(to, message);
        }
        await deps.logNotice({ ...entry, recipient: to, delivery, actorId: caller });
        return delivery;
    };

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

        const uploaderEmail = result.uploaderId ? await deps.userEmail(result.uploaderId) : null;
        const uploader = await mail(
            uploaderEmail,
            statementOfReasons(
                {
                    documentTitle: result.documentTitle,
                    action: mode as TakedownAction,
                    ground: ground as TakedownGround,
                    legalBasis,
                    facts,
                    fromReport: reportId !== null,
                    activeStrikes: result.activeStrikes,
                    decidedAt,
                },
                deps.operator,
            ),
            { event: 'statement_of_reasons', takedownId: result.takedownId, reportId },
        );

        let reporter: Delivery | null = null;
        if (reportId) {
            const contact = await deps.reportContact(reportId);
            reporter = await mail(
                contact?.reporterEmail ?? null,
                reporterOutcome(
                    {
                        reference: contact?.reference ?? '',
                        reporterName: contact?.reporterName ?? '',
                        decision: 'actioned',
                        action: mode as TakedownAction,
                    },
                    deps.operator,
                ),
                { event: 'reporter_notified', takedownId: result.takedownId, reportId },
            );
        }

        return json({
            takedownId: result.takedownId,
            activeStrikes: result.activeStrikes,
            repeatInfringer: (result.activeStrikes ?? 0) >= REPEAT_INFRINGER_STRIKES,
            delivery: { uploader, reporter },
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
        const uploaderEmail = result.uploaderId ? await deps.userEmail(result.uploaderId) : null;
        const uploader = await mail(
            uploaderEmail,
            takedownLifted({ documentTitle: result.documentTitle, reason }, deps.operator),
            { event: 'uploader_notified_lift', takedownId },
        );
        return json({ lifted: true, delivery: { uploader } });
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
        const reporter = await mail(
            result.reporterEmail,
            reporterOutcome(
                { reference: result.reference, reporterName: result.reporterName, decision: 'rejected', note },
                deps.operator,
            ),
            { event: 'reporter_notified', reportId },
        );
        return json({ rejected: true, delivery: { reporter } });
    }

    return invalid('action', 'Unknown action.');
};
