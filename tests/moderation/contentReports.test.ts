import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { REPEAT_INFRINGER_STRIKES, STRIKE_WINDOW_MONTHS } from '@/features/moderation/moderationRules';

import {
    CONTENT_REPORT_LIMITS,
    REPEAT_INFRINGER_STRIKES as SERVER_STRIKES,
    STRIKE_WINDOW_MONTHS as SERVER_WINDOW,
    documentRefFromUrl,
    handleContentModeration,
    handleContentReport,
    parseContentReport,
    reportAcknowledgment,
    reporterOutcome,
    statementOfReasons,
    takedownLifted,
    type ContentModerationDeps,
    type ContentReportDeps,
    type ContentReportInput,
    type NoticeLogEntry,
} from '../../supabase/functions/_shared/contentReports';

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

const reportDeps = (overrides: Partial<ContentReportDeps> = {}) => {
    const log: NoticeLogEntry[] = [];
    const sent: Array<{ to: string; subject: string; bcc?: string }> = [];
    const saved: Array<ContentReportInput & { documentId: string | null; reporterUserId: string | null }> = [];
    const acknowledged: string[] = [];
    const deps: ContentReportDeps = {
        json,
        options: () => new Response('ok'),
        clientKey: () => '203.0.113.9',
        checkRateLimit: async () => ({ ok: true }),
        sendEmail: async (to, message, options) => {
            sent.push({ to, subject: message.subject, bcc: options?.bcc });
            return 'sent';
        },
        logNotice: async (entry) => {
            log.push(entry);
        },
        operator: OPERATOR,
        logError: () => undefined,
        now: () => Date.parse('2026-10-20T12:00:00Z'),
        verifyCaptcha: async () => ({ ok: true, verified: true }),
        mailBudget: { hour: { limit: 10, windowMs: 3_600_000 }, day: { limit: 40, windowMs: 86_400_000 } },
        optionalUserId: async () => null,
        reporterKey: async (email) => `content-report:to:${email.length}`,
        resolveDocument: async (ref) => (ref.kind === 'document' ? ref.id : null),
        saveReport: async (report) => {
            saved.push(report);
            return { id: REPORT, reference: 'CR-ABCDEF1234' };
        },
        markAcknowledged: async (id) => {
            acknowledged.push(id);
        },
        ...overrides,
    };
    return { deps, log, sent, saved, acknowledged };
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
    it('stores the report, acknowledges it with the reference, and copies the legal mailbox', async () => {
        const { deps, log, sent, saved, acknowledged } = reportDeps({ optionalUserId: async () => 'user-1' });
        const res = await handleContentReport(post(copyrightBody()), deps);
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ reference: 'CR-ABCDEF1234', acknowledged: true });
        expect(saved[0]).toMatchObject({ documentId: DOC, reporterUserId: 'user-1', reporterEmail: 'ada@example.com' });
        expect(sent).toEqual([
            { to: 'ada@example.com', subject: 'We received your report CR-ABCDEF1234', bcc: 'legal@cleffy.io' },
        ]);
        expect(acknowledged).toEqual([REPORT]);
        expect(log.map((entry) => [entry.event, entry.delivery ?? null])).toEqual([
            ['report_received', null],
            ['report_acknowledged', 'sent'],
        ]);
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

    it('still stores the report and answers the reference when the mail budget is spent', async () => {
        const { deps, saved, sent, log, acknowledged } = reportDeps({
            checkRateLimit: async (key) => (key.startsWith('mail:') ? { ok: false, retryAfterSec: 60 } : { ok: true }),
        });
        const res = await handleContentReport(post(copyrightBody()), deps);
        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ reference: 'CR-ABCDEF1234', acknowledged: false });
        expect(saved).toHaveLength(1);
        expect(sent).toEqual([]);
        expect(acknowledged).toEqual([]);
        expect(log.at(-1)).toMatchObject({ event: 'report_acknowledged', delivery: 'skipped' });
    });

    it('does not mark a report acknowledged when the send failed', async () => {
        const { deps, acknowledged, log } = reportDeps({ sendEmail: async () => 'failed' });
        expect((await handleContentReport(post(copyrightBody()), deps)).status).toBe(201);
        expect(acknowledged).toEqual([]);
        expect(log.at(-1)).toMatchObject({ delivery: 'failed' });
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

const moderationDeps = (overrides: Partial<ContentModerationDeps> = {}) => {
    const log: NoticeLogEntry[] = [];
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const deps: ContentModerationDeps = {
        json,
        options: () => new Response('ok'),
        clientKey: () => '203.0.113.9',
        checkRateLimit: async () => ({ ok: true }),
        sendEmail: async (to, message) => {
            sent.push({ to, subject: message.subject, text: message.text });
            return 'sent';
        },
        logNotice: async (entry) => {
            log.push(entry);
        },
        operator: OPERATOR,
        logError: () => undefined,
        now: () => Date.parse('2026-10-20T12:00:00Z'),
        authenticate: async () => 'moderator-1',
        isModerator: async () => true,
        mailBudget: { hour: { limit: 5, windowMs: 3_600_000 }, day: { limit: 20, windowMs: 86_400_000 } },
        resolveDocument: async (ref) => (ref.kind === 'document' ? ref.id : null),
        applyTakedown: vi.fn(async () => ({
            takedownId: TAKEDOWN,
            uploaderId: 'uploader-1',
            documentTitle: 'Sonata <b>in C</b>',
            activeStrikes: 3,
        })),
        liftTakedown: vi.fn(async () => ({ uploaderId: 'uploader-1', documentTitle: 'Sonata' })),
        rejectReport: vi.fn(async () => ({
            reference: 'CR-ABCDEF1234',
            reporterName: 'Ada',
            reporterEmail: 'ada@example.com',
        })),
        reportContact: async () => ({
            reference: 'CR-ABCDEF1234',
            reporterName: 'Ada',
            reporterEmail: 'ada@example.com',
        }),
        userEmail: async () => 'uploader@example.com',
        ...overrides,
    };
    return { deps, log, sent };
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
        const { deps, sent, log } = moderationDeps();
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
        // The uploader is never told who reported them.
        expect(sent[0]?.text).not.toContain('ada@example.com');
        expect(sent[0]?.text).not.toContain('Ada');
        expect(log.map((entry) => [entry.event, entry.delivery])).toEqual([
            ['statement_of_reasons', 'sent'],
            ['reporter_notified', 'sent'],
        ]);
    });

    it('commits the decision even when the uploader has no address, and says the mail was skipped', async () => {
        const { deps, log } = moderationDeps({ userEmail: async () => null });
        const res = await handleContentModeration(post({ ...takedownBody, reportId: '' }), deps);
        expect(await res.json()).toMatchObject({ delivery: { uploader: 'skipped', reporter: null } });
        expect(log).toEqual([expect.objectContaining({ event: 'statement_of_reasons', delivery: 'skipped' })]);
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
        const { deps, sent, log } = moderationDeps();
        const res = await handleContentModeration(
            post({ action: 'lift', takedownId: TAKEDOWN, reason: 'Counter-notice received; no court action filed.' }),
            deps,
        );
        expect(await res.json()).toEqual({ lifted: true, delivery: { uploader: 'sent' } });
        expect(sent[0]?.subject).toBe('Your score “Sonata” is available again');
        expect(log[0]).toMatchObject({ event: 'uploader_notified_lift', takedownId: TAKEDOWN });
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
