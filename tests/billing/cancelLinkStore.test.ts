// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as billingTerms from '../../supabase/functions/_shared/billingTerms';
import {
    type CancelLinkDeps,
    type CancelLinkRequest,
    deliverCancelLink,
} from '../../supabase/functions/_shared/cancelFlow';
import { resendIdempotencyKey } from '../../supabase/functions/_shared/resendDelivery';
import { FakeResend } from './fakeResend';

/**
 * The cancel link's token lifecycle against the REAL store (Codex round 4 on
 * #62): billingCancelStore.ts and the billing mail worker exactly as they ship,
 * talking to a local Supabase through PostgREST -- the migrations, triggers and
 * RPCs they rely on included. Only Resend (FakeResend), the rate limiter and the
 * error log are stand-ins. cancelFlow.test.ts covers the flow with an in-memory
 * store; this is what holds that store to it.
 *
 * Needs the local stack (`npm run cloud:up`), so it is skipped unless both are
 * set -- CI has no database, like tests/sql:
 *
 *     CLEFFY_LOCAL_SUPABASE_URL=http://127.0.0.1:54421 \
 *     CLEFFY_LOCAL_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from `npx supabase status -o env`> \
 *     npx vitest run tests/billing/cancelLinkStore.test.ts
 *
 * Every row it writes belongs to accounts it creates and deletes again.
 */

const URL = process.env.CLEFFY_LOCAL_SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.CLEFFY_LOCAL_SERVICE_ROLE_KEY ?? '';
const HOUR = 60 * 60_000;

const state = vi.hoisted(() => {
    const env: Record<string, string> = {
        BILLING_CANCEL_SECRET: 'cancel-link-store-test-secret',
        RESEND_API_KEY: 're_test_key',
    };
    (globalThis as { Deno?: unknown }).Deno = { env: { get: (name: string) => env[name] } };
    return { client: null as SupabaseClient | null, limiter: new Map<string, number>(), refunded: [] as string[] };
});

vi.mock('../../supabase/functions/_shared/rateLimit', () => ({
    serviceClient: () => state.client,
    checkRateLimit: async () => ({ ok: true }),
    refundRateLimit: async (key: string) => {
        state.refunded.push(key);
    },
}));
vi.mock('../../supabase/functions/_shared/errorReporting', () => ({ logError: () => undefined }));
vi.mock('../../supabase/functions/_shared/stripe', () => ({ slotForPrice: () => null }));

/**
 * The Deno-wired modules, loaded by a path tsc does not follow: their type-only
 * import of stripe.ts would pull its untyped `npm:stripe` into the typecheck.
 * Typed here by the contract cancelFlow.ts declares for them.
 */
interface Store {
    saveToken: CancelLinkDeps['saveToken'];
    userForEmail: CancelLinkDeps['userForEmail'];
    cancellableSubscription: CancelLinkDeps['cancellableSubscription'];
    cancelLinkToken: CancelLinkDeps['linkToken'];
    sha256Hex: CancelLinkDeps['sha256Hex'];
    cancelSecret: CancelLinkDeps['secret'];
    cancelLinkMailBudget: () => CancelLinkDeps['mailBudget'];
}
const shared = (name: string) => `../../supabase/functions/_shared/${name}`;
const store = (await import(/* @vite-ignore */ shared('billingCancelStore'))) as Store;
const { sendBillingEmail } = (await import(/* @vite-ignore */ shared('billingMail'))) as {
    sendBillingEmail: CancelLinkDeps['sendEmail'];
};
/** billingMailWorker.ts drainBillingMailNow: claim, deliver and settle through the real RPCs. */
const { drainBillingMailNow } = (await import(/* @vite-ignore */ shared('billingMailWorker'))) as {
    drainBillingMailNow: () => Promise<unknown>;
};

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe.skipIf(!URL || !SERVICE_KEY)('the cancel link against the real store', () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    let db: SupabaseClient;
    let resend: FakeResend;
    const users: string[] = [];
    const rows: string[] = [];

    beforeAll(() => {
        db = createClient(URL, SERVICE_KEY, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { fetch: realFetch },
        });
        state.client = db;
    });

    beforeEach(() => {
        resend = new FakeResend();
        state.limiter.clear();
        state.refunded.length = 0;
        globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
            String(input instanceof Request ? input.url : input).startsWith('https://api.resend.com')
                ? resend.fetch(input, init)
                : realFetch(input, init)) as typeof fetch;
    });

    afterEach(async () => {
        globalThis.fetch = realFetch;
        vi.useRealTimers();
        // Park this file's rows, so a later test's drain only meets its own.
        if (rows.length) {
            await db.from('billing_mail_outbox').update({ next_attempt_at: '2999-01-01T00:00:00Z' }).in('id', rows);
        }
    });

    afterAll(async () => {
        if (rows.length) {
            await db.from('billing_mail_outbox').delete().in('id', rows);
        }
        for (const id of users) {
            await db.auth.admin.deleteUser(id);
        }
    });

    const must = <T>(result: { data: T; error: { message: string } | null }, what: string): NonNullable<T> => {
        if (result.error || result.data === null || result.data === undefined) {
            throw new Error(`${what}: ${result.error?.message ?? 'no data'}`);
        }
        return result.data;
    };
    const ok = (result: { error: { message: string } | null }, what: string): void => {
        if (result.error) {
            throw new Error(`${what}: ${result.error.message}`);
        }
    };

    /** A subscriber, and their cancel-link request written down as billing-cancel does. */
    const subscriber = async () => {
        const email = `lc-${randomUUID().slice(0, 8)}@cancel-link-store.test`;
        const created = await db.auth.admin.createUser({ email, email_confirm: true });
        if (created.error || !created.data.user) {
            throw new Error(`create user: ${created.error?.message ?? 'no user'}`);
        }
        const userId = created.data.user.id;
        users.push(userId);
        ok(
            await db.from('subscriptions').insert({
                stripe_subscription_id: `sub_lc_${randomUUID().slice(0, 12)}`,
                user_id: userId,
                tier: 'teacher',
                status: 'active',
                price_id: 'price_teacher_monthly',
                current_period_end: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
                mode: 'test',
            }),
            'insert subscription',
        );
        const request: CancelLinkRequest = { email, origin: 'https://cleffy.io' };
        const rowId = must(
            await db.rpc('enqueue_billing_mail', {
                p_kind: 'cancel_link',
                p_dedupe_key: null,
                p_mode: 'test',
                p_payload: request,
            }),
            'enqueue',
        ) as string;
        rows.push(rowId);
        return { userId, email, request, rowId };
    };

    const outboxRow = async (id: string) => {
        const { data, error } = await db.from('billing_mail_outbox').select('*').eq('id', id).maybeSingle();
        ok({ error }, 'read outbox row');
        return data as Record<string, string | number | null> | null;
    };

    /** Its backoff over and no lease on it: the next drain takes it. */
    const makeDue = async (id: string) =>
        ok(
            await db
                .from('billing_mail_outbox')
                .update({ next_attempt_at: new Date(0).toISOString(), claimed_until: null })
                .eq('id', id),
            'make due',
        );

    /** Leases the row the way claim_billing_mail does for a worker, making it due first. */
    const claim = async (id: string): Promise<{ claimToken: string; linkExpiresAt: string | null }> => {
        await makeDue(id);
        const claimed = must(
            await db.rpc('claim_billing_mail', { p_limit: 50, p_lease: '2 minutes' }),
            'claim',
        ) as Array<{
            id: string;
            claim_token: string;
            link_expires_at?: string | null;
        }>;
        const mine = claimed.find((row) => row.id === id);
        if (!mine) {
            throw new Error(`row ${id} was not claimable`);
        }
        return { claimToken: mine.claim_token, linkExpiresAt: mine.link_expires_at ?? null };
    };

    const tokenRow = async (hash: string) => {
        const { data, error } = await db.from('billing_cancel_tokens').select('*').eq('token_hash', hash).maybeSingle();
        ok({ error }, 'read token');
        return data as { expires_at: string; used_at: string | null; outbox_id?: string | null } | null;
    };

    /** The production deliverer's dependencies: billingMailWorker.ts cancelLinkDeps, Resend faked. */
    const linkDeps = (): CancelLinkDeps => ({
        checkRateLimit: async (key, limit) => {
            const used = (state.limiter.get(key) ?? 0) + 1;
            state.limiter.set(key, used);
            return used > limit ? { ok: false, retryAfterSec: 60 } : { ok: true };
        },
        refundRateLimit: async (key) => {
            state.refunded.push(key);
        },
        mailBudget: store.cancelLinkMailBudget(),
        sha256Hex: store.sha256Hex,
        secret: store.cancelSecret,
        linkToken: store.cancelLinkToken,
        userForEmail: store.userForEmail,
        cancellableSubscription: store.cancellableSubscription,
        saveToken: store.saveToken,
        sendEmail: sendBillingEmail,
        idempotencyKey: resendIdempotencyKey,
        terms: billingTerms,
        now: () => Date.now(),
        logError: () => undefined,
    });

    /** Whether the link would open the cancel page: cancelFlow.ts liveToken's test, on the stored row. */
    const linkWorks = async (hash: string) => {
        const token = await tokenRow(hash);
        return token !== null && token.used_at === null && Date.parse(token.expires_at) > Date.now();
    };

    const hashOf = async (rowId: string) => sha256(await store.cancelLinkToken('cancel-link-store-test-secret', rowId));

    it('two retries at once keep the expiry the link was asked with', async () => {
        const { request, rowId } = await subscriber();
        const createdAt = Date.parse(String((await outboxRow(rowId))?.created_at));
        const asked = createdAt + HOUR;

        // The first attempt: Resend takes it and the answer is lost.
        resend.dropNextAnswer = true;
        const first = await claim(rowId);
        expect(await deliverCancelLink(linkDeps(), 'test', request, rowId, first)).toMatchObject({
            outcome: 'retry',
            uncertain: true,
        });
        const hash = await hashOf(rowId);
        expect(Date.parse(String((await tokenRow(hash))?.expires_at))).toBe(asked);

        // Twenty minutes on, two workers retry the row at once (one lease
        // between them, as a worker whose lease ran out and its successor).
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 20 * 60_000);
        const second = await claim(rowId);
        const outcomes = await Promise.all([
            deliverCancelLink(linkDeps(), 'test', request, rowId, second),
            deliverCancelLink(linkDeps(), 'test', request, rowId, second),
        ]);
        expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['sent', 'sent']);

        const token = await tokenRow(hash);
        expect(Date.parse(String(token?.expires_at))).toBe(asked);
        expect(token?.used_at).toBeNull();
        // One email, and the same one each time.
        expect(resend.delivered).toHaveLength(1);
        expect(new Set(resend.requests.map((r) => r.body)).size).toBe(1);
    });

    it('a retry delayed past the expiry sends nothing, is settled for good, keeps the budget, and the link stays dead', async () => {
        const { rowId } = await subscriber();
        const createdAt = Date.parse(String((await outboxRow(rowId))?.created_at));
        const hash = await hashOf(rowId);

        resend.dropNextAnswer = true;
        await drainBillingMailNow();
        expect(resend.delivered).toHaveLength(1);
        expect(await linkWorks(hash)).toBe(true);

        // The worker comes round to it an hour and a minute after it was asked for.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(createdAt + HOUR + 60_000);
        await makeDue(rowId);
        await drainBillingMailNow();
        expect(resend.requests).toHaveLength(1);
        // The first attempt's outcome is unknown, so what it reserved stays.
        expect(state.refunded.filter((key) => key.startsWith('billing-cancel:global'))).toEqual([]);
        const row = await outboxRow(rowId);
        expect(row).toMatchObject({ status: 'expired', claim_token: null, last_error: 'expired before delivery' });
        expect(row?.payload).not.toHaveProperty('email');

        // Settled for good: made due again, it is still never sent.
        await makeDue(rowId);
        await drainBillingMailNow();
        expect(resend.requests).toHaveLength(1);
        expect(Date.parse(String((await tokenRow(hash))?.expires_at))).toBe(createdAt + HOUR);
        expect(await linkWorks(hash)).toBe(false);
    });
});
