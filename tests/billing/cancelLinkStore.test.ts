// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as billingTerms from '../../supabase/functions/_shared/billingTerms';
import {
    type CancelDeps,
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
 * Needs the local stack (`npm run cloud:up`), so the root `npm run test` skips
 * it unless both are set. CI's supabase-local job boots that stack and runs it
 * with CLEFFY_REQUIRE_LOCAL_DB=1, which turns a missing setting into a failure
 * rather than a silent skip:
 *
 *     CLEFFY_LOCAL_SUPABASE_URL=http://127.0.0.1:54421 \
 *     CLEFFY_LOCAL_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from `npx supabase status -o env`> \
 *     npx vitest run tests/billing/cancelLinkStore.test.ts
 *
 * Every row it writes belongs to accounts it creates and deletes again.
 */

const URL = process.env.CLEFFY_LOCAL_SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.CLEFFY_LOCAL_SERVICE_ROLE_KEY ?? '';
/** Set by CI's supabase-local job: there, a stack that is not configured fails the run. */
const REQUIRED = process.env.CLEFFY_REQUIRE_LOCAL_DB === '1';
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
    consumeToken: CancelDeps['consumeToken'];
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

describe.skipIf(!REQUIRED && (!URL || !SERVICE_KEY))('the cancel link against the real store', () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    let db: SupabaseClient;
    let resend: FakeResend;
    const users: string[] = [];
    const rows: string[] = [];

    beforeAll(() => {
        if (!URL || !SERVICE_KEY) {
            throw new Error(
                'CLEFFY_REQUIRE_LOCAL_DB is set, but CLEFFY_LOCAL_SUPABASE_URL or CLEFFY_LOCAL_SERVICE_ROLE_KEY is not',
            );
        }
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
        logError: () => undefined,
    });

    /**
     * Whether the link would open the cancel page: billing-cancel readToken's
     * question, answered by the database on its own clock (Codex round 6 on #62).
     */
    const linkWorks = async (hash: string) => {
        const { data, error } = await db.rpc('read_cancel_link_token', { p_hash: hash });
        ok({ error }, 'read the link');
        return data !== null;
    };

    /**
     * The database's clock passing the link's hour: the request's expiry, and
     * the saved link's if there is one, brought forward to a minute ago (the
     * one way either may move). Faking the edge function's clock does nothing
     * any more -- neither the send nor the link's expiry is decided on it.
     */
    const expireOnDbClock = async (rowId: string, hash: string) => {
        const past = new Date(Date.now() - 60_000).toISOString();
        ok(
            await db.from('billing_mail_outbox').update({ link_expires_at: past }).eq('id', rowId),
            'expire the request',
        );
        ok(
            await db.from('billing_cancel_tokens').update({ expires_at: past }).eq('token_hash', hash),
            'expire the link',
        );
    };

    const hashOf = async (rowId: string) => sha256(await store.cancelLinkToken('cancel-link-store-test-secret', rowId));

    /** The permanent record of a deleted token (migration 20261020160400). */
    const tombstone = async (hash: string) => {
        const { data, error } = await db
            .from('billing_cancel_token_tombstones')
            .select('*')
            .eq('token_hash', hash)
            .maybeSingle();
        ok({ error }, 'read tombstone');
        return data as { token_hash: string; outbox_id: string | null; deleted_at: string } | null;
    };

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

        // The worker comes round to it after its hour is over, on the
        // database's clock.
        await expireOnDbClock(rowId, hash);
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
        expect(Date.parse(String((await tokenRow(hash))?.expires_at))).toBeLessThanOrEqual(createdAt + HOUR);
        expect(await linkWorks(hash)).toBe(false);
    });

    /**
     * What billing-cancel does when the customer presses "Cancel now":
     * billingCancelStore.ts consumeToken, through consume_cancel_link_token
     * (migration 20261020160700) -- spent only while unused and unexpired on
     * the database's clock.
     */
    const spend = (hash: string) => store.consumeToken(hash);

    it('a link read as good that expires before it is spent is refused, stays unused, and nothing more is mailed (Codex round 7 on #62)', async () => {
        const { rowId } = await subscriber();
        const hash = await hashOf(rowId);
        await drainBillingMailNow();
        expect(resend.delivered).toHaveLength(1);
        // The cancel page reads it as good ...
        expect(await linkWorks(hash)).toBe(true);
        // ... and its hour runs out on the database's clock before the spend.
        ok(
            await db
                .from('billing_cancel_tokens')
                .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
                .eq('token_hash', hash),
            'expire the link',
        );
        expect(await spend(hash)).toBe('expired');
        expect((await tokenRow(hash))?.used_at).toBeNull();
        // Nor can it be spent the way consumeToken used to, directly: the
        // token's guard refuses an expired link.
        const direct = await db
            .from('billing_cancel_tokens')
            .update({ used_at: new Date().toISOString() })
            .eq('token_hash', hash)
            .is('used_at', null)
            .select('token_hash');
        expect(direct.error?.message).toContain('an expired cancel link cannot be spent');
        expect((await tokenRow(hash))?.used_at).toBeNull();
        expect(resend.requests).toHaveLength(1);

        // A link with time left is spent once; then used; and one never
        // issued is not found.
        const other = await subscriber();
        await drainBillingMailNow();
        const otherHash = await hashOf(other.rowId);
        expect(await spend(otherHash)).toBe('consumed');
        expect((await tokenRow(otherHash))?.used_at).not.toBeNull();
        expect(await spend(otherHash)).toBe('used');
        expect(await spend(sha256(randomUUID()))).toBe('not_found');
        expect(resend.requests).toHaveLength(2);
    });

    it('a link sent with its answer lost, used, then retried late and cleaned up, never works again', async () => {
        // Codex round 4, the major on #62, step by step.
        const { rowId, userId } = await subscriber();
        const createdAt = Date.parse(String((await outboxRow(rowId))?.created_at));
        const hash = await hashOf(rowId);

        // Resend accepts the link and the answer is lost: `unknown`, retried.
        resend.dropNextAnswer = true;
        await drainBillingMailNow();
        expect(resend.delivered).toHaveLength(1);
        expect((await outboxRow(rowId))?.status).toBe('pending');

        // The email arrived; the customer uses it.
        expect(await spend(hash)).toBe('consumed');
        expect(await linkWorks(hash)).toBe(false);

        // The row's next turn comes after the link expired, on the
        // database's clock.
        await expireOnDbClock(rowId, hash);
        await makeDue(rowId);
        await drainBillingMailNow();
        expect(resend.requests).toHaveLength(1);
        expect(await linkWorks(hash)).toBe(false);

        // The cleanup runs.
        ok(await db.rpc('billing_mail_outbox_tick'), 'tick');
        expect(await tokenRow(hash)).toBeNull();

        // And the row is retried.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(createdAt + 27 * HOUR);
        await db.from('billing_mail_outbox').update({ status: 'pending' }).eq('id', rowId);
        await makeDue(rowId);
        await drainBillingMailNow();

        // One email ever, and the spent link has not come back.
        expect(resend.delivered).toHaveLength(1);
        expect(await linkWorks(hash)).toBe(false);
        // Nor can anything put it back the way the store used to save it.
        const { error } = await db.from('billing_cancel_tokens').upsert(
            {
                token_hash: hash,
                user_id: userId,
                mode: 'test',
                expires_at: new Date(Date.now() + HOUR).toISOString(),
            },
            { onConflict: 'token_hash' },
        );
        expect(error).not.toBeNull();
        expect(await linkWorks(hash)).toBe(false);
    });

    it('a retry after the link was used keeps it spent, and keeps its expiry', async () => {
        const { rowId, userId } = await subscriber();
        const createdAt = Date.parse(String((await outboxRow(rowId))?.created_at));
        const hash = await hashOf(rowId);

        resend.dropNextAnswer = true;
        await drainBillingMailNow();
        expect(await spend(hash)).toBe('consumed');
        const spent = await tokenRow(hash);

        // Ten minutes on, the retry: Resend answers it from the first request.
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(createdAt + 10 * 60_000);
        await makeDue(rowId);
        await drainBillingMailNow();
        expect(resend.requests).toHaveLength(2);
        expect(resend.delivered).toHaveLength(1);
        expect(await tokenRow(hash)).toEqual(spent);
        expect(Date.parse(String(spent?.expires_at))).toBe(createdAt + HOUR);
        expect(await linkWorks(hash)).toBe(false);

        // And no write can make it unspent, or give it a new hour.
        const unspend = await db.from('billing_cancel_tokens').update({ used_at: null }).eq('token_hash', hash);
        expect(unspend.error).not.toBeNull();
        const resave = await db.from('billing_cancel_tokens').upsert(
            {
                token_hash: hash,
                user_id: userId,
                mode: 'test',
                expires_at: new Date(Date.now() + HOUR).toISOString(),
            },
            { onConflict: 'token_hash' },
        );
        expect(resave.error).not.toBeNull();
        expect(await tokenRow(hash)).toEqual(spent);
    });
    it('a spent link the cleanup deleted is tombstoned: no direct insert and no re-used row id brings it back (Codex round 5 on #62)', async () => {
        const { rowId, userId, request } = await subscriber();
        const hash = await hashOf(rowId);

        // Sent -- the request's row is deleted -- and used.
        await drainBillingMailNow();
        expect(resend.delivered).toHaveLength(1);
        expect(await outboxRow(rowId)).toBeNull();
        expect(await spend(hash)).toBe('consumed');

        // Its hour over, the cleanup deletes it, and keeps its tombstone.
        ok(
            await db
                .from('billing_cancel_tokens')
                .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
                .eq('token_hash', hash),
            'expire the link',
        );
        ok(await db.rpc('billing_mail_outbox_tick'), 'tick');
        expect(await tokenRow(hash)).toBeNull();
        expect(await tombstone(hash)).toMatchObject({ token_hash: hash, outbox_id: rowId });

        // A new pending request from the same subscriber, and the service role
        // inserting the deleted hash against it, unused, with a fresh hour.
        const fresh = must(
            await db.rpc('enqueue_billing_mail', {
                p_kind: 'cancel_link',
                p_dedupe_key: null,
                p_mode: 'test',
                p_payload: request,
            }),
            'enqueue',
        ) as string;
        rows.push(fresh);
        await db.from('billing_mail_outbox').update({ next_attempt_at: '2999-01-01T00:00:00Z' }).eq('id', fresh);
        expect((await outboxRow(fresh))?.status).toBe('pending');
        const direct = await db.from('billing_cancel_tokens').insert({
            token_hash: hash,
            user_id: userId,
            mode: 'test',
            expires_at: new Date(Date.now() + HOUR).toISOString(),
            outbox_id: fresh,
        });
        expect(direct.error).not.toBeNull();
        expect(await tokenRow(hash)).toBeNull();

        // The request re-created under the deleted row's id: the same HMAC,
        // so the same link -- which the save refuses, settling the row.
        ok(
            await db
                .from('billing_mail_outbox')
                .insert({ id: rowId, kind: 'cancel_link', mode: 'test', payload: request }),
            're-create the request',
        );
        await drainBillingMailNow();
        expect(resend.requests).toHaveLength(1);
        expect(await tokenRow(hash)).toBeNull();
        expect(await linkWorks(hash)).toBe(false);
        const row = await outboxRow(rowId);
        expect(row).toMatchObject({
            status: 'expired',
            claim_token: null,
            last_error: 'cancel link already spent or removed',
        });
        expect(row?.payload).not.toHaveProperty('email');
    });

    it("hands back the database's own count of the seconds left, and refuses under 120 (Codex round 5 on #62)", async () => {
        const first = await subscriber();
        const lease = await claim(first.rowId);
        const saved = await store.saveToken({
            hash: await hashOf(first.rowId),
            userId: first.userId,
            outboxId: first.rowId,
            claimToken: lease.claimToken,
        });
        expect(saved.answer).toBe('saved');
        expect(saved.remainingSeconds).toBeGreaterThan(HOUR / 1000 - 120);
        expect(saved.remainingSeconds).toBeLessThanOrEqual(HOUR / 1000);

        // A request with 100 s of its hour left: fewer than a send needs.
        const late = await subscriber();
        const lateLease = await claim(late.rowId);
        ok(
            await db
                .from('billing_mail_outbox')
                .update({ link_expires_at: new Date(Date.now() + 100_000).toISOString() })
                .eq('id', late.rowId),
            'bring the expiry forward',
        );
        const lateHash = await hashOf(late.rowId);
        const refused = await store.saveToken({
            hash: lateHash,
            userId: late.userId,
            outboxId: late.rowId,
            claimToken: lateLease.claimToken,
        });
        expect(refused.answer).toBe('expired');
        expect(refused.remainingSeconds).toBeLessThan(120);
        expect(await tokenRow(lateHash)).toBeNull();
        expect(await outboxRow(late.rowId)).toMatchObject({ status: 'expired', last_error: 'expired before delivery' });
    });

    it('sends, and the link opens, on the database clock alone: an edge clock two hours ahead changes nothing (Codex round 6 on #62)', async () => {
        const { rowId } = await subscriber();
        const hash = await hashOf(rowId);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 2 * HOUR);

        await drainBillingMailNow();
        expect(resend.delivered).toHaveLength(1);
        expect(await outboxRow(rowId)).toBeNull();
        expect(await linkWorks(hash)).toBe(true);

        // Its expiry passing on the database's clock is what ends it -- and a
        // used link is refused whatever its expiry.
        vi.useRealTimers();
        ok(
            await db
                .from('billing_cancel_tokens')
                .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
                .eq('token_hash', hash),
            'expire the link',
        );
        expect(await linkWorks(hash)).toBe(false);
        const other = await subscriber();
        await drainBillingMailNow();
        const otherHash = await hashOf(other.rowId);
        expect(await linkWorks(otherHash)).toBe(true);
        expect(await spend(otherHash)).toBe('consumed');
        expect(await linkWorks(otherHash)).toBe(false);
    });
});
