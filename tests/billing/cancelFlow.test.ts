// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import * as billingTerms from '../../supabase/functions/_shared/billingTerms';
import {
    CANCEL_LINK_TTL_MS,
    handleCancel,
    maskEmail,
    type CancelDeps,
    type CancellableSubscription,
    type StoredCancelToken,
} from '../../supabase/functions/_shared/cancelFlow';

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
    } = {},
) => {
    const tokens = new Map<string, StoredCancelToken>();
    const sent: Array<{ to: string; subject: string; text: string; replyTo?: string }> = [];
    const limiter = new Map<string, number>();
    const refunded: string[] = [];
    const errors: string[] = [];
    let subscription: CancellableSubscription | null =
        options.subscription === undefined
            ? {
                  subscriptionId: 'sub_1',
                  priceId: 'price_teacher_monthly',
                  status: 'active',
                  periodEnd: '2026-11-20T20:00:00.000Z',
                  cancelAtPeriodEnd: false,
              }
            : options.subscription;
    let tokenCount = 0;
    const deps: CancelDeps = {
        json,
        options: () => new Response(null, { status: 204 }),
        clientKey: () => '203.0.113.7',
        checkRateLimit: vi.fn(async (key: string, limit: number) => {
            if (options.limited?.some((prefix) => key.startsWith(prefix))) {
                return { ok: false as const, retryAfterSec: 60 };
            }
            const used = (limiter.get(key) ?? 0) + 1;
            limiter.set(key, used);
            return used > limit ? { ok: false as const, retryAfterSec: 60 } : { ok: true as const };
        }),
        refundRateLimit: vi.fn(async (key: string) => {
            refunded.push(key);
            limiter.set(key, Math.max(0, (limiter.get(key) ?? 0) - 1));
        }),
        mailBudget: { hour: { limit: 10, windowMs: 3_600_000 }, day: { limit: 50, windowMs: DAY } },
        modeForRequest: () => 'live',
        appOrigin: () => 'https://cleffy.io',
        sha256Hex,
        secret: () => 'pepper',
        newToken: () => `token-${++tokenCount}-abcdefghijklmnop`,
        userForEmail: vi.fn(async (email: string) => (email === EMAIL ? USER : null)),
        emailOfUser: async () => EMAIL,
        cancellableSubscription: vi.fn(async () => subscription),
        firstPurchaseAt: async () => (options.firstPurchaseAt === undefined ? NOW - 3 * DAY : options.firstPurchaseAt),
        saveToken: async ({ hash, userId, mode, expiresAt }) => {
            tokens.set(hash, { userId, mode, expiresAt, usedAt: null });
        },
        readToken: async (hash) => tokens.get(hash) ?? null,
        consumeToken: async (hash, nowIso) => {
            const row = tokens.get(hash);
            if (!row || row.usedAt !== null) {
                return false;
            }
            row.usedAt = nowIso;
            return true;
        },
        cancelAtPeriodEnd: vi.fn(async () => {
            if (options.stripeFails) {
                throw new Error('Stripe is down');
            }
            if (subscription) {
                subscription = { ...subscription, cancelAtPeriodEnd: true };
            }
            return { endsAt: '2026-11-20T20:00:00.000Z' };
        }),
        sendEmail: vi.fn(async (to, message, mailOptions) => {
            if (options.sendFails) {
                return 'failed' as const;
            }
            sent.push({ to, subject: message.subject, text: message.text, replyTo: mailOptions.replyTo });
            return 'sent' as const;
        }),
        terms: billingTerms,
        planNameForPrice: (priceId) => (priceId === 'price_teacher_monthly' ? 'Teacher' : null),
        now: () => NOW,
        logError: (code) => errors.push(code),
    };
    return { deps, tokens, sent, refunded, errors };
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
    it('mails a one-time link to an address with a running subscription', async () => {
        const h = harness();

        const response = await handleCancel(post({ action: 'start', email: ' Ada@Example.com ' }), h.deps);

        expect(response.status).toBe(200);
        expect(await body(response)).toEqual({ sent: true });
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]?.to).toBe(EMAIL);
        expect(h.sent[0]?.text).toContain('https://cleffy.io/cancel?token=');
        // Only the hash is stored; the token itself exists only in the email.
        const token = tokenFrom(h.sent[0]?.text ?? '');
        expect([...h.tokens.keys()]).toEqual([await sha256Hex(token)]);
        expect(h.tokens.get(await sha256Hex(token))?.expiresAt).toBe(new Date(NOW + CANCEL_LINK_TTL_MS).toISOString());
    });

    it('answers exactly the same for an address with no account or no subscription, and sends nothing', async () => {
        const stranger = harness();
        const lapsed = harness({ subscription: null });

        const a = await handleCancel(post({ action: 'start', email: 'nobody@example.com' }), stranger.deps);
        const b = await handleCancel(post({ action: 'start', email: EMAIL }), lapsed.deps);

        expect([a.status, b.status]).toEqual([200, 200]);
        expect(await body(a)).toEqual({ sent: true });
        expect(await body(b)).toEqual({ sent: true });
        expect(stranger.sent).toEqual([]);
        expect(lapsed.sent).toEqual([]);
        expect(lapsed.tokens.size).toBe(0);
    });

    it('limits how many links one address can be sent, and still answers the same', async () => {
        const h = harness();
        for (let i = 0; i < 5; i += 1) {
            expect(await body(await handleCancel(post({ action: 'start', email: EMAIL }), h.deps))).toEqual({
                sent: true,
            });
        }
        expect(h.sent).toHaveLength(3);
    });

    it('refuses a caller over the per-IP limit', async () => {
        const h = harness({ limited: ['billing-cancel:start:ip:'] });
        const response = await handleCancel(post({ action: 'start', email: EMAIL }), h.deps);
        expect(response.status).toBe(429);
        expect(h.deps.userForEmail).not.toHaveBeenCalled();
    });

    it('hands the mail budget back when the link could not be sent', async () => {
        const h = harness({ sendFails: true });
        const response = await handleCancel(post({ action: 'start', email: EMAIL }), h.deps);
        expect(response.status).toBe(503);
        expect(h.refunded).toEqual(['billing-cancel:global', 'billing-cancel:global-day']);
    });

    it('rejects something that is not an email address', async () => {
        const h = harness();
        const response = await handleCancel(post({ action: 'start', email: 'not an email' }), h.deps);
        expect(response.status).toBe(400);
        expect(await body(response)).toMatchObject({ code: 'invalid_email' });
    });
});

describe('billing-cancel: using the link', () => {
    const linked = async (options: Parameters<typeof harness>[0] = {}) => {
        const h = harness(options);
        await handleCancel(post({ action: 'start', email: EMAIL }), h.deps);
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

    it('does not call Stripe again for a subscription already set to cancel', async () => {
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
        expect(h.deps.cancelAtPeriodEnd).not.toHaveBeenCalled();
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

    it('is reachable without signing in', () => {
        expect(config).toMatch(/\[functions\.billing-cancel\]\s*\nverify_jwt = false/);
    });
});
