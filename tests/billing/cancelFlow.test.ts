// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Delivery } from '../../supabase/functions/_shared/billingOutbox';
import * as billingTerms from '../../supabase/functions/_shared/billingTerms';
import {
    CANCEL_LINK_TTL_MS,
    deliverCancelLink,
    handleCancel,
    maskEmail,
    type CancelDeps,
    type CancelLinkDeps,
    type CancelLinkRequest,
    type CancellableSubscription,
    type LiveSubscription,
    type StoredCancelToken,
} from '../../supabase/functions/_shared/cancelFlow';
import { liveSubscriptionOf } from '../../supabase/functions/_shared/stripeEvents';
import type { StripeMode } from '../../supabase/functions/_shared/stripeMode';

/**
 * The signed-out cancellation flow, run for real against in-memory stand-ins
 * for the token table, the rate limiter, Resend and Stripe.
 */

const NOW = Date.parse('2026-10-20T20:00:00Z');
const DAY = 24 * 60 * 60_000;
const USER = '0b5e0000-0000-4000-8000-0000000000c1';
const EMAIL = 'ada@example.com';

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const post = (body: unknown) =>
    new Request('https://edge.test/functions/v1/billing-cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://cleffy.io' },
        body: JSON.stringify(body),
    });

const sha256Hex = async (value: string) => createHash('sha256').update(value).digest('hex');

const harness = (
    options: {
        subscription?: CancellableSubscription | null;
        firstPurchaseAt?: number | null;
        sendFails?: boolean;
        stripeFails?: boolean;
        limited?: string[];
        /**
         * Stripe's own copy of the subscription, which the flow reads before it
         * acts (Codex finding 2 on #62). Defaults to agreeing with the mirror;
         * set it to model a mirror the webhook has not caught up with. null is
         * a subscription Stripe does not have.
         */
        live?: LiveSubscription | null;
        stripeReadFails?: boolean;
        /** Stripe answers the update without the subscription cancelling. */
        updateNotApplied?: boolean;
        /** billing_mail_outbox cannot be written. */
        queueFails?: boolean;
        /** The mail budget windows, smaller to model them being spent. */
        mailBudget?: CancelLinkDeps['mailBudget'];
    } = {},
) => {
    const tokens = new Map<string, StoredCancelToken>();
    const sent: Array<{ to: string; subject: string; text: string; replyTo?: string }> = [];
    const limiter = new Map<string, number>();
    const refunded: string[] = [];
    const errors: string[] = [];
    /** Every call the HANDLER makes, in order -- what an observer could time. */
    const trace: string[] = [];
    /** billing_mail_outbox, modelled: what /cancel wrote down, and what the worker made of it. */
    const queue: Array<{ request: CancelLinkRequest; mode: StripeMode }> = [];
    const deliveries: Delivery[] = [];
    const subscription: CancellableSubscription | null =
        options.subscription === undefined
            ? {
                  subscriptionId: 'sub_1',
                  priceId: 'price_teacher_monthly',
                  status: 'active',
                  periodEnd: '2026-11-20T20:00:00.000Z',
                  cancelAtPeriodEnd: false,
              }
            : options.subscription;
    let live: LiveSubscription | null =
        options.live !== undefined
            ? options.live
            : subscription && {
                  status: subscription.status,
                  cancelling: subscription.cancelAtPeriodEnd,
                  endsAt: subscription.periodEnd,
              };
    let tokenCount = 0;
    const checkRateLimit = vi.fn(async (key: string, limit: number, _windowMs?: number) => {
        if (options.limited?.some((prefix) => key.startsWith(prefix))) {
            return { ok: false as const, retryAfterSec: 60 };
        }
        const used = (limiter.get(key) ?? 0) + 1;
        limiter.set(key, used);
        return used > limit ? { ok: false as const, retryAfterSec: 60 } : { ok: true as const };
    });
    const sendEmail = vi.fn(
        async (to: string, message: billingTerms.BillingEmail, mailOptions: { replyTo?: string }) => {
            if (options.sendFails) {
                return 'failed' as const;
            }
            sent.push({ to, subject: message.subject, text: message.text, replyTo: mailOptions.replyTo });
            return 'sent' as const;
        },
    );
    const cancellableSubscription = vi.fn(async () => subscription);
    const deps: CancelDeps = {
        json,
        options: () => new Response(null, { status: 204 }),
        clientKey: () => '203.0.113.7',
        checkRateLimit: async (key, limit, windowMs) => {
            trace.push(`rate:${key.replace(/[^:]+$/, '*')}`);
            return checkRateLimit(key, limit, windowMs);
        },
        modeForRequest: () => 'live',
        appOrigin: () => 'https://cleffy.io',
        sha256Hex,
        queueCancelLink: vi.fn(async (request: CancelLinkRequest, mode: StripeMode) => {
            trace.push('queue');
            if (options.queueFails) {
                throw new Error('connection reset');
            }
            queue.push({ request, mode });
        }),
        sendQueued: vi.fn(() => {
            trace.push('send-queued');
        }),
        emailOfUser: async () => EMAIL,
        cancellableSubscription,
        firstPurchaseAt: async () => (options.firstPurchaseAt === undefined ? NOW - 3 * DAY : options.firstPurchaseAt),
        readToken: async (hash) => tokens.get(hash) ?? null,
        consumeToken: async (hash, nowIso) => {
            const row = tokens.get(hash);
            if (!row || row.usedAt !== null) {
                return false;
            }
            row.usedAt = nowIso;
            return true;
        },
        liveSubscription: vi.fn(async () => {
            if (options.stripeReadFails) {
                throw new Error('Stripe is down');
            }
            return live;
        }),
        cancelAtPeriodEnd: vi.fn(async () => {
            if (options.stripeFails) {
                throw new Error('Stripe is down');
            }
            if (!live) {
                throw new Error('No such subscription');
            }
            if (!options.updateNotApplied) {
                live = { ...live, cancelling: true, endsAt: '2026-11-20T20:00:00.000Z' };
                // The mirror catches up when the webhook lands, not before.
            }
            return live;
        }),
        sendEmail,
        terms: billingTerms,
        planNameForPrice: (priceId) => (priceId === 'price_teacher_monthly' ? 'Teacher' : null),
        now: () => NOW,
        logError: (code) => errors.push(code),
    };
    const linkDeps: CancelLinkDeps = {
        checkRateLimit,
        refundRateLimit: vi.fn(async (key: string) => {
            refunded.push(key);
            limiter.set(key, Math.max(0, (limiter.get(key) ?? 0) - 1));
        }),
        mailBudget: options.mailBudget ?? {
            hour: { limit: 10, windowMs: 3_600_000 },
            day: { limit: 50, windowMs: DAY },
        },
        sha256Hex,
        secret: () => 'pepper',
        newToken: () => `token-${++tokenCount}-abcdefghijklmnop`,
        userForEmail: vi.fn(async (email: string) => (email === EMAIL ? USER : null)),
        cancellableSubscription,
        saveToken: async ({ hash, userId, mode, expiresAt }) => {
            tokens.set(hash, { userId, mode, expiresAt, usedAt: null });
        },
        sendEmail,
        terms: billingTerms,
        now: () => NOW,
        logError: (code) => errors.push(code),
    };
    /**
     * The outbox worker, after the response: delivers everything queued, and
     * keeps what it is told to retry, as settle_billing_mail does.
     */
    const flush = async (): Promise<Delivery[]> => {
        const due = queue.splice(0);
        const outcomes: Delivery[] = [];
        for (const item of due) {
            const outcome = await deliverCancelLink(linkDeps, item.mode, item.request);
            outcomes.push(outcome);
            if (outcome.outcome === 'retry') {
                queue.push(item);
            }
        }
        deliveries.push(...outcomes);
        return outcomes;
    };
    /** The window reopening: what the budget and recipient limits had counted is forgotten. */
    const newHour = () => limiter.clear();
    return { deps, linkDeps, tokens, sent, refunded, errors, trace, queue, flush, newHour, deliveries };
};

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

/** The token out of the link in the last email sent. */
const tokenFrom = (text: string): string => {
    const match = text.match(/\/cancel\?token=([^\s]+)/);
    if (!match?.[1]) {
        throw new Error('no link in the email');
    }
    return decodeURIComponent(match[1]);
};

describe('billing-cancel: asking for a link', () => {
    it('mails a one-time link to an address with a running subscription, after answering', async () => {
        const h = harness();

        const response = await handleCancel(post({ action: 'start', email: ' Ada@Example.com ' }), h.deps);

        expect(response.status).toBe(200);
        expect(await body(response)).toEqual({ sent: true });
        // Answered before anything was looked up or sent.
        expect(h.sent).toEqual([]);
        expect(h.queue).toEqual([{ request: { email: EMAIL, origin: 'https://cleffy.io' }, mode: 'live' }]);
        expect(h.deps.sendQueued).toHaveBeenCalledTimes(1);

        expect(await h.flush()).toEqual([{ outcome: 'sent' }]);
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]?.to).toBe(EMAIL);
        expect(h.sent[0]?.text).toContain('https://cleffy.io/cancel?token=');
        // Only the hash is stored; the token itself exists only in the email.
        const token = tokenFrom(h.sent[0]?.text ?? '');
        expect([...h.tokens.keys()]).toEqual([await sha256Hex(token)]);
        expect(h.tokens.get(await sha256Hex(token))?.expiresAt).toBe(new Date(NOW + CANCEL_LINK_TTL_MS).toISOString());
    });

    it('sends nothing to an address with no account or no subscription, and keeps nothing of it', async () => {
        const stranger = harness();
        const lapsed = harness({ subscription: null });

        await handleCancel(post({ action: 'start', email: 'nobody@example.com' }), stranger.deps);
        await handleCancel(post({ action: 'start', email: EMAIL }), lapsed.deps);

        expect(await stranger.flush()).toEqual([{ outcome: 'done', reason: 'no_subscription' }]);
        expect(await lapsed.flush()).toEqual([{ outcome: 'done', reason: 'no_subscription' }]);
        expect(stranger.sent).toEqual([]);
        expect(lapsed.sent).toEqual([]);
        expect(lapsed.tokens.size).toBe(0);
        // `done` deletes the outbox row, address and all.
        expect(stranger.queue).toEqual([]);
    });

    /**
     * Codex finding 4 on #62: a subscriber was answered 503 when the mail budget
     * was spent or Resend failed, everyone else 200, and the subscriber's lookup
     * and send took time nobody else's did. The answer, and every call made
     * before it, must not depend on the address.
     */
    describe('answers every address the same, in the same way (Codex finding 4 on #62)', () => {
        const SCENARIOS: Array<[string, Parameters<typeof harness>[0], string]> = [
            ['a subscriber', {}, EMAIL],
            ['an address with no account', {}, 'nobody@example.com'],
            ['an account with no subscription', { subscription: null }, EMAIL],
            [
                'a subscriber while the mail budget is spent',
                { mailBudget: { hour: { limit: 0, windowMs: 3_600_000 }, day: { limit: 50, windowMs: DAY } } },
                EMAIL,
            ],
            ['a subscriber while Resend is failing', { sendFails: true }, EMAIL],
        ];

        it.each(SCENARIOS)('for %s', async (_label, options, email) => {
            const h = harness(options);
            const response = await handleCancel(post({ action: 'start', email }), h.deps);

            expect(response.status).toBe(200);
            expect(await body(response)).toEqual({ sent: true });
            // The same calls, in the same order, whoever the address belongs
            // to: an IP limit, one insert, the background send. No lookup, no
            // per-recipient limit, no budget and no Resend call before the
            // answer -- so nothing about the address can show in its timing.
            expect(h.trace).toEqual(['rate:billing-cancel:start:ip:*', 'queue', 'send-queued']);
            expect(h.deps.cancellableSubscription).not.toHaveBeenCalled();
            expect(h.linkDeps.userForEmail).not.toHaveBeenCalled();
            expect(h.deps.sendEmail).not.toHaveBeenCalled();
        });

        it('answers a failure to queue identically for every address', async () => {
            const answers = [];
            for (const email of [EMAIL, 'nobody@example.com']) {
                const h = harness({ queueFails: true });
                const response = await handleCancel(post({ action: 'start', email }), h.deps);
                answers.push([response.status, await body(response)]);
            }
            expect(answers[0]).toEqual([503, expect.objectContaining({ code: 'unavailable' })]);
            expect(answers[1]).toEqual(answers[0]);
        });
    });

    it('queues a link the mail budget holds back, and sends it when the window reopens', async () => {
        const h = harness({
            mailBudget: { hour: { limit: 1, windowMs: 3_600_000 }, day: { limit: 50, windowMs: DAY } },
        });
        // Someone else's link spends this hour's budget.
        h.linkDeps.checkRateLimit('billing-cancel:global', 1, 3_600_000);

        await handleCancel(post({ action: 'start', email: EMAIL }), h.deps);
        expect(await h.flush()).toEqual([{ outcome: 'retry', reason: 'mail budget spent', afterMs: 60_000 }]);
        expect(h.sent).toEqual([]);
        // Still queued, and nothing it counted on the way is kept against it.
        expect(h.queue).toHaveLength(1);
        expect(h.refunded.some((key) => key.startsWith('billing-cancel:start:to:'))).toBe(true);

        h.newHour();
        expect(await h.flush()).toEqual([{ outcome: 'sent' }]);
        expect(h.sent).toHaveLength(1);
        expect(h.queue).toEqual([]);
    });

    it('retries a link Resend failed to send, handing the budget back', async () => {
        const h = harness({ sendFails: true });
        await handleCancel(post({ action: 'start', email: EMAIL }), h.deps);

        expect(await h.flush()).toEqual([{ outcome: 'retry', reason: 'resend failed' }]);
        expect(h.refunded).toEqual(expect.arrayContaining(['billing-cancel:global', 'billing-cancel:global-day']));
        expect(h.queue).toHaveLength(1);
    });

    it('limits how many links one address can be sent', async () => {
        const h = harness();
        for (let i = 0; i < 5; i += 1) {
            expect(await body(await handleCancel(post({ action: 'start', email: EMAIL }), h.deps))).toEqual({
                sent: true,
            });
        }
        await h.flush();
        expect(h.sent).toHaveLength(3);
        expect(h.deliveries.filter((d) => d.outcome === 'done')).toEqual([
            { outcome: 'done', reason: 'recipient_limited' },
            { outcome: 'done', reason: 'recipient_limited' },
        ]);
    });

    it('refuses a caller over the per-IP limit, before writing anything down', async () => {
        const h = harness({ limited: ['billing-cancel:start:ip:'] });
        const response = await handleCancel(post({ action: 'start', email: EMAIL }), h.deps);
        expect(response.status).toBe(429);
        expect(h.deps.queueCancelLink).not.toHaveBeenCalled();
    });

    it('rejects something that is not an email address', async () => {
        const h = harness();
        const response = await handleCancel(post({ action: 'start', email: 'not an email' }), h.deps);
        expect(response.status).toBe(400);
        expect(await body(response)).toMatchObject({ code: 'invalid_email' });
        expect(h.deps.queueCancelLink).not.toHaveBeenCalled();
    });
});

describe('billing-cancel: using the link', () => {
    const linked = async (options: Parameters<typeof harness>[0] = {}) => {
        const h = harness(options);
        await handleCancel(post({ action: 'start', email: EMAIL }), h.deps);
        await h.flush();
        return { ...h, token: tokenFrom(h.sent[0]?.text ?? '') };
    };

    it('shows what it would cancel, without the full address', async () => {
        const h = await linked();
        const response = await handleCancel(post({ action: 'peek', token: h.token }), h.deps);
        expect(await body(response)).toEqual({
            email: maskEmail(EMAIL),
            plan: 'Teacher',
            status: 'active',
            periodEnd: '2026-11-20T20:00:00.000Z',
            alreadyCancelling: false,
            refundEligible: true,
        });
    });

    it('cancels at the end of the period and spends the link', async () => {
        const h = await linked();

        const response = await handleCancel(post({ action: 'cancel', token: h.token }), h.deps);

        expect(await body(response)).toEqual({
            cancelled: true,
            cancelledAt: new Date(NOW).toISOString(),
            endsAt: '2026-11-20T20:00:00.000Z',
            refundRequested: false,
            refundRequestFailed: false,
        });
        expect(h.deps.cancelAtPeriodEnd).toHaveBeenCalledWith('sub_1', 'live');
        const again = await handleCancel(post({ action: 'peek', token: h.token }), h.deps);
        expect(again.status).toBe(404);
        expect(await body(again)).toMatchObject({ code: 'link_invalid' });
    });

    it('emails support@ once when a refund is asked for inside the window, replying to the buyer', async () => {
        const h = await linked();

        const response = await handleCancel(post({ action: 'cancel', token: h.token, requestRefund: true }), h.deps);

        expect(await body(response)).toMatchObject({ refundRequested: true });
        const toSupport = h.sent.filter((mail) => mail.to === 'support@cleffy.io');
        expect(toSupport).toHaveLength(1);
        expect(toSupport[0]?.replyTo).toBe(EMAIL);
        expect(toSupport[0]?.subject).toContain('[support]');
        expect(toSupport[0]?.text).toContain('sub_1');
    });

    it('sends no refund request once the 14 days are over', async () => {
        const h = await linked({ firstPurchaseAt: NOW - 20 * DAY });
        const peek = await body(await handleCancel(post({ action: 'peek', token: h.token }), h.deps));
        expect(peek.refundEligible).toBe(false);

        await handleCancel(post({ action: 'cancel', token: h.token, requestRefund: true }), h.deps);
        expect(h.sent.filter((mail) => mail.to === 'support@cleffy.io')).toEqual([]);
    });

    it('keeps the link usable when Stripe could not be reached', async () => {
        const h = await linked({ stripeFails: true });
        const response = await handleCancel(post({ action: 'cancel', token: h.token }), h.deps);
        expect(response.status).toBe(502);
        expect((await handleCancel(post({ action: 'peek', token: h.token }), h.deps)).status).toBe(200);
    });

    it('refuses an expired link and one it never issued', async () => {
        const h = await linked();
        const [hash] = [...h.tokens.keys()];
        const row = h.tokens.get(hash ?? '');
        if (row) {
            row.expiresAt = new Date(NOW - 1).toISOString();
        }
        expect((await handleCancel(post({ action: 'peek', token: h.token }), h.deps)).status).toBe(404);
        expect((await handleCancel(post({ action: 'cancel', token: 'made-up-token-0123456789' }), h.deps)).status).toBe(
            404,
        );
        expect(h.deps.cancelAtPeriodEnd).not.toHaveBeenCalled();
    });

    it('does not call Stripe again for a subscription Stripe says is already set to cancel', async () => {
        const h = await linked({
            subscription: {
                subscriptionId: 'sub_1',
                priceId: 'price_teacher_monthly',
                status: 'active',
                periodEnd: '2026-11-20T20:00:00.000Z',
                cancelAtPeriodEnd: true,
            },
        });
        const response = await handleCancel(post({ action: 'cancel', token: h.token }), h.deps);
        expect(await body(response)).toMatchObject({ cancelled: true, endsAt: '2026-11-20T20:00:00.000Z' });
        expect(h.deps.liveSubscription).toHaveBeenCalledWith('sub_1', 'live');
        expect(h.deps.cancelAtPeriodEnd).not.toHaveBeenCalled();
    });

    describe("acts on Stripe's copy of the subscription, never the mirror's (Codex finding 2 on #62)", () => {
        const cancellingMirror: CancellableSubscription = {
            subscriptionId: 'sub_1',
            priceId: 'price_teacher_monthly',
            status: 'active',
            periodEnd: '2026-11-20T20:00:00.000Z',
            cancelAtPeriodEnd: true,
        };

        it('cancels in Stripe when the buyer resumed in the portal before the webhook landed', async () => {
            // The review's scenario: the mirror still says cancelling, Stripe
            // says it will renew. Trusting the mirror skipped Stripe, spent the
            // link and promised a cancellation that was never made.
            const h = await linked({
                subscription: cancellingMirror,
                live: { status: 'active', cancelling: false, endsAt: '2026-11-20T20:00:00.000Z' },
            });

            const peek = await body(await handleCancel(post({ action: 'peek', token: h.token }), h.deps));
            expect(peek.alreadyCancelling).toBe(false);

            const response = await handleCancel(post({ action: 'cancel', token: h.token }), h.deps);

            expect(await body(response)).toMatchObject({ cancelled: true, endsAt: '2026-11-20T20:00:00.000Z' });
            expect(h.deps.cancelAtPeriodEnd).toHaveBeenCalledWith('sub_1', 'live');
        });

        it('never reports success when Stripe does not confirm the subscription is cancelling', async () => {
            const h = await linked({ updateNotApplied: true });

            const response = await handleCancel(post({ action: 'cancel', token: h.token }), h.deps);

            expect(response.status).toBe(502);
            expect(await body(response)).toMatchObject({ code: 'unavailable' });
            expect(h.errors).toContain('cancel_not_confirmed');
            // The link is not spent, so the buyer can try again.
            expect((await handleCancel(post({ action: 'peek', token: h.token }), h.deps)).status).toBe(200);
        });

        it('still cancels at period end when Stripe holds a cancel_at months after it', async () => {
            // Codex round 2, finding 1 on #62: billing-cancel read ANY cancel_at
            // as already cancelling, skipped the update, spent the link and
            // said "cancelled" while the renewals before that date still billed.
            // The Stripe object goes through the adapter billing-cancel uses.
            const periodEnd = Date.parse('2026-11-20T20:00:00.000Z') / 1000;
            const live = liveSubscriptionOf({
                id: 'sub_1',
                status: 'active',
                cancel_at_period_end: false,
                cancel_at: periodEnd + 90 * 24 * 60 * 60,
                items: { data: [{ price: { id: 'price_teacher_monthly' }, current_period_end: periodEnd }] },
            });
            const h = await linked({ live });

            const peek = await body(await handleCancel(post({ action: 'peek', token: h.token }), h.deps));
            expect(peek).toMatchObject({ alreadyCancelling: false, periodEnd: '2026-11-20T20:00:00.000Z' });

            const response = await handleCancel(post({ action: 'cancel', token: h.token }), h.deps);
            expect(await body(response)).toMatchObject({ cancelled: true, endsAt: '2026-11-20T20:00:00.000Z' });
            expect(h.deps.cancelAtPeriodEnd).toHaveBeenCalledWith('sub_1', 'live');
        });

        it('shows Stripe saying it is already cancelling even when the mirror has not caught up', async () => {
            const h = await linked({
                live: { status: 'active', cancelling: true, endsAt: '2026-11-05T00:00:00.000Z' },
            });
            const peek = await body(await handleCancel(post({ action: 'peek', token: h.token }), h.deps));
            expect(peek).toMatchObject({ alreadyCancelling: true, periodEnd: '2026-11-05T00:00:00.000Z' });
        });

        it('has nothing to cancel once Stripe has ended the subscription the mirror still holds', async () => {
            for (const live of [{ status: 'canceled', cancelling: false, endsAt: null }, null]) {
                const h = await linked({ live });
                const response = await handleCancel(post({ action: 'cancel', token: h.token }), h.deps);
                expect(response.status).toBe(404);
                expect(await body(response)).toMatchObject({ code: 'nothing_to_cancel' });
                expect(h.deps.cancelAtPeriodEnd).not.toHaveBeenCalled();
            }
        });

        it('refuses to guess when Stripe cannot be read', async () => {
            const h = await linked({ stripeReadFails: true });
            const response = await handleCancel(post({ action: 'cancel', token: h.token }), h.deps);
            expect(response.status).toBe(503);
            expect(h.deps.cancelAtPeriodEnd).not.toHaveBeenCalled();
        });
    });
});

describe('billing-cancel/index.ts is wiring only', () => {
    const source = readFileSync(resolve(process.cwd(), 'supabase/functions/billing-cancel/index.ts'), 'utf8');
    const config = readFileSync(resolve(process.cwd(), 'supabase/config.toml'), 'utf8');

    it('runs the flow this file tests', () => {
        expect(source).toMatch(/Deno\.serve\(\(req\) =>\s*\n\s*handleCancel\(req, \{/);
    });

    it('cancels at the period end, as the Customer Portal does', () => {
        expect(source).toContain('cancel_at_period_end: true');
        expect(source).not.toMatch(/subscriptions\.cancel\(/);
    });

    it('writes every address down and sends after the answer, through the billing mail outbox', () => {
        expect(source).toContain("enqueueBillingMail('cancel_link', null, mode");
        expect(source).toContain('sendQueued: drainInBackground');
        // Nothing that looks an address up or sends a link runs in the request.
        expect(source).not.toContain('userForEmail');
        expect(source).not.toContain('mailLimit(');
        const worker = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/billingMailWorker.ts'), 'utf8');
        expect(worker).toMatch(/case 'cancel_link':\s*\n\s*return deliverCancelLink\(/);
    });

    it("reads the subscription back from Stripe rather than trusting the mirror's copy", () => {
        expect(source).toContain('subscriptions.retrieve(subscriptionId)');
    });

    it('is reachable without signing in', () => {
        expect(config).toMatch(/\[functions\.billing-cancel\]\s*\nverify_jwt = false/);
    });
});

describe("reading Stripe's subscription for the cancel page (stripeEvents.ts liveSubscriptionOf)", () => {
    const PERIOD_END = Date.parse('2026-11-20T20:00:00.000Z') / 1000;
    const stripeSub = (fields: { cancel_at_period_end?: boolean; cancel_at?: number | null }) =>
        liveSubscriptionOf({
            id: 'sub_1',
            status: 'active',
            items: { data: [{ price: { id: 'price_teacher_monthly' }, current_period_end: PERIOD_END }] },
            ...fields,
        });

    it('counts a cancel_at later than the period end as not cancelling yet', () => {
        expect(stripeSub({ cancel_at: PERIOD_END + 90 * 86_400 })).toEqual({
            status: 'active',
            cancelling: false,
            endsAt: '2026-11-20T20:00:00.000Z',
        });
    });

    it('counts a cancel_at at or before the period end as the last period, ending then', () => {
        expect(stripeSub({ cancel_at: PERIOD_END })).toMatchObject({
            cancelling: true,
            endsAt: '2026-11-20T20:00:00.000Z',
        });
        expect(stripeSub({ cancel_at: PERIOD_END - 86_400 })).toMatchObject({
            cancelling: true,
            endsAt: '2026-11-19T20:00:00.000Z',
        });
    });

    it('counts cancel_at_period_end as cancelling, and nothing at all as renewing', () => {
        expect(stripeSub({ cancel_at_period_end: true })).toMatchObject({ cancelling: true });
        expect(stripeSub({})).toMatchObject({ cancelling: false, endsAt: '2026-11-20T20:00:00.000Z' });
    });

    it('is what billing-cancel reads Stripe with', () => {
        const fn = readFileSync(resolve(process.cwd(), 'supabase/functions/billing-cancel/index.ts'), 'utf8');
        expect(fn).toContain('liveSubscriptionOf(sub)');
        expect(fn).not.toMatch(/cancelAt !== null/);
    });
});
