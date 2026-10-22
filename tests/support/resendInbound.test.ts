import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { mailBudgetKey } from '../../supabase/functions/_shared/contentReports';
import { mailLimit } from '../../supabase/functions/_shared/mailBudget';
import {
    PAYLOAD_TOO_LARGE,
    readCappedText,
    WEBHOOK_BODY_MAX_BYTES as SHARED_WEBHOOK_MAX,
} from '../../supabase/functions/_shared/readCappedJson';
import {
    resendIdempotencyKey,
    type ResendEmail,
    type ResendResult,
} from '../../supabase/functions/_shared/resendDelivery';
import { forwardedSubject, inboxTagFor, isOwnForward } from '../../supabase/functions/_shared/supportMail';
import {
    type ClaimAnswer,
    type FinishOutcome,
    handleResendInbound,
    type InboundDeps,
    type InboundMessage,
    type InboundMeta,
    LOOP_GUARD_ERROR,
    SUPPORT_FORWARD_OUTBOX,
    WEBHOOK_BODY_MAX_BYTES,
} from '../../supabase/functions/resend-inbound/handler';
import { chunkedRequest } from '../security/chunkedBody';

/**
 * resend-inbound against an in-memory support_messages that behaves like
 * 20261022110200_support_inbound_lease.sql (tests/sql/support_inbound_lease.sql
 * proves the SQL itself), a mail budget, Resend's Received Emails API and its
 * send endpoint. Steps can be paused so a delivery can die mid-way.
 */

const LEASE_MS = 120_000;
const EMAIL_ID = '4ef9a417-02e9-4d39-ad75-9611e0fcc33c';
const FORWARD_TO = 'inbox@cleffy.example';
const FORWARD_FROM = 'Cleffy support <support@send.cleffy.io>';
const RETRY_SECRET = 'retry-secret-for-tests';

interface Row extends Omit<InboundMessage, 'holder'> {
    holder: string | null;
    status: 'processing' | 'forward_deferred' | 'completed';
    leaseUntil: number | null;
    attempts: number;
    nextAttemptAt: number | null;
    createdAt: number;
    forwardedAt: number | null;
    forwardError: string | null;
    forwardId: string | null;
}

class World {
    now = 1_000_000;
    rows = new Map<string, Row>();
    ids = 0;
    budget = { remaining: 8, retryAfterSec: 1800, refunds: 0, reserved: 0 };
    bodies = new Map<string, { text?: string; html?: string }>();
    fetchFails = 0;
    saveFails = 0;
    sends: Array<{ email: ResendEmail; key: string }> = [];
    sendResults: ResendResult[] = [];
    /** Resend's own idempotency: a key it has accepted replays, never re-sends. */
    delivered = new Map<string, string>();
    logs: string[] = [];
    private gates = new Map<string, { arrived: () => void; go: Promise<void> }>();

    pause(step: 'send' | 'fetch'): { arrived: Promise<void>; resume: () => void } {
        let arrived = () => undefined as void;
        let resume = () => undefined as void;
        const arrivedP = new Promise<void>((r) => (arrived = r));
        const go = new Promise<void>((r) => (resume = r));
        this.gates.set(step, { arrived, go });
        return { arrived: arrivedP, resume };
    }

    private async gate(step: string) {
        const g = this.gates.get(step);
        if (g) {
            this.gates.delete(step);
            g.arrived();
            await g.go;
        }
    }

    row(emailId = EMAIL_ID): Row {
        return this.rows.get(emailId) as Row;
    }

    private message(row: Row): InboundMessage {
        return {
            id: row.id,
            holder: row.holder as string,
            resendEmailId: row.resendEmailId,
            fromAddress: row.fromAddress,
            toAddresses: row.toAddresses,
            receivedFor: row.receivedFor,
            subject: row.subject,
            textBody: row.textBody,
            htmlBody: row.htmlBody,
        };
    }

    private leased(row: Row) {
        return row.leaseUntil !== null && row.leaseUntil > this.now;
    }

    store = {
        claim: vi.fn(async (meta: InboundMeta): Promise<ClaimAnswer | null> => {
            let row = this.rows.get(meta.emailId);
            if (!row) {
                row = {
                    id: `row-${++this.ids}`,
                    resendEmailId: meta.emailId,
                    fromAddress: meta.from,
                    toAddresses: meta.to,
                    receivedFor: meta.receivedFor,
                    subject: meta.subject,
                    textBody: null,
                    htmlBody: null,
                    holder: `holder-${++this.ids}`,
                    status: 'processing',
                    leaseUntil: this.now + LEASE_MS,
                    attempts: 1,
                    nextAttemptAt: null,
                    createdAt: this.now,
                    forwardedAt: null,
                    forwardError: null,
                    forwardId: null,
                };
                this.rows.set(meta.emailId, row);
                return { status: 'claimed', message: this.message(row) };
            }
            if (row.status === 'completed') {
                return { status: 'duplicate' };
            }
            if (this.leased(row)) {
                return { status: 'busy', retryAfterSec: Math.ceil(((row.leaseUntil as number) - this.now) / 1000) };
            }
            Object.assign(row, { holder: `holder-${++this.ids}`, leaseUntil: this.now + LEASE_MS });
            row.attempts += 1;
            return { status: 'claimed', message: this.message(row) };
        }),
        claimDue: vi.fn(async (limit: number) =>
            [...this.rows.values()]
                .filter(
                    (row) =>
                        row.status !== 'completed' &&
                        !this.leased(row) &&
                        (row.nextAttemptAt ?? row.createdAt) <= this.now,
                )
                .slice(0, limit)
                .map((row) => {
                    Object.assign(row, { holder: `holder-${++this.ids}`, leaseUntil: this.now + LEASE_MS });
                    row.attempts += 1;
                    return this.message(row);
                }),
        ),
        saveBody: vi.fn(async (id: string, holder: string, text: string | null, html: string | null) => {
            if (this.saveFails > 0) {
                this.saveFails -= 1;
                return null;
            }
            const row = [...this.rows.values()].find((r) => r.id === id);
            if (!row || row.holder !== holder || row.status === 'completed') {
                return false;
            }
            Object.assign(row, { textBody: text, htmlBody: html });
            return true;
        }),
        finish: vi.fn(
            async (
                id: string,
                holder: string,
                outcome: FinishOutcome,
                detail: { error?: string; retryAfterSec?: number; forwardId?: string } = {},
            ) => {
                const row = [...this.rows.values()].find((r) => r.id === id);
                if (!row || row.holder !== holder) {
                    return false;
                }
                const release = { holder: null, leaseUntil: null };
                if (outcome === 'forwarded') {
                    Object.assign(row, release, {
                        status: 'completed',
                        forwardedAt: this.now,
                        forwardError: null,
                        forwardId: detail.forwardId ?? null,
                    });
                } else if (outcome === 'stored' || outcome === 'refused') {
                    Object.assign(row, release, { status: 'completed', forwardError: detail.error ?? null });
                } else if (outcome === 'deferred') {
                    Object.assign(row, release, {
                        status: 'forward_deferred',
                        attempts: Math.max(row.attempts - 1, 0),
                        nextAttemptAt: this.now + Math.max(detail.retryAfterSec ?? 300, 60) * 1000,
                        forwardError: detail.error ?? 'forward deferred: the mail budget is spent',
                    });
                } else {
                    Object.assign(row, release, {
                        forwardError: detail.error ?? null,
                        nextAttemptAt: this.now + 60_000 * 2 ** Math.max(row.attempts - 1, 0),
                    });
                }
                return true;
            },
        ),
    };

    deps(overrides: Partial<InboundDeps> = {}): InboundDeps {
        return {
            json: (body, status = 200) =>
                new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
            options: () => new Response('ok'),
            readText: readCappedText,
            verifySignature: async (_raw, req) =>
                req.headers.get('svix-signature') === 'valid'
                    ? { ok: true }
                    : { ok: false, reason: 'signature_mismatch' },
            retryAuthorized: async (req) => {
                const given = req.headers.get('x-support-retry-secret');
                return given === null ? null : given === RETRY_SECRET;
            },
            config: { signingSecret: 'whsec_x', apiKey: 're_x', forwardTo: FORWARD_TO, forwardFrom: FORWARD_FROM },
            store: this.store,
            fetchBody: vi.fn(async (emailId: string) => {
                await this.gate('fetch');
                if (this.fetchFails > 0) {
                    this.fetchFails -= 1;
                    return { ok: false as const, detail: 'fetch 503' };
                }
                return { ok: true as const, ...(this.bodies.get(emailId) ?? { text: 'Please delete my data.' }) };
            }),
            reserveBudget: vi.fn(async () => {
                if (this.budget.remaining <= 0) {
                    return { ok: false as const, retryAfterSec: this.budget.retryAfterSec };
                }
                this.budget.remaining -= 1;
                this.budget.reserved += 1;
                return {
                    ok: true as const,
                    release: async () => {
                        this.budget.remaining += 1;
                        this.budget.refunds += 1;
                    },
                };
            }),
            send: vi.fn(async (email: ResendEmail, key: string): Promise<ResendResult> => {
                this.sends.push({ email, key });
                await this.gate('send');
                const scripted = this.sendResults.shift();
                if (scripted) {
                    if (scripted.outcome !== 'rejected') {
                        // Unknown means Resend may have taken it: it did, here.
                        this.delivered.set(key, this.delivered.get(key) ?? `re_${this.delivered.size + 1}`);
                    }
                    return scripted;
                }
                const id = this.delivered.get(key) ?? `re_${this.delivered.size + 1}`;
                this.delivered.set(key, id);
                return { outcome: 'sent', reason: 'sent', status: 200, id };
            }),
            idempotencyKey: resendIdempotencyKey,
            mail: { isOwnForward, inboxTagFor, forwardedSubject },
            logError: (code, message) => this.logs.push(`${code}: ${message}`),
            ...overrides,
        };
    }
}

const event = (over: Record<string, unknown> = {}, type = 'email.received') =>
    JSON.stringify({
        type,
        data: {
            email_id: EMAIL_ID,
            created_at: '2026-10-22T09:00:00Z',
            from: 'Ada Parent <ada@example.test>',
            to: ['privacy@cleffy.io'],
            received_for: ['privacy@cleffy.io'],
            message_id: '<abc@example.test>',
            subject: 'Please delete my data',
            attachments: [],
            ...over,
        },
    });

const deliver = (body = event(), signature = 'valid') =>
    new Request('https://edge.test/functions/v1/resend-inbound', {
        method: 'POST',
        headers: { 'svix-id': 'msg_1', 'svix-timestamp': '1', 'svix-signature': signature },
        body,
    });

const retryRun = (secret = RETRY_SECRET) =>
    new Request('https://edge.test/functions/v1/resend-inbound', {
        method: 'POST',
        headers: { 'x-support-retry-secret': secret, 'Content-Type': 'application/json' },
        body: '{}',
    });

const call = async (world: World, req: Request, deps = world.deps()) => {
    const res = await handleResendInbound(req, deps);
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, deps };
};

describe('resend-inbound: one delivery', () => {
    it('stores, reserves the budget, then forwards once with the tags, reply-to and a key from the email id', async () => {
        const world = new World();
        const { status, body, deps } = await call(world, deliver());
        expect(status).toBe(200);
        expect(body).toMatchObject({ forwarded: true });
        expect(world.row()).toMatchObject({
            status: 'completed',
            textBody: 'Please delete my data.',
            forwardId: 're_1',
        });
        expect(world.sends).toHaveLength(1);
        const [{ email, key }] = world.sends as [{ email: ResendEmail; key: string }];
        expect(email).toMatchObject({
            from: FORWARD_FROM,
            to: [FORWARD_TO],
            reply_to: 'Ada Parent <ada@example.test>',
            subject: '[privacy] Please delete my data',
        });
        expect(key).toBe(`${SUPPORT_FORWARD_OUTBOX}-${EMAIL_ID}`);
        const order = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ?? Infinity;
        expect(order(world.store.saveBody)).toBeLessThan(order(deps.reserveBudget));
        expect(order(deps.reserveBudget)).toBeLessThan(order(deps.send));
        expect(world.budget.reserved).toBe(1);
    });

    it('a delivery after it completed is the duplicate: 200, and nothing fetched or sent', async () => {
        const world = new World();
        await call(world, deliver());
        const again = await call(world, deliver());
        expect(again).toMatchObject({ status: 200, body: { duplicate: true } });
        expect(again.deps.fetchBody).not.toHaveBeenCalled();
        expect(world.sends).toHaveLength(1);
        expect(world.budget.reserved).toBe(1);
    });

    it('a delivery while another holds the row is 503, so Svix comes back rather than giving up', async () => {
        const world = new World();
        const paused = world.pause('send');
        const first = call(world, deliver());
        await paused.arrived;
        const second = await call(world, deliver());
        expect(second.status).toBe(503);
        expect(second.body).toMatchObject({ inProgress: true });
        paused.resume();
        expect((await first).status).toBe(200);
        expect(world.sends).toHaveLength(1);
    });
});

describe('resend-inbound: an interrupted first delivery is resumed', () => {
    it('a delivery killed mid-send is taken over once its lease runs out, with the same key and no second copy', async () => {
        const world = new World();
        const paused = world.pause('send');
        const dying = call(world, deliver());
        await paused.arrived;

        // The isolate is gone; Svix retries after the lease has run out.
        world.now += LEASE_MS + 1;
        const resumed = await call(world, deliver());
        expect(resumed.status).toBe(200);
        expect(resumed.body).toMatchObject({ forwarded: true });
        // The body was stored by the first delivery and not fetched again.
        expect(resumed.deps.fetchBody).not.toHaveBeenCalled();

        paused.resume();
        const late = await dying;
        // Its lease is gone: its outcome is not recorded over the new one.
        expect(late.status).toBe(500);
        expect(world.row()).toMatchObject({ status: 'completed', forwardId: 're_1' });
        const keys = world.sends.map((s) => s.key);
        expect(keys).toEqual([`${SUPPORT_FORWARD_OUTBOX}-${EMAIL_ID}`, `${SUPPORT_FORWARD_OUTBOX}-${EMAIL_ID}`]);
        // Resend saw one key: one email, however many requests.
        expect(world.delivered.size).toBe(1);
    });

    it('a forward whose outcome is unknown keeps its budget, answers 502, and the retry replays the same key', async () => {
        const world = new World();
        world.sendResults.push({ outcome: 'unknown', reason: 'network', status: null });
        const first = await call(world, deliver());
        expect(first.status).toBe(502);
        expect(world.row()).toMatchObject({ status: 'processing', holder: null });
        expect(world.budget.refunds).toBe(0);

        const retry = await call(world, deliver());
        expect(retry).toMatchObject({ status: 200, body: { forwarded: true } });
        expect(world.sends.map((s) => s.key)).toEqual([
            `${SUPPORT_FORWARD_OUTBOX}-${EMAIL_ID}`,
            `${SUPPORT_FORWARD_OUTBOX}-${EMAIL_ID}`,
        ]);
        expect(world.delivered.size).toBe(1);
    });

    it('a body that cannot be fetched answers 502 and is fetched by the next delivery', async () => {
        const world = new World();
        world.fetchFails = 1;
        const first = await call(world, deliver());
        expect(first).toMatchObject({ status: 502, body: { reason: 'body_fetch_failed' } });
        expect(world.row()).toMatchObject({ status: 'processing', forwardError: 'no body yet (fetch 503)' });
        expect(world.sends).toHaveLength(0);

        const second = await call(world, deliver());
        expect(second).toMatchObject({ status: 200, body: { forwarded: true } });
    });

    it('a body that cannot be stored answers 500 (no longer ignored), and the next delivery stores it', async () => {
        const world = new World();
        world.saveFails = 1;
        const first = await call(world, deliver());
        expect(first.status).toBe(500);
        expect(world.sends).toHaveLength(0);
        expect(world.row()).toMatchObject({ status: 'processing', textBody: null });

        const second = await call(world, deliver());
        expect(second).toMatchObject({ status: 200, body: { forwarded: true } });
        expect(world.row().textBody).toBe('Please delete my data.');
    });

    it('a store that cannot record the delivery at all is 500, so Svix retries', async () => {
        const world = new World();
        world.store.claim.mockResolvedValueOnce(null);
        expect((await call(world, deliver())).status).toBe(500);
    });
});

describe('resend-inbound: the mail budget', () => {
    it('a spent budget stores the message as forward_deferred and answers 200, sending nothing', async () => {
        const world = new World();
        world.budget.remaining = 0;
        const first = await call(world, deliver());
        expect(first).toMatchObject({ status: 200, body: { forwarded: false, reason: 'budget_deferred' } });
        expect(world.row()).toMatchObject({ status: 'forward_deferred', textBody: 'Please delete my data.' });
        expect(world.sends).toHaveLength(0);
    });

    it('the retry run forwards it once due and paid for, with the key the webhook would have used', async () => {
        const world = new World();
        world.budget.remaining = 0;
        await call(world, deliver());

        const early = await call(world, retryRun());
        expect(early).toMatchObject({ status: 200, body: { processed: 0 } });

        world.now += world.budget.retryAfterSec * 1000;
        world.budget.remaining = 8;
        const run = await call(world, retryRun());
        expect(run).toMatchObject({ status: 200, body: { processed: 1 } });
        expect(world.row()).toMatchObject({ status: 'completed', forwardedAt: world.now });
        expect(world.sends.map((s) => s.key)).toEqual([`${SUPPORT_FORWARD_OUTBOX}-${EMAIL_ID}`]);
        // The body was fetched once, by the webhook.
        expect(run.deps.fetchBody).not.toHaveBeenCalled();
    });

    it('a retry run is refused without the right secret', async () => {
        const world = new World();
        expect((await call(world, retryRun('wrong'))).status).toBe(401);
        expect(world.store.claimDue).not.toHaveBeenCalled();
    });

    it('a forward Resend rejects hands its reservation back and is recorded for good', async () => {
        const world = new World();
        world.sendResults.push({ outcome: 'rejected', reason: 'http_422', status: 422, errorName: 'validation_error' });
        const res = await call(world, deliver());
        expect(res).toMatchObject({ status: 200, body: { forwarded: false } });
        expect(world.budget.refunds).toBe(1);
        expect(world.row()).toMatchObject({ status: 'completed', forwardError: 'http_422 validation_error' });
    });

    it('a 429 from Resend hands its reservation back and defers', async () => {
        const world = new World();
        world.sendResults.push({ outcome: 'rejected', reason: 'http_429', status: 429, retryAfterMs: 120_000 });
        const res = await call(world, deliver());
        expect(res).toMatchObject({ status: 200, body: { reason: 'rate_limited' } });
        expect(world.budget.refunds).toBe(1);
        expect(world.row()).toMatchObject({ status: 'forward_deferred', nextAttemptAt: world.now + 120_000 });
    });

    it('forwards spend the contentReportAck share, in the very buckets content-report acknowledgments use', () => {
        const source = readFileSync(resolve(process.cwd(), 'supabase/functions/resend-inbound/index.ts'), 'utf8');
        expect(source).toContain("mailBudgetKey('content-report-ack', window)");
        expect(source).toContain("mailLimit('contentReportAck', window, env)");
        expect(mailBudgetKey('content-report-ack', 'hour')).toBe('mail:content-report-ack:hour');
        // Decision 14: no split change -- the share is still 8/35.
        expect(mailLimit('contentReportAck', 'hour').limit).toBe(8);
        expect(mailLimit('contentReportAck', 'day').limit).toBe(35);
    });
});

describe('resend-inbound: the idempotency key', () => {
    it('is derived from the Resend email id alone: stable across attempts, distinct per email, no address in it', () => {
        const key = resendIdempotencyKey(SUPPORT_FORWARD_OUTBOX, EMAIL_ID);
        expect(key).toBe(resendIdempotencyKey(SUPPORT_FORWARD_OUTBOX, EMAIL_ID));
        expect(key).not.toBe(resendIdempotencyKey(SUPPORT_FORWARD_OUTBOX, 'another-email-id'));
        expect(key).not.toMatch(/[@.\s]/);
        expect(key.length).toBeLessThanOrEqual(256);
    });

    it('an email id that could not key a forward is refused as malformed', async () => {
        const world = new World();
        const res = await call(world, deliver(event({ email_id: 'not an id@example.test' })));
        expect(res.status).toBe(400);
        expect(world.store.claim).not.toHaveBeenCalled();
    });
});

describe('resend-inbound: what it never forwards', () => {
    it('keeps the loop guard: stored, refused, no budget spent and nothing sent', async () => {
        const world = new World();
        const res = await call(world, deliver(event({ from: FORWARD_FROM })));
        expect(res).toMatchObject({ status: 200, body: { reason: 'loop_guard' } });
        expect(world.row()).toMatchObject({ status: 'completed', forwardError: LOOP_GUARD_ERROR });
        expect(world.budget.reserved).toBe(0);
        expect(world.sends).toHaveLength(0);
    });

    it('keeps the inbox tags: legal@ and support@ are tagged as such', async () => {
        const world = new World();
        await call(world, deliver(event({ to: ['legal@cleffy.io'], received_for: ['legal@cleffy.io'] })));
        expect(world.sends[0]?.email.subject).toBe('[legal] Please delete my data');
        const other = new World();
        await call(other, deliver(event({ to: ['billing@cleffy.io'], received_for: [] })));
        expect(other.sends[0]?.email.subject).toBe('[support] Please delete my data');
    });

    it('store-only mode completes the row and spends nothing', async () => {
        const world = new World();
        const deps = world.deps({
            config: { signingSecret: 'whsec_x', apiKey: 're_x', forwardTo: null, forwardFrom: FORWARD_FROM },
        });
        const res = await call(world, deliver(), deps);
        expect(res).toMatchObject({ status: 200, body: { forwarded: false } });
        expect(world.row()).toMatchObject({ status: 'completed', forwardError: null });
        expect(deps.reserveBudget).not.toHaveBeenCalled();
    });

    it('a message with no body at all is completed with that reason', async () => {
        const world = new World();
        world.bodies.set(EMAIL_ID, {});
        const res = await call(world, deliver());
        expect(res).toMatchObject({ status: 200, body: { reason: 'no_body' } });
        expect(world.row()).toMatchObject({ status: 'completed', forwardError: 'no body to forward' });
    });
});

describe('resend-inbound: intake', () => {
    it('refuses a bad signature with 400 and records nothing', async () => {
        const world = new World();
        expect((await call(world, deliver(event(), 'forged'))).status).toBe(400);
        expect(world.store.claim).not.toHaveBeenCalled();
    });

    it('acknowledges other event types without recording them', async () => {
        const world = new World();
        const res = await call(world, deliver(event({}, 'email.delivered')));
        expect(res).toMatchObject({ status: 200, body: { ignored: 'email.delivered' } });
        expect(world.store.claim).not.toHaveBeenCalled();
    });

    it('answers 413 to a chunked webhook body past 256 KiB, before verifying or recording anything', async () => {
        expect(WEBHOOK_BODY_MAX_BYTES).toBe(SHARED_WEBHOOK_MAX);
        const world = new World();
        const verify = vi.fn(async () => ({ ok: true as const }));
        const { request } = chunkedRequest(WEBHOOK_BODY_MAX_BYTES + 1, {
            headers: { 'svix-signature': 'valid' },
        });
        const res = await call(world, request, world.deps({ verifySignature: verify }));
        expect(res).toMatchObject({ status: 413, body: PAYLOAD_TOO_LARGE });
        expect(verify).not.toHaveBeenCalled();
        expect(world.store.claim).not.toHaveBeenCalled();
    });

    it('is a 500 (so Svix retries) when it is not configured', async () => {
        const world = new World();
        const deps = world.deps({
            config: { signingSecret: null, apiKey: 're_x', forwardTo: FORWARD_TO, forwardFrom: FORWARD_FROM },
        });
        expect((await call(world, deliver(), deps)).status).toBe(500);
    });
});
