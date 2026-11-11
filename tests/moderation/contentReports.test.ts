import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { REPEAT_INFRINGER_STRIKES, STRIKE_WINDOW_MONTHS } from '@/features/moderation/moderationRules';

import {
    REPORT_BODY_MAX_BYTES,
    REPORT_FIELD_LIMITS,
    CONTENT_REPORT_LIMITS,
    REPEAT_INFRINGER_STRIKES as SERVER_STRIKES,
    CONTENT_NOTICE_OUTBOX,
    STRIKE_WINDOW_MONTHS as SERVER_WINDOW,
    documentRefFromUrl,
    handleContentModeration,
    handleContentNotices,
    handleContentReport,
    parseContentReport,
    renderNotice,
    reportAcknowledgment,
    refundsNoticeBudget,
    reporterOutcome,
    statementOfReasons,
    takedownLifted,
    type CommonDeps,
    type ContentModerationDeps,
    type ContentNoticesDeps,
    type ContentReportDeps,
    type ContentReportInput,
    type MailBudget,
    type NoticeOutcome,
    type NoticeSender,
    type OutboxNotice,
} from '../../supabase/functions/_shared/contentReports';
import { MAIL_CATEGORY_CAPS, MAIL_WINDOW_MS, mailLimit } from '../../supabase/functions/_shared/mailBudget';
import {
    resendIdempotencyKey,
    sendViaResend,
    type ResendResult,
} from '../../supabase/functions/_shared/resendDelivery';
import { readCappedJson } from '../../supabase/functions/_shared/readCappedJson';
import { supportInboundBudgetKey } from '../../supabase/functions/resend-inbound/handler';
import { chunkedJson } from '../security/chunkedBody';
import { CONTROL_BODY_MAX_BYTES, PAYLOAD_TOO_LARGE } from '../../supabase/functions/_shared/readCappedJson';

const OPERATOR = {
    name: 'Cleffy LLC',
    postalAddress: '245 East 37th Street, Apt 3E, New York, NY 10016, USA',
    legalEmail: 'legal@cleffy.io',
    website: 'cleffy.io',
};

const DOC = '0b0e7a2c-1d3f-4a5b-8c6d-7e8f9a0b1c2d';
const REPORT = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const TAKEDOWN = '9f8e7d6c-5b4a-4321-8fed-cba987654321';

const copyrightBody = (): Record<string, unknown> => ({
    kind: 'copyright',
    contentUrl: `https://cleffy.io/doc/${DOC}`,
    workDescription: 'Sonata in C, Henle edition 2019',
    explanation: 'This is a scan of our current edition, uploaded without permission.',
    reporterName: 'Ada Rights',
    reporterEmail: '  Ada@Example.COM ',
    onBehalfOf: 'Example Music Publishing',
    goodFaith: true,
    perjuryStatement: true,
    signature: 'Ada Rights',
});

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const post = (body: unknown): Request =>
    new Request('https://edge.test/fn', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
    });

/** The budgets MAIL_CATEGORY_CAPS (LAUNCH_MAIL_SPLIT) declares for the two senders. */
/** Acknowledgments and moderation notices an hour, as the split has them. */
const ACKS_PER_HOUR = MAIL_CATEGORY_CAPS.contentReportAck.hour;
const NOTICES_PER_HOUR = MAIL_CATEGORY_CAPS.moderationNotice.hour;

const BUDGETS: Record<NoticeSender, MailBudget> = {
    'content-report-ack': {
        hour: { limit: MAIL_CATEGORY_CAPS.contentReportAck.hour, windowMs: MAIL_WINDOW_MS.hour },
        day: { limit: MAIL_CATEGORY_CAPS.contentReportAck.day, windowMs: MAIL_WINDOW_MS.day },
    },
    'moderation-notice': {
        hour: { limit: MAIL_CATEGORY_CAPS.moderationNotice.hour, windowMs: MAIL_WINDOW_MS.hour },
        day: { limit: MAIL_CATEGORY_CAPS.moderationNotice.day, windowMs: MAIL_WINDOW_MS.day },
    },
};

type OutboxRow = OutboxNotice & {
    status: 'pending' | 'sent';
    claimed: boolean;
    outcomes: Array<{ outcome: NoticeOutcome; retryAfterSec: number | null }>;
};

/**
 * content_notice_outbox in memory: the SQL actions' enqueue, and
 * claim/finish as the RPCs do them (a deferred or failed row goes back to
 * pending; only 'sent' finishes it).
 */
const fakeOutbox = () => {
    const rows: OutboxRow[] = [];
    let next = 0;
    const enqueue = (notice: Omit<OutboxNotice, 'id'>): string => {
        next += 1;
        const id = `notice-${next}`;
        rows.push({ ...notice, id, status: 'pending', claimed: false, outcomes: [] });
        return id;
    };
    const claimNotices: CommonDeps['claimNotices'] = async (limit, first) => {
        const due = rows
            .filter((row) => row.status === 'pending' && !row.claimed)
            .sort((a, b) => Number(first.includes(b.id)) - Number(first.includes(a.id)))
            .slice(0, limit);
        for (const row of due) {
            row.claimed = true;
        }
        return due.map(({ id, sender, template, recipient, bccLegal, payload }) => ({
            id,
            sender,
            template,
            recipient,
            bccLegal,
            payload,
        }));
    };
    const finishNotice: CommonDeps['finishNotice'] = async (id, outcome, retryAfterSec) => {
        const row = rows.find((candidate) => candidate.id === id);
        if (row) {
            row.claimed = false;
            row.outcomes.push({ outcome, retryAfterSec });
            if (outcome === 'sent') {
                row.status = 'sent';
            }
        }
    };
    return { rows, enqueue, claimNotices, finishNotice };
};

/** checkRateLimit over real counters: the mail budgets run out as they would. */
const countingLimiter = () => {
    const counts = new Map<string, number>();
    const checkRateLimit: CommonDeps['checkRateLimit'] = async (key, limit) => {
        const used = (counts.get(key) ?? 0) + 1;
        counts.set(key, used);
        return used <= limit ? { ok: true } : { ok: false, retryAfterSec: 1800 };
    };
    /** refund_edge_rate_limit: one use back, never below zero. */
    const refundRateLimit: CommonDeps['refundRateLimit'] = async (key) => {
        counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
    };
    const used = (key: string): number => counts.get(key) ?? 0;
    /** A new hour: the hourly windows reopen. */
    const nextHour = () => {
        for (const key of [...counts.keys()]) {
            if (key.endsWith(':hour')) {
                counts.delete(key);
            }
        }
    };
    return { checkRateLimit, refundRateLimit, used, nextHour };
};

type Sent = { to: string; subject: string; text: string; bcc?: string; idempotencyKey: string };

const commonDeps = (outbox: ReturnType<typeof fakeOutbox>, sent: Sent[]) => ({
    json,
    readJson: readCappedJson,
    options: () => new Response('ok'),
    clientKey: () => '203.0.113.9',
    checkRateLimit: async () => ({ ok: true }) as const,
    refundRateLimit: async () => undefined,
    idempotencyKey: resendIdempotencyKey,
    sendEmail: async (
        to: string,
        message: { subject: string; text: string },
        options: { bcc?: string; idempotencyKey: string },
    ) => {
        sent.push({
            to,
            subject: message.subject,
            text: message.text,
            bcc: options.bcc,
            idempotencyKey: options.idempotencyKey,
        });
        return { outcome: 'sent', reason: 'sent', status: 200, id: 'email-1' } as ResendResult;
    },
    mailBudgets: BUDGETS,
    claimNotices: outbox.claimNotices,
    finishNotice: outbox.finishNotice,
    operator: OPERATOR,
    logError: () => undefined,
    now: () => Date.parse('2026-10-20T12:00:00Z'),
});

/** As content_reports_enqueue_ack queues it. */
const ackNotice = (report: ContentReportInput, reference: string): Omit<OutboxNotice, 'id'> => ({
    sender: 'content-report-ack',
    template: 'report_acknowledgment',
    recipient: report.reporterEmail,
    bccLegal: true,
    payload: {
        reference,
        reporterName: report.reporterName,
        category: report.category,
        contentUrl: report.contentUrl,
        workDescription: report.workDescription,
        onBehalfOf: report.onBehalfOf,
        explanation: report.explanation,
    },
});

const reportDeps = (overrides: Partial<ContentReportDeps> = {}, outbox = fakeOutbox()) => {
    const sent: Sent[] = [];
    const saved: Array<ContentReportInput & { documentId: string | null; reporterUserId: string | null }> = [];
    const deps: ContentReportDeps = {
        ...commonDeps(outbox, sent),
        verifyCaptcha: async () => ({ ok: true, verified: true }),
        optionalUserId: async () => null,
        reporterKey: async (email) => `content-report:to:${email.length}`,
        resolveDocument: async (ref) => (ref.kind === 'document' ? ref.id : null),
        saveReport: async (report) => {
            saved.push(report);
            const reference = `CR-${String(saved.length).padStart(10, '0')}`;
            return { id: REPORT, reference, ackNoticeId: outbox.enqueue(ackNotice(report, reference)) };
        },
        ...overrides,
    };
    return { deps, sent, saved, outbox };
};

describe('the rules the policy quotes', () => {
    it('are the same numbers on both sides', () => {
        expect(SERVER_STRIKES).toBe(REPEAT_INFRINGER_STRIKES);
        expect(SERVER_WINDOW).toBe(STRIKE_WINDOW_MONTHS);
    });

    it('match the window active_content_strikes() counts over', () => {
        const sql = readFileSync(
            resolve(process.cwd(), 'supabase/migrations/20261020150000_content_moderation.sql'),
            'utf8',
        );
        expect(sql).toContain(`interval '${STRIKE_WINDOW_MONTHS} months'`);
    });

    it('keeps the handler module free of runtime imports, so Deno and vitest load the same file', () => {
        const source = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/contentReports.ts'), 'utf8');
        expect(source.match(/^import (?!type).*$/gm) ?? []).toEqual([]);
    });
});

describe('parseContentReport', () => {
    it('accepts a complete copyright notice and normalises the address', () => {
        const parsed = parseContentReport(copyrightBody());
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
            expect(parsed.value.reporterEmail).toBe('ada@example.com');
            expect(parsed.value.category).toBe('copyright');
            expect(parsed.value.perjuryStatement).toBe(true);
        }
    });

    it.each([
        ['kind', { kind: 'spam' }],
        ['workDescription', { workDescription: '  ' }],
        ['perjuryStatement', { perjuryStatement: false }],
        ['goodFaith', { goodFaith: 'yes' }],
        ['reporterEmail', { reporterEmail: 'Name <a@b.com>' }],
        ['contentUrl', { contentUrl: '' }],
        ['explanation', { explanation: 'short' }],
        ['signature', { signature: '' }],
        ['explanation', { explanation: 'x'.repeat(8001) }],
    ])('refuses a copyright notice with a bad %s', (field, change) => {
        const parsed = parseContentReport({ ...copyrightBody(), ...change });
        expect(parsed).toMatchObject({ ok: false, field });
    });

    it('needs a category for an illegal-content report, and no perjury statement', () => {
        const base = { ...copyrightBody(), kind: 'illegal', workDescription: '', perjuryStatement: false };
        expect(parseContentReport(base)).toMatchObject({ ok: false, field: 'category' });
        expect(parseContentReport({ ...base, category: 'copyright' })).toMatchObject({ ok: false, field: 'category' });
        const parsed = parseContentReport({ ...base, category: 'hate' });
        expect(parsed).toMatchObject({ ok: true, value: { category: 'hate', workDescription: null } });
    });

    it('refuses no body at all', () => {
        expect(parseContentReport(null)).toMatchObject({ ok: false, field: 'body' });
    });
});

describe('documentRefFromUrl', () => {
    it.each([
        [`https://cleffy.io/doc/${DOC}`, { kind: 'document', id: DOC }],
        [`cleffy.io/doc/${DOC.toUpperCase()}?page=3`, { kind: 'document', id: DOC }],
        [DOC, { kind: 'document', id: DOC }],
        ['https://cleffy.io/join/Ab3_x-9QzYk2LmNoPqRsTu', { kind: 'share', token: 'Ab3_x-9QzYk2LmNoPqRsTu' }],
        ['https://example.com/some/other/page', null],
        ['the second movement', null],
    ])('%s', (url, expected) => {
        expect(documentRefFromUrl(url)).toEqual(expected);
    });
});

describe('content-report', () => {
    it('stores the report, sends the queued acknowledgment, and copies the legal mailbox', async () => {
        const { deps, sent, saved, outbox } = reportDeps({ optionalUserId: async () => 'user-1' });
        const res = await handleContentReport(post(copyrightBody()), deps);
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ reference: 'CR-0000000001', acknowledged: true, delivery: 'sent' });
        expect(saved[0]).toMatchObject({ documentId: DOC, reporterUserId: 'user-1', reporterEmail: 'ada@example.com' });
        expect(sent).toEqual([
            expect.objectContaining({
                to: 'ada@example.com',
                subject: 'We received your report CR-0000000001',
                bcc: 'legal@cleffy.io',
                idempotencyKey: 'content-notice-outbox-notice-1',
            }),
        ]);
        expect(outbox.rows[0]).toMatchObject({ status: 'sent', outcomes: [{ outcome: 'sent', retryAfterSec: null }] });
    });

    it('refuses a failed "I’m human" check before storing or mailing anything', async () => {
        const { deps, saved, sent } = reportDeps({
            verifyCaptcha: async () => ({ ok: false, code: 'captcha_failed', status: 403 }),
        });
        const res = await handleContentReport(post(copyrightBody()), deps);
        expect(res.status).toBe(403);
        expect((await res.json()).code).toBe('captcha_failed');
        expect(saved).toEqual([]);
        expect(sent).toEqual([]);
    });

    it('limits per IP before parsing, and per reporter before storing', async () => {
        const perIp = reportDeps({ checkRateLimit: async () => ({ ok: false, retryAfterSec: 120 }) });
        expect((await handleContentReport(post(copyrightBody()), perIp.deps)).status).toBe(429);

        const keys: string[] = [];
        const perReporter = reportDeps({
            checkRateLimit: async (key, limit) => {
                keys.push(`${key}/${limit}`);
                return key.startsWith('content-report:to:') ? { ok: false, retryAfterSec: 60 } : { ok: true };
            },
        });
        expect((await handleContentReport(post(copyrightBody()), perReporter.deps)).status).toBe(429);
        expect(perReporter.saved).toEqual([]);
        expect(keys).toEqual([
            `content-report:ip:203.0.113.9/${CONTENT_REPORT_LIMITS.perIp.limit}`,
            `content-report:to:15/${CONTENT_REPORT_LIMITS.perReporterDaily.limit}`,
        ]);
    });

    it('queues the acknowledgment past the hourly budget, legal copy included, and sends it when the hour turns', async () => {
        // Codex #63 major 2: the one past the acknowledgment budget (8 an hour
        // in the launch split; 10 then) used to be stored, never mailed, and
        // its BCC to the legal mailbox lost with it.
        const limiter = countingLimiter();
        const outbox = fakeOutbox();
        const { deps, sent } = reportDeps(
            {
                // The per-IP and per-reporter gates are not what this is about.
                checkRateLimit: (key, limit, windowMs) =>
                    key.startsWith('mail:')
                        ? limiter.checkRateLimit(key, limit, windowMs)
                        : Promise.resolve({ ok: true }),
            },
            outbox,
        );
        for (let i = 0; i < ACKS_PER_HOUR; i += 1) {
            expect(await (await handleContentReport(post(copyrightBody()), deps)).json()).toMatchObject({
                acknowledged: true,
            });
        }
        const reference = `CR-${String(ACKS_PER_HOUR + 1).padStart(10, '0')}`;
        const over = await handleContentReport(post(copyrightBody()), deps);
        expect(over.status).toBe(201);
        expect(await over.json()).toEqual({ reference, acknowledged: false, delivery: 'queued' });
        expect(sent).toHaveLength(ACKS_PER_HOUR);
        // Still owed, with the legal copy, back in the queue until the window reopens.
        expect(outbox.rows[ACKS_PER_HOUR]).toMatchObject({
            status: 'pending',
            bccLegal: true,
            outcomes: [{ outcome: 'deferred', retryAfterSec: 1800 }],
        });

        limiter.nextHour();
        const retry: ContentNoticesDeps = {
            ...commonDeps(outbox, sent),
            checkRateLimit: limiter.checkRateLimit,
            authorized: async () => true,
        };
        const run = await handleContentNotices(post({}), retry);
        expect(await run.json()).toEqual({ sent: 1, queued: 0, failed: 0, unconfigured: 0 });
        expect(sent.at(-1)).toMatchObject({
            to: 'ada@example.com',
            subject: `We received your report ${reference}`,
            bcc: 'legal@cleffy.io',
        });
        expect(outbox.rows.every((row) => row.status === 'sent')).toBe(true);
    });

    it('keeps a notice whose send failed, for the retry', async () => {
        const { deps, outbox } = reportDeps({
            sendEmail: async () => ({ outcome: 'unknown', reason: 'timeout', status: null }),
        });
        const res = await handleContentReport(post(copyrightBody()), deps);
        expect(res.status).toBe(201);
        expect(await res.json()).toMatchObject({ acknowledged: false, delivery: 'failed' });
        expect(outbox.rows[0]).toMatchObject({ status: 'pending', outcomes: [{ outcome: 'failed' }] });
    });

    it('sends its own acknowledgment ahead of an older backlog', async () => {
        const outbox = fakeOutbox();
        for (let i = 0; i < 8; i += 1) {
            outbox.enqueue({
                sender: 'moderation-notice',
                template: 'takedown_lifted',
                recipient: `old${i}@example.com`,
                bccLegal: false,
                payload: { documentTitle: 'Old', reason: 'Old' },
            });
        }
        const { deps, sent } = reportDeps({}, outbox);
        expect(await (await handleContentReport(post(copyrightBody()), deps)).json()).toMatchObject({
            acknowledged: true,
        });
        expect(sent[0]?.to).toBe('ada@example.com');
        // A few of the backlog ride along; the rest wait for the next request or the retry.
        expect(sent).toHaveLength(5);
    });

    it('answers 503 when the report cannot be stored', async () => {
        const { deps, sent } = reportDeps({ saveReport: async () => null });
        expect((await handleContentReport(post(copyrightBody()), deps)).status).toBe(503);
        expect(sent).toEqual([]);
    });

    it('names the field a bad report got wrong', async () => {
        const { deps } = reportDeps();
        const res = await handleContentReport(post({ ...copyrightBody(), signature: '' }), deps);
        expect(res.status).toBe(422);
        expect(await res.json()).toMatchObject({ code: 'invalid_report', field: 'signature' });
    });
});

/** What apply/lift/reject queue, as the SQL actions do (the uploader's address resolved there). */
const moderationDeps = (
    overrides: Partial<ContentModerationDeps> = {},
    { uploaderEmail = 'uploader@example.com' as string | null, outbox = fakeOutbox() } = {},
) => {
    const sent: Sent[] = [];
    const queue = (notice: Omit<OutboxNotice, 'id' | 'recipient'>, to: string | null): string | null =>
        to ? outbox.enqueue({ ...notice, recipient: to }) : null;
    const deps: ContentModerationDeps = {
        ...commonDeps(outbox, sent),
        authenticate: async () => 'moderator-1',
        isModerator: async () => true,
        resolveDocument: async (ref) => (ref.kind === 'document' ? ref.id : null),
        applyTakedown: vi.fn(async (input) => ({
            takedownId: TAKEDOWN,
            uploaderId: 'uploader-1',
            documentTitle: 'Sonata <b>in C</b>',
            activeStrikes: 3,
            uploaderNoticeId: queue(
                {
                    sender: 'moderation-notice',
                    template: 'statement_of_reasons',
                    bccLegal: false,
                    payload: {
                        documentTitle: 'Sonata <b>in C</b>',
                        action: input.action,
                        ground: input.ground,
                        legalBasis: input.legalBasis,
                        facts: input.facts,
                        fromReport: input.reportId !== null,
                        activeStrikes: 3,
                        decidedAt: '2026-10-20T12:00:00.000Z',
                    },
                },
                uploaderEmail,
            ),
            reporterNoticeId: input.reportId
                ? queue(
                      {
                          sender: 'moderation-notice',
                          template: 'reporter_outcome',
                          bccLegal: false,
                          payload: {
                              reference: 'CR-ABCDEF1234',
                              reporterName: 'Ada',
                              decision: 'actioned',
                              action: input.action,
                          },
                      },
                      'ada@example.com',
                  )
                : null,
        })),
        liftTakedown: vi.fn(async (input) => ({
            uploaderNoticeId: queue(
                {
                    sender: 'moderation-notice',
                    template: 'takedown_lifted',
                    bccLegal: false,
                    payload: { documentTitle: 'Sonata', reason: input.reason },
                },
                uploaderEmail,
            ),
        })),
        rejectReport: vi.fn(async (input) => ({
            reporterNoticeId: queue(
                {
                    sender: 'moderation-notice',
                    template: 'reporter_outcome',
                    bccLegal: false,
                    payload: {
                        reference: 'CR-ABCDEF1234',
                        reporterName: 'Ada',
                        decision: 'rejected',
                        note: input.note,
                    },
                },
                'ada@example.com',
            ),
        })),
        ...overrides,
    };
    return { deps, sent, outbox };
};

const takedownBody = {
    action: 'takedown',
    document: `https://cleffy.io/doc/${DOC}`,
    reportId: REPORT,
    mode: 'remove',
    ground: 'copyright',
    legalBasis: '17 U.S.C. §512(c)',
    facts: 'Matches the publisher’s 2019 edition page for page.',
};

describe('content-moderation', () => {
    it('refuses anyone who is not a moderator, before reading the request', async () => {
        const { deps } = moderationDeps({ isModerator: async () => false });
        const res = await handleContentModeration(post(takedownBody), deps);
        expect(res.status).toBe(403);
        expect(deps.applyTakedown).not.toHaveBeenCalled();
    });

    it('takes a score down, sends the statement of reasons and tells the reporter', async () => {
        const { deps, sent } = moderationDeps();
        const res = await handleContentModeration(post(takedownBody), deps);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            takedownId: TAKEDOWN,
            activeStrikes: 3,
            repeatInfringer: true,
            delivery: { uploader: 'sent', reporter: 'sent' },
        });
        expect(deps.applyTakedown).toHaveBeenCalledWith(
            expect.objectContaining({
                documentId: DOC,
                action: 'remove',
                reportId: REPORT,
                moderatorId: 'moderator-1',
            }),
        );
        expect(sent.map((mail) => mail.to)).toEqual(['uploader@example.com', 'ada@example.com']);
        expect(sent[0]?.subject).toBe('About your score “Sonata <b>in C</b>”: removed');
        // The uploader is never told who reported them.
        expect(sent[0]?.text).not.toContain('ada@example.com');
        expect(sent[0]?.text).not.toContain('Ada');
    });

    it('commits the decision even when the uploader has no address, and says the mail was skipped', async () => {
        const { deps, sent } = moderationDeps({}, { uploaderEmail: null });
        const res = await handleContentModeration(post({ ...takedownBody, reportId: '' }), deps);
        expect(await res.json()).toMatchObject({ delivery: { uploader: 'skipped', reporter: null } });
        expect(sent).toEqual([]);
    });

    it('queues what the moderation budget cannot send yet, and the retry sends it later', async () => {
        // Codex #63 major 2: two notices per reported takedown, against the
        // hourly moderation budget (4 in the launch split; 5 then).
        const limiter = countingLimiter();
        const outbox = fakeOutbox();
        const { deps, sent } = moderationDeps({ checkRateLimit: limiter.checkRateLimit }, { outbox });
        const takedowns = Math.ceil((NOTICES_PER_HOUR + 1) / 2);
        const deliveries = [];
        for (let i = 0; i < takedowns; i += 1) {
            deliveries.push((await (await handleContentModeration(post(takedownBody), deps)).json()).delivery);
        }
        // Uploader then reporter, in order, until the hour's budget is spent.
        const expected = (n: number) => (n < NOTICES_PER_HOUR ? 'sent' : 'queued');
        expect(deliveries).toEqual(
            Array.from({ length: takedowns }, (_, i) => ({ uploader: expected(2 * i), reporter: expected(2 * i + 1) })),
        );
        expect(deliveries.at(-1)?.reporter).toBe('queued');
        expect(sent).toHaveLength(NOTICES_PER_HOUR);
        const owed = 2 * takedowns - NOTICES_PER_HOUR;
        expect(outbox.rows.filter((row) => row.status === 'pending')).toHaveLength(owed);

        limiter.nextHour();
        const run = await handleContentNotices(post({}), {
            ...commonDeps(outbox, sent),
            checkRateLimit: limiter.checkRateLimit,
            authorized: async () => true,
        });
        expect(await run.json()).toMatchObject({ sent: owed });
        expect(sent.at(-1)?.to).toBe('ada@example.com');
    });

    it('answers a refusal from the database with its own status', async () => {
        const { deps, sent } = moderationDeps({ applyTakedown: async () => 'already_taken_down' });
        const res = await handleContentModeration(post(takedownBody), deps);
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('already_taken_down');
        expect(sent).toEqual([]);
    });

    it.each([
        ['mode', { mode: 'delete' }],
        ['ground', { ground: 'vibes' }],
        ['legalBasis', { legalBasis: '' }],
        ['facts', { facts: '' }],
        ['document', { document: 'somewhere' }],
        ['reportId', { reportId: 'not-a-uuid' }],
    ])('refuses a takedown with a bad %s', async (field, change) => {
        const { deps } = moderationDeps();
        const res = await handleContentModeration(post({ ...takedownBody, ...change }), deps);
        expect(res.status).toBe(422);
        expect((await res.json()).field).toBe(field);
        expect(deps.applyTakedown).not.toHaveBeenCalled();
    });

    it('lifts a takedown and tells the uploader', async () => {
        const { deps, sent } = moderationDeps();
        const res = await handleContentModeration(
            post({ action: 'lift', takedownId: TAKEDOWN, reason: 'Counter-notice received; no court action filed.' }),
            deps,
        );
        expect(await res.json()).toEqual({ lifted: true, delivery: { uploader: 'sent' } });
        expect(sent[0]?.subject).toBe('Your score “Sonata” is available again');
    });

    it('rejects a report and tells the reporter why', async () => {
        const { deps, sent } = moderationDeps();
        const res = await handleContentModeration(
            post({ action: 'reject', reportId: REPORT, note: 'The edition is in the public domain.' }),
            deps,
        );
        expect(await res.json()).toEqual({ rejected: true, delivery: { reporter: 'sent' } });
        expect(sent[0]?.text).toContain('Why: The edition is in the public domain.');
    });

    it('refuses an unknown action', async () => {
        const { deps } = moderationDeps();
        expect((await handleContentModeration(post({ action: 'ban' }), deps)).status).toBe(422);
    });
});

describe('content-notices (the retry)', () => {
    const retryDeps = (overrides: Partial<ContentNoticesDeps> = {}, outbox = fakeOutbox()) => {
        const sent: Sent[] = [];
        const deps: ContentNoticesDeps = { ...commonDeps(outbox, sent), authorized: async () => true, ...overrides };
        return { deps, sent, outbox };
    };

    it('refuses a caller without the scheduler’s secret, and says so when none is configured', async () => {
        expect((await handleContentNotices(post({}), retryDeps({ authorized: async () => false }).deps)).status).toBe(
            403,
        );
        expect((await handleContentNotices(post({}), retryDeps({ authorized: async () => null }).deps)).status).toBe(
            503,
        );
    });

    it('works through the backlog in rounds until the budget is spent, leaving the rest queued', async () => {
        const outbox = fakeOutbox();
        for (let i = 0; i < 25; i += 1) {
            outbox.enqueue({
                sender: 'content-report-ack',
                template: 'report_acknowledgment',
                recipient: `r${i}@example.com`,
                bccLegal: true,
                payload: {
                    reference: `CR-${i}`,
                    reporterName: 'R',
                    category: 'other',
                    contentUrl: 'u',
                    explanation: 'Explained at length.',
                },
            });
        }
        const limiter = countingLimiter();
        const { deps, sent } = retryDeps({ checkRateLimit: limiter.checkRateLimit }, outbox);
        // Round one (a batch of 10) sends the hour's budget and defers the
        // rest; round two finds every claim deferred and stops.
        expect(await (await handleContentNotices(post({}), deps)).json()).toEqual({
            sent: ACKS_PER_HOUR,
            queued: 20 - ACKS_PER_HOUR,
            failed: 0,
            unconfigured: 0,
        });
        expect(sent).toHaveLength(ACKS_PER_HOUR);
        expect(sent.every((mail) => mail.bcc === 'legal@cleffy.io')).toBe(true);
        expect(outbox.rows.filter((row) => row.status === 'pending')).toHaveLength(25 - ACKS_PER_HOUR);
    });

    it('marks a notice it cannot render as failed rather than sending half of it', async () => {
        const outbox = fakeOutbox();
        outbox.enqueue({
            sender: 'moderation-notice',
            template: 'statement_of_reasons',
            recipient: 'u@example.com',
            bccLegal: false,
            payload: { action: 'remove' },
        });
        const { deps, sent } = retryDeps({}, outbox);
        expect(await (await handleContentNotices(post({}), deps)).json()).toMatchObject({ failed: 1 });
        expect(sent).toEqual([]);
        expect(outbox.rows[0]).toMatchObject({ status: 'pending', outcomes: [{ outcome: 'failed' }] });
    });
});

describe('renderNotice', () => {
    it('renders each template exactly as the direct email builders do', () => {
        const parsed = parseContentReport(copyrightBody());
        if (!parsed.ok) {
            throw new Error('fixture');
        }
        const ack = { id: 'n', ...ackNotice(parsed.value, 'CR-1') };
        expect(renderNotice(ack, OPERATOR)).toEqual(reportAcknowledgment(parsed.value, 'CR-1', OPERATOR));
        const reasons = {
            documentTitle: 'Sonata',
            action: 'restrict' as const,
            ground: 'terms' as const,
            legalBasis: 'Terms',
            facts: 'Facts',
            fromReport: false,
            activeStrikes: null,
            decidedAt: '2026-10-20T12:00:00.000Z',
        };
        expect(
            renderNotice(
                {
                    id: 'n',
                    sender: 'moderation-notice',
                    template: 'statement_of_reasons',
                    recipient: 'u@example.com',
                    bccLegal: false,
                    payload: reasons,
                },
                OPERATOR,
            ),
        ).toEqual(statementOfReasons(reasons, OPERATOR));
    });

    it('reads the keys the SQL actions record', () => {
        // The payloads are built in SQL and read here: hold the names together.
        const sql = readFileSync(
            resolve(process.cwd(), 'supabase/migrations/20261020150000_content_moderation.sql'),
            'utf8',
        );
        for (const key of [
            'reference',
            'reporterName',
            'category',
            'contentUrl',
            'workDescription',
            'onBehalfOf',
            'explanation',
            'documentTitle',
            'action',
            'ground',
            'legalBasis',
            'facts',
            'fromReport',
            'activeStrikes',
            'decidedAt',
            'decision',
            'note',
            'reason',
        ]) {
            expect(sql, key).toContain(`'${key}', `);
        }
    });
});

describe('the emails', () => {
    const report = (() => {
        const parsed = parseContentReport(copyrightBody());
        if (!parsed.ok) {
            throw new Error('fixture');
        }
        return parsed.value;
    })();

    it('acknowledge with the reference and what was reported', () => {
        const mail = reportAcknowledgment(report, 'CR-ABCDEF1234', OPERATOR);
        expect(mail.text).toContain('Your reference is CR-ABCDEF1234');
        expect(mail.text).toContain('Copyrighted work: Sonata in C, Henle edition 2019');
        expect(mail.text).toContain('Cleffy LLC, 245 East 37th Street');
    });

    it('escape everything a stranger wrote before it goes into HTML', () => {
        const mail = reportAcknowledgment(
            { ...report, explanation: '<script>alert(1)</script> & "quotes"' },
            'CR-1',
            OPERATOR,
        );
        expect(mail.html).not.toContain('<script>');
        expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    });

    it('give the uploader every part of a statement of reasons', () => {
        const mail = statementOfReasons(
            {
                documentTitle: 'Sonata',
                action: 'restrict',
                ground: 'copyright',
                legalBasis: '17 U.S.C. §512(c)',
                facts: 'Matches the 2019 edition.',
                fromReport: true,
                activeStrikes: 1,
                decidedAt: '2026-10-20T12:00:00.000Z',
            },
            OPERATOR,
        );
        // DSA Art. 17(3): the restriction and its scope, facts, notice or own
        // initiative, automated means, ground, redress.
        expect(mail.text).toContain('can no longer be shared');
        expect(mail.text).toContain('This applies everywhere Cleffy is used');
        expect(mail.text).toContain('The facts we relied on: Matches the 2019 edition.');
        expect(mail.text).toContain('We acted on a report sent to us by someone else');
        expect(mail.text).toContain('No automated means were used');
        expect(mail.text).toContain('The law relied on: 17 U.S.C. §512(c)');
        expect(mail.text).toContain('within six months');
        expect(mail.text).toContain('out-of-court dispute settlement body');
        // And, for copyright, the strike and the counter-notice route.
        expect(mail.text).toContain(`Active strikes: 1 (an account with ${REPEAT_INFRINGER_STRIKES} within`);
        expect(mail.text).toContain('cleffy.io/copyright#counter-notice');
    });

    it('mention strikes and counter-notices only for copyright, and name the term for a terms ground', () => {
        const mail = statementOfReasons(
            {
                documentTitle: null,
                action: 'remove',
                ground: 'terms',
                legalBasis: 'Terms of Service, Acceptable use',
                facts: 'Harassing text on every page.',
                fromReport: false,
                activeStrikes: 0,
                decidedAt: '2026-10-20T12:00:00.000Z',
            },
            OPERATOR,
        );
        expect(mail.subject).toBe('About your score “one of your scores”: removed');
        expect(mail.text).toContain('The term relied on: Terms of Service, Acceptable use');
        expect(mail.text).toContain('We acted on our own initiative.');
        expect(mail.text).not.toContain('strike');
        expect(mail.text).not.toContain('counter-notice');
    });

    it('tell the reporter the outcome either way', () => {
        expect(
            reporterOutcome(
                { reference: 'CR-1', reporterName: 'Ada', decision: 'actioned', action: 'remove' },
                OPERATOR,
            ).text,
        ).toContain('have removed the score');
        expect(
            reporterOutcome(
                { reference: 'CR-1', reporterName: 'Ada', decision: 'rejected', note: 'Public domain.' },
                OPERATOR,
            ).text,
        ).toContain('decided not to take action');
        expect(takedownLifted({ documentTitle: 'Sonata', reason: 'Counter-notice' }, OPERATOR).text).toContain(
            'strike from it has been withdrawn',
        );
    });
});

describe('the mail budget across uncertain sends (unknown keeps, a definite rejection refunds)', () => {
    const HOUR = 'mail:content-report-ack:hour';
    const DAY = 'mail:content-report-ack:day';

    type Answer = Response | Error;
    const ok = () => new Response(JSON.stringify({ id: 'email-1' }), { status: 200 });
    const status = (code: number, name = 'error') => new Response(JSON.stringify({ name }), { status: code });

    /**
     * One acknowledgment in the outbox and a counting limiter, delivered
     * through the shared resendDelivery.sendViaResend against a fake Resend
     * that answers `answers` in turn (an Error is a fetch that threw).
     */
    const setup = (answers: Answer[], apiKey: string | null = 're_test') => {
        const outbox = fakeOutbox();
        const id = outbox.enqueue({
            sender: 'content-report-ack',
            template: 'report_acknowledgment',
            recipient: 'ada@example.com',
            bccLegal: true,
            payload: {
                reference: 'CR-0000000001',
                reporterName: 'Ada',
                category: 'copyright',
                contentUrl: 'https://cleffy.io/doc/x',
                explanation: 'Explained at length.',
            },
        });
        const limiter = countingLimiter();
        const keys: string[] = [];
        const queue = [...answers];
        const fakeFetch = (async (_url: string, init: RequestInit) => {
            keys.push((init.headers as Record<string, string>)['Idempotency-Key']!);
            const answer = queue.shift() ?? ok();
            if (answer instanceof Error) {
                throw answer;
            }
            return answer;
        }) as unknown as typeof fetch;
        const sent: Sent[] = [];
        const deps: ContentNoticesDeps = {
            ...commonDeps(outbox, sent),
            checkRateLimit: limiter.checkRateLimit,
            refundRateLimit: limiter.refundRateLimit,
            sendEmail: (to, message, options) =>
                sendViaResend({
                    apiKey: apiKey ?? undefined,
                    idempotencyKey: options.idempotencyKey,
                    email: { from: 'Cleffy <legal@cleffy.io>', to: [to], ...message },
                    fetch: fakeFetch,
                }),
            authorized: async () => true,
        };
        return { outbox, id, limiter, keys, deps };
    };
    const run = async (deps: ContentNoticesDeps) => (await handleContentNotices(post({}), deps)).json();

    it.each([
        ['a network error', new TypeError('fetch failed')],
        ['a timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
        ['a 5xx', status(503)],
        ['a 409 (the same key still in flight)', status(409, 'concurrent_idempotent_requests')],
        ['a 2xx with no email id', new Response('{}', { status: 200 })],
    ] as Array<[string, Answer]>)('%s is unknown: the reservation and the notice are kept', async (_what, answer) => {
        const { outbox, limiter, deps } = setup([answer]);
        expect(await run(deps)).toMatchObject({ sent: 0, failed: 1 });
        // It may have gone out: the budget stays spent.
        expect(limiter.used(HOUR)).toBe(1);
        expect(limiter.used(DAY)).toBe(1);
        // And it is still owed, for the retry.
        expect(outbox.rows[0]).toMatchObject({ status: 'pending', outcomes: [{ outcome: 'failed' }] });
    });

    it.each([
        ['a 422 validation error', status(422, 'validation_error')],
        ['a 403', status(403)],
        ['a 429 (refused before anything was accepted)', status(429, 'rate_limit_exceeded')],
    ] as Array<[string, Answer]>)(
        '%s is a definite rejection: the reservation goes back in every window',
        async (_what, answer) => {
            const { outbox, limiter, deps } = setup([answer]);
            expect(await run(deps)).toMatchObject({ sent: 0, failed: 1 });
            expect(limiter.used(HOUR)).toBe(0);
            expect(limiter.used(DAY)).toBe(0);
            expect(outbox.rows[0]).toMatchObject({ status: 'pending', outcomes: [{ outcome: 'failed' }] });
        },
    );

    it('no API key (no request made) hands it back too, and says unconfigured', async () => {
        const { limiter, keys, deps } = setup([], null);
        expect(await run(deps)).toMatchObject({ unconfigured: 1 });
        expect(keys).toEqual([]);
        expect(limiter.used(HOUR)).toBe(0);
        expect(limiter.used(DAY)).toBe(0);
    });

    it('the retry after an unknown outcome sends with the same Idempotency-Key, derived from the outbox row', async () => {
        const { outbox, id, limiter, keys, deps } = setup([new TypeError('connection reset'), ok()]);
        expect(await run(deps)).toMatchObject({ failed: 1 });
        expect(await run(deps)).toMatchObject({ sent: 1 });
        // Attempt-independent: Resend answers the repeat with the first send's
        // result, so a notice that did go out the first time is not sent twice.
        expect(keys).toEqual([`content-notice-outbox-${id}`, `content-notice-outbox-${id}`]);
        expect(keys[0]).toBe(resendIdempotencyKey(CONTENT_NOTICE_OUTBOX, id));
        expect(outbox.rows[0]?.status).toBe('sent');
        // Two attempts, two reservations kept: an over-count, never an under-count.
        expect(limiter.used(HOUR)).toBe(2);
    });

    it('takes the key from resendDelivery’s resendIdempotencyKey, not a copy of its format', async () => {
        const { id, keys, deps } = setup([ok()]);
        const idempotencyKey = vi.fn((outbox: string, rowId: string) => `via-helper:${outbox}:${rowId}`);
        expect(await run({ ...deps, idempotencyKey })).toMatchObject({ sent: 1 });
        expect(idempotencyKey).toHaveBeenCalledWith(CONTENT_NOTICE_OUTBOX, id);
        expect(keys).toEqual([`via-helper:content-notice-outbox:${id}`]);
    });

    it('inbound support forwards spending their whole share leave the acknowledgment budget untouched', async () => {
        // Codex r1 finding 1: inbound used to spend these very buckets. Now it
        // counts under its own (resend-inbound/handler.ts), so a flood of mail
        // to support@ exhausts only the inbound share.
        const { outbox, limiter, deps } = setup([ok()]);
        for (const window of ['hour', 'day'] as const) {
            const { limit, windowMs } = mailLimit('supportInbound', window);
            for (let i = 0; i < limit; i += 1) {
                await limiter.checkRateLimit(supportInboundBudgetKey(window), limit, windowMs);
            }
            expect((await limiter.checkRateLimit(supportInboundBudgetKey(window), limit, windowMs)).ok).toBe(false);
            expect(supportInboundBudgetKey(window)).not.toBe(window === 'hour' ? HOUR : DAY);
        }
        expect(await run(deps)).toMatchObject({ sent: 1 });
        expect(outbox.rows[0]?.status).toBe('sent');
        expect(limiter.used(HOUR)).toBe(1);
    });

    it('a window that refuses hands back what the other window reserved', async () => {
        const { outbox, limiter, keys, deps } = setup([]);
        // The day is spent; the hour is not.
        for (let i = 0; i < MAIL_CATEGORY_CAPS.contentReportAck.day; i += 1) {
            await limiter.checkRateLimit(DAY, MAIL_CATEGORY_CAPS.contentReportAck.day, MAIL_WINDOW_MS.day);
        }
        expect(await run(deps)).toMatchObject({ sent: 0, queued: 1 });
        expect(keys).toEqual([]);
        expect(limiter.used(HOUR)).toBe(0);
        expect(outbox.rows[0]).toMatchObject({ status: 'pending', outcomes: [{ outcome: 'deferred' }] });
    });

    it('refunds on rejected only', () => {
        const result = (outcome: ResendResult['outcome']): ResendResult => ({ outcome, reason: outcome, status: null });
        expect(refundsNoticeBudget(result('rejected'))).toBe(true);
        expect(refundsNoticeBudget(result('unknown'))).toBe(false);
        expect(refundsNoticeBudget(result('sent'))).toBe(false);
    });
});

describe('content-report and content-moderation body cap', () => {
    it('fits the longest report the field limits allow, in multi-byte text', () => {
        const chars = Object.entries(REPORT_FIELD_LIMITS)
            .filter(([key]) => key !== 'explanationMin')
            .reduce((total, [, max]) => total + (max as number), 0);
        // 3 UTF-8 bytes a character, plus room for keys and a captcha token.
        expect(REPORT_BODY_MAX_BYTES).toBeGreaterThan(chars * 3 + 8 * 1024);
        expect(REPORT_BODY_MAX_BYTES).toBeGreaterThan(CONTROL_BODY_MAX_BYTES);
    });

    it('content-report answers 413 to a chunked body past its cap and stores nothing', async () => {
        const { deps, outbox } = reportDeps();
        const response = await handleContentReport(chunkedJson(copyrightBody(), REPORT_BODY_MAX_BYTES + 1), deps);
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual(PAYLOAD_TOO_LARGE);
        expect(outbox.rows).toHaveLength(0);
    });

    it('content-moderation answers 413 the same way', async () => {
        const { deps } = moderationDeps();
        const response = await handleContentModeration(chunkedJson(takedownBody, REPORT_BODY_MAX_BYTES + 1), deps);
        expect(response.status).toBe(413);
    });
});
