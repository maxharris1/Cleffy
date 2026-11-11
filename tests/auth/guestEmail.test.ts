// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    BODY_MAX_BYTES,
    generateGuestEmailCode,
    GUEST_EMAIL_CODE_TTL_MS,
    GUEST_EMAIL_ERRORS,
    GUEST_EMAIL_LIMITS,
    guestEmailMessage,
    handleGuestEmailConfirm,
    handleGuestEmailStart,
    hashGuestEmailCode,
    isPlausibleGuestEmail,
    recipientRateKey,
    type CaptchaVerdict,
    type CodeCheck,
    type GuestCaller,
    type GuestEmailConfirmDeps,
    type GuestEmailStartDeps,
    GUEST_EMAIL_KEY_OUTBOX,
    guestEmailSendId,
    type GuestSendResult,
} from '../../supabase/functions/_shared/guestEmail';
import { mailLimit } from '../../supabase/functions/_shared/mailBudget';
import { resendIdempotencyKey, sendViaResend } from '../../supabase/functions/_shared/resendDelivery';
import { FakeResend } from '../billing/fakeResend';
import { passwordProblem, passwordProblemMessage } from '../../supabase/functions/_shared/passwordPolicy';
import { readCappedJson } from '../../supabase/functions/_shared/readCappedJson';
import { chunkedJson } from '../security/chunkedBody';
import { CONTROL_BODY_MAX_BYTES, PAYLOAD_TOO_LARGE } from '../../supabase/functions/_shared/readCappedJson';

/**
 * The guest "attach your email" flow, run for real against stubs. The point of
 * it (B4): an address is attached only after a code mailed TO it comes back —
 * the browser used to call updateUser({ email }), which mailer_autoconfirm
 * confirmed on the spot for any address at all.
 */

const SECRET = 'test-guest-email-secret';
const GUEST: GuestCaller = { userId: '0b5e0000-0000-4000-8000-000000000001', isAnonymous: true };
const NOW = 1_760_000_000_000;

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const post = (body: unknown, method = 'POST') =>
    new Request('https://edge.test/functions/v1/guest-email', {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer jwt' },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
    });

const common = (
    calls: string[],
    caller: GuestCaller | Response = GUEST,
    deletion: 'clear' | 'pending' | 'unknown' = 'clear',
) => ({
    json,
    readJson: readCappedJson,
    options: () => new Response('ok'),
    authenticate: vi.fn(async () => {
        calls.push('auth');
        return caller;
    }),
    clientKey: () => '203.0.113.9',
    checkRateLimit: vi.fn(async (key: string) => {
        calls.push(`rate:${key.split(':').slice(0, 2).join(':')}`);
        return { ok: true as const };
    }),
    secret: () => SECRET,
    // account_deletion_pending() for the guest (launch-fix item 16).
    accountDeletionPending: vi.fn(async () => {
        calls.push('deletion');
        return deletion;
    }),
    logError: vi.fn(),
});

/**
 * The project's mail allowance for guest codes, exactly as
 * guest-email-start/index.ts reads it. Passed in rather than restated so these
 * tests exercise the DERIVED ceilings — if mailBudget.ts ever narrows them
 * (because the reserve for password resets grew, or the budget was corrected
 * to the real Resend quota), the ceiling asserted here moves with it.
 */
const MAIL_BUDGET = { hour: mailLimit('guestEmailCode', 'hour'), day: mailLimit('guestEmailCode', 'day') };

const startHarness = (
    options: {
        taken?: boolean | null;
        /** `failed` is a definite rejection (a 4xx); `unknown`, a send Resend may have taken. */
        send?: 'sent' | 'failed' | 'unconfigured' | 'unknown';
        caller?: GuestCaller | Response;
        save?: boolean;
        /** The Turnstile verdict for the request; a configured deploy that passes by default. */
        captcha?: CaptchaVerdict;
        deletion?: 'clear' | 'pending' | 'unknown';
    } = {},
) => {
    const calls: string[] = [];
    const saved: { userId: string; email: string; codeHash: string; expiresAt: string }[] = [];
    const sent: { to: string; subject: string; text: string; idempotencyKey: string }[] = [];
    const results: Record<NonNullable<typeof options.send>, GuestSendResult> = {
        sent: { outcome: 'sent', reason: 'sent' },
        failed: { outcome: 'rejected', reason: 'http_422' },
        unconfigured: { outcome: 'rejected', reason: 'unconfigured' },
        unknown: { outcome: 'unknown', reason: 'network' },
    };
    const deps: GuestEmailStartDeps = {
        ...common(calls, options.caller, options.deletion),
        verifyCaptcha: vi.fn(async (_req: Request, body: Record<string, unknown> | null) => {
            calls.push(`captcha:${typeof body?.['captchaToken'] === 'string' ? 'token' : 'none'}`);
            return options.captcha ?? ({ ok: true, verified: true } satisfies CaptchaVerdict);
        }),
        mailBudget: MAIL_BUDGET,
        emailTaken: vi.fn(async (email: string) => {
            calls.push(`taken:${email}`);
            return options.taken === undefined ? false : options.taken;
        }),
        savePending: vi.fn(async (row) => {
            calls.push('save');
            saved.push(row);
            return options.save ?? true;
        }),
        deletePending: vi.fn(async () => {
            calls.push('delete');
        }),
        sendEmail: vi.fn(async (to, message, idempotencyKey) => {
            calls.push('send');
            sent.push({ to, subject: message.subject, text: message.text, idempotencyKey });
            return results[options.send ?? 'sent'];
        }),
        idempotencyKey: resendIdempotencyKey,
        refundRateLimit: vi.fn(async (key: string) => {
            calls.push(
                `refund:${key.split(':')[0]}${key.startsWith('guest-email-start:') ? `:${key.split(':')[1]}` : ''}`,
            );
        }),
        generateCode: () => '482913',
        now: () => NOW,
    };
    return { deps, calls, saved, sent };
};

describe('guest-email-start', () => {
    it('mails a code to the address and stores only its HMAC, bound to the guest and the address', async () => {
        const h = startHarness();
        const response = await handleGuestEmailStart(
            post({ email: '  Ada@Example.COM ', captchaToken: 'cf-token' }),
            h.deps,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ sent: true, expiresInSec: GUEST_EMAIL_CODE_TTL_MS / 1000 });
        expect(h.sent).toEqual([expect.objectContaining({ to: 'ada@example.com' })]);
        expect(h.sent[0]?.text).toContain('482913');
        expect(h.saved).toEqual([
            {
                userId: GUEST.userId,
                email: 'ada@example.com',
                codeHash: await hashGuestEmailCode(SECRET, GUEST.userId, 'ada@example.com', '482913'),
                expiresAt: new Date(NOW + GUEST_EMAIL_CODE_TTL_MS).toISOString(),
            },
        ]);
        expect(h.saved[0]?.codeHash).not.toContain('482913');
        // IP gate before the auth round-trip; then the guest, the captcha, the
        // lookup, and only for a code about to be mailed, the address's own
        // allowance.
        //
        // The captcha's position is the load-bearing part of this list: after
        // the two free counting gates (so a flood pays a slot before it costs
        // Cloudflare a verification) and before `taken:` — the only question
        // this endpoint answers about somebody else's address — and before the
        // save and the send, which are what cost us.
        expect(h.calls).toEqual([
            'rate:guest-email-start:ip',
            'auth',
            'rate:guest-email-start:user',
            'captcha:token',
            'deletion',
            'taken:ada@example.com',
            'rate:guest-email-to:' + (await recipientRateKey(SECRET, 'ada@example.com')).split(':')[1],
            'rate:guest-email-to-day:' + (await recipientRateKey(SECRET, 'ada@example.com', 'day')).split(':')[1],
            'rate:guest-email-start:global',
            'rate:guest-email-start:global-day',
            'save',
            'send',
        ]);
    });

    it('tells the guest to sign in when the address already has an account, and mails nothing', async () => {
        const h = startHarness({ taken: true });
        const response = await handleGuestEmailStart(post({ email: 'owner@example.com' }), h.deps);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual(GUEST_EMAIL_ERRORS.emailInUse);
        expect(h.sent).toEqual([]);
        expect(h.saved).toEqual([]);
        // Asking about an address with an account spends none of its mail allowance.
        expect(h.calls.filter((call) => call.startsWith('rate:guest-email-to'))).toEqual([]);
    });

    it('refuses a registered account: this path only turns a guest into one', async () => {
        const h = startHarness({ caller: { userId: 'u', isAnonymous: false } });
        const response = await handleGuestEmailStart(post({ email: 'a@example.com' }), h.deps);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual(GUEST_EMAIL_ERRORS.notGuest);
        expect(h.sent).toEqual([]);
    });

    it('passes on the 401 for a request with no session', async () => {
        const h = startHarness({ caller: json({ error: 'Unauthorized' }, 401) });
        expect((await handleGuestEmailStart(post({ email: 'a@example.com' }), h.deps)).status).toBe(401);
        expect(h.sent).toEqual([]);
    });

    it('rejects an address that is not one', async () => {
        const h = startHarness();
        const response = await handleGuestEmailStart(post({ email: 'not-an-address' }), h.deps);
        expect(response.status).toBe(422);
        expect(h.calls).not.toContain('send');
    });

    it('refuses, before mailing anything, every address GoTrue could never attach', async () => {
        // Each of these passed the old shape test, got a code mailed verbatim
        // (Resend reads `Name <address>`), and counted against an allowance
        // of its own spelling.
        for (const email of [
            'a<victim@example.com>',
            '<victim@example.com>',
            '"victim"@example.com',
            'victim@example.com.',
            'josé@example.com',
            'victim@exa_mple.com',
            'victim@-example.com',
            'victim@example..com',
            'victim@localhost',
        ]) {
            const h = startHarness();
            const response = await handleGuestEmailStart(post({ email }), h.deps);
            expect(response.status, email).toBe(422);
            expect(await response.json()).toEqual(GUEST_EMAIL_ERRORS.invalidEmail);
            expect(h.calls, email).not.toContain('save');
            expect(h.sent, email).toEqual([]);
        }
        for (const email of ['ada@example.com', 'ada.l+cleffy@mail.example.co.uk', "o'brien@example.org"]) {
            expect(isPlausibleGuestEmail(email), email).toBe(true);
        }
    });

    it('stops mailing anyone once the project-wide ceiling is reached', async () => {
        expect(MAIL_BUDGET.hour.limit).toBeLessThan(MAIL_BUDGET.day.limit);
        for (const blocked of ['guest-email-start:global', 'guest-email-start:global-day']) {
            const h = startHarness();
            h.deps.checkRateLimit = vi.fn(async (key: string) =>
                key === blocked ? { ok: false as const, retryAfterSec: 900 } : { ok: true as const },
            );
            const response = await handleGuestEmailStart(post({ email: 'a@example.com' }), h.deps);
            expect(response.status, blocked).toBe(503);
            expect(await response.json()).toEqual({ ...GUEST_EMAIL_ERRORS.unavailable, retryAfterSec: 900 });
            expect(h.calls, blocked).not.toContain('save');
            expect(h.sent, blocked).toEqual([]);
            expect(h.deps.logError).toHaveBeenCalled();
        }
    });

    it('mails nothing, and asks nothing about the address, without a verified captcha', async () => {
        const refusals = [
            { verdict: { ok: false, code: 'captcha_missing', status: 400 }, error: GUEST_EMAIL_ERRORS.captchaMissing },
            { verdict: { ok: false, code: 'captcha_failed', status: 403 }, error: GUEST_EMAIL_ERRORS.captchaFailed },
            {
                verdict: { ok: false, code: 'captcha_unavailable', status: 503 },
                error: GUEST_EMAIL_ERRORS.captchaUnavailable,
            },
        ] as const satisfies readonly { verdict: CaptchaVerdict; error: { error: string; code: string } }[];

        for (const { verdict, error } of refusals) {
            const h = startHarness({ captcha: verdict });
            const response = await handleGuestEmailStart(post({ email: 'owner@example.com' }), h.deps);
            expect(response.status, verdict.code).toBe(verdict.status);
            expect(await response.json()).toEqual(error);
            // Nothing past the gate ran: no send, no pending row, and — the
            // one that matters most — the address was never looked up, so a
            // script cannot use this endpoint to find out who has an account.
            expect(h.sent, verdict.code).toEqual([]);
            expect(h.saved, verdict.code).toEqual([]);
            expect(h.deps.emailTaken, verdict.code).not.toHaveBeenCalled();
            // And the counting gates in front of it stay spent: a caller who
            // cannot solve a challenge still pays for trying.
            expect(h.calls.filter((c) => c.startsWith('rate:'))).toEqual([
                'rate:guest-email-start:ip',
                'rate:guest-email-start:user',
            ]);
            expect(h.deps.refundRateLimit, verdict.code).not.toHaveBeenCalled();
        }

        // Each refusal says something different, because "solve it again" and
        // "this is our problem, wait" are different instructions.
        const codes = refusals.map(({ error }) => error.code);
        expect(new Set(codes).size).toBe(codes.length);
    });

    it('a deploy with no TURNSTILE_SECRET_KEY works exactly as it did before', async () => {
        // The inertness guarantee, as the verifier reports it: ok, nothing
        // verified. The request carries no token at all — no browser can mint
        // one without the site key — and it is still answered with a mailed
        // code, which is what lets this branch ship ahead of the keys.
        const h = startHarness({ captcha: { ok: true, verified: false } });
        const response = await handleGuestEmailStart(post({ email: 'ada@example.com' }), h.deps);
        expect(response.status).toBe(200);
        expect(h.sent).toEqual([expect.objectContaining({ to: 'ada@example.com' })]);
        expect(h.calls).toContain('captcha:none');
    });

    it('spends the project mail budget derived from mailBudget.ts, not a literal of its own', async () => {
        // guest-email-start/index.ts passes mailLimit('guestEmailCode', …) in,
        // and the handler counts against exactly those two ceilings. The point
        // is that narrowing the budget there narrows this flow here, with no
        // second number to remember to edit.
        const seen: { key: string; limit: number; windowMs: number }[] = [];
        const h = startHarness();
        h.deps.checkRateLimit = vi.fn(async (key: string, limit: number, windowMs: number) => {
            seen.push({ key, limit, windowMs });
            return { ok: true as const };
        });
        expect((await handleGuestEmailStart(post({ email: 'a@example.com' }), h.deps)).status).toBe(200);

        expect(seen.find((call) => call.key === 'guest-email-start:global')).toEqual({
            key: 'guest-email-start:global',
            ...MAIL_BUDGET.hour,
        });
        expect(seen.find((call) => call.key === 'guest-email-start:global-day')).toEqual({
            key: 'guest-email-start:global-day',
            ...MAIL_BUDGET.day,
        });
    });

    it('withdraws the code when the mail could not be sent', async () => {
        const failed = startHarness({ send: 'failed' });
        expect((await handleGuestEmailStart(post({ email: 'a@example.com' }), failed.deps)).status).toBe(502);
        expect(failed.calls.slice(failed.calls.indexOf('send') + 1)).toContain('delete');

        const unconfigured = startHarness({ send: 'unconfigured' });
        const response = await handleGuestEmailStart(post({ email: 'a@example.com' }), unconfigured.deps);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual(GUEST_EMAIL_ERRORS.unavailable);
    });

    it('hands back the mailbox’s and the project’s allowances when no mail went out', async () => {
        const reserved = [
            'refund:guest-email-to',
            'refund:guest-email-to-day',
            'refund:guest-email-start:global',
            'refund:guest-email-start:global-day',
        ];
        for (const outcome of [{ send: 'unconfigured' as const }, { send: 'failed' as const }, { save: false }]) {
            const h = startHarness(outcome);
            const response = await handleGuestEmailStart(post({ email: 'a+tag@example.com' }), h.deps);
            expect(response.status, JSON.stringify(outcome)).toBeGreaterThanOrEqual(500);
            expect(h.calls.filter((c) => c.startsWith('refund:')).sort(), JSON.stringify(outcome)).toEqual(
                [...reserved].sort(),
            );
            // The attempt limits stay spent: they are what stops a caller
            // hammering a broken mailer.
            expect(h.deps.refundRateLimit).not.toHaveBeenCalledWith(expect.stringMatching(/:ip:|:user:/));
        }

        const mailed = startHarness();
        expect((await handleGuestEmailStart(post({ email: 'a@example.com' }), mailed.deps)).status).toBe(200);
        expect(mailed.deps.refundRateLimit).not.toHaveBeenCalled();
    });

    it('hands back what it had reserved when a later limit refuses', async () => {
        const h = startHarness();
        h.deps.checkRateLimit = vi.fn(async (key: string) => {
            h.calls.push(`rate:${key.split(':').slice(0, 2).join(':')}`);
            return key === 'guest-email-start:global-day'
                ? { ok: false as const, retryAfterSec: 900 }
                : { ok: true as const };
        });
        expect((await handleGuestEmailStart(post({ email: 'a@example.com' }), h.deps)).status).toBe(503);
        expect(h.calls.filter((c) => c.startsWith('refund:')).sort()).toEqual(
            ['refund:guest-email-to', 'refund:guest-email-to-day', 'refund:guest-email-start:global'].sort(),
        );
    });

    it('a mail outage does not use up a mailbox: its allowance counts mail that went out', async () => {
        // The buckets, as check_edge_rate_limit and refund_edge_rate_limit keep them.
        const counts = new Map<string, number>();
        const checkRateLimit = vi.fn(async (key: string, limit: number) => {
            const n = counts.get(key) ?? 0;
            if (n >= limit) {
                return { ok: false as const, retryAfterSec: 60 };
            }
            counts.set(key, n + 1);
            return { ok: true as const };
        });
        const refundRateLimit = vi.fn(async (key: string) => {
            counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
        });
        const attempt = async (send: 'sent' | 'failed' | 'unconfigured', guest: number) => {
            const h = startHarness({ send, caller: { userId: `guest-${guest}`, isAnonymous: true } });
            h.deps.checkRateLimit = checkRateLimit;
            h.deps.refundRateLimit = refundRateLimit;
            return (await handleGuestEmailStart(post({ email: 'ada@example.com' }), h.deps)).status;
        };

        // Resend down: five guests in a row get nothing mailed...
        for (let guest = 0; guest < 5; guest += 1) {
            expect(await attempt(guest % 2 ? 'failed' : 'unconfigured', guest)).toBeGreaterThanOrEqual(500);
        }
        // ...and the mailbox still has its whole hour once it is back.
        for (let guest = 5; guest < 5 + GUEST_EMAIL_LIMITS.startPerRecipient.limit; guest += 1) {
            expect(await attempt('sent', guest)).toBe(200);
        }
        expect(await attempt('sent', 99)).toBe(429);
        expect(counts.get('guest-email-start:global')).toBe(GUEST_EMAIL_LIMITS.startPerRecipient.limit);
    });

    describe('a send Resend may have taken (the outbox contract, resendDelivery.ts)', () => {
        it('KEEPS every reservation and the code, and still tells the guest it did not go', async () => {
            const h = startHarness({ send: 'unknown' });
            const response = await handleGuestEmailStart(post({ email: 'a@example.com' }), h.deps);
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual(GUEST_EMAIL_ERRORS.sendFailed);
            // Nothing handed back: the mail may be out, so it counts against
            // the mailbox and the project's 60/300.
            expect(h.deps.refundRateLimit).not.toHaveBeenCalled();
            // And the code it may have carried still works.
            expect(h.deps.deletePending).not.toHaveBeenCalled();
            expect(h.deps.logError).toHaveBeenCalledWith('guest-email-start: send outcome unknown (network)');
        });

        it('refunds only on a definite rejection', async () => {
            for (const send of ['failed', 'unconfigured'] as const) {
                const h = startHarness({ send });
                await handleGuestEmailStart(post({ email: 'a@example.com' }), h.deps);
                expect(
                    h.calls.filter((c) => c.startsWith('refund:')),
                    send,
                ).toHaveLength(4);
                expect(h.deps.deletePending, send).toHaveBeenCalled();
            }
        });

        it('accepted, then the connection dropped: the reservations stay spent', async () => {
            const resend = new FakeResend();
            const counts = new Map<string, number>();
            const h = startHarness();
            h.deps.checkRateLimit = async (key, limit) => {
                const n = counts.get(key) ?? 0;
                if (n >= limit) {
                    return { ok: false, retryAfterSec: 60 };
                }
                counts.set(key, n + 1);
                return { ok: true };
            };
            h.deps.refundRateLimit = vi.fn(async (key: string) => {
                counts.set(key, Math.max(0, (counts.get(key) ?? 0) - 1));
            });
            // guestEmailWiring.ts sendEmail, minus Deno.env.
            h.deps.sendEmail = (to, message, idempotencyKey) =>
                sendViaResend({
                    apiKey: 're_test_key',
                    idempotencyKey,
                    email: { from: 'Cleffy <noreply@cleffy.io>', to: [to], ...message },
                    fetch: resend.fetch,
                });

            resend.dropNextAnswer = true;
            expect((await handleGuestEmailStart(post({ email: 'ada@example.com' }), h.deps)).status).toBe(502);
            expect(resend.delivered).toHaveLength(1);
            expect(h.deps.refundRateLimit).not.toHaveBeenCalled();
            expect(counts.get('guest-email-start:global')).toBe(1);
            expect(counts.get('guest-email-start:global-day')).toBe(1);
            expect(counts.get(await recipientRateKey(SECRET, 'ada@example.com'))).toBe(1);
            // Sent under this code's key, which carries no address.
            expect(resend.requests[0]?.key).toBe(
                resendIdempotencyKey(
                    GUEST_EMAIL_KEY_OUTBOX,
                    await guestEmailSendId(
                        SECRET,
                        GUEST.userId,
                        await hashGuestEmailCode(SECRET, GUEST.userId, 'ada@example.com', '482913'),
                    ),
                ),
            );
            expect(resend.requests[0]?.key).not.toMatch(/ada|example|482913/);
        });

        it('is wired through the shared helper, with the key handed in', () => {
            const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
            const wiring = read('supabase/functions/_shared/guestEmailWiring.ts');
            expect(wiring).toContain('sendViaResend({');
            expect(wiring).not.toMatch(/\bfetch\(/);
            expect(read('supabase/functions/guest-email-start/index.ts')).toContain(
                'idempotencyKey: resendIdempotencyKey',
            );
        });

        it('keys each code send stably: the same for this code, different for any other code or guest', async () => {
            const hash = (user: string, code: string) => hashGuestEmailCode(SECRET, user, 'ada@example.com', code);
            const id = async (user: string, code: string) => guestEmailSendId(SECRET, user, await hash(user, code));
            expect(await id('guest-1', '111111')).toBe(await id('guest-1', '111111'));
            expect(await id('guest-1', '111111')).not.toBe(await id('guest-1', '222222'));
            expect(await id('guest-1', '111111')).not.toBe(await id('guest-2', '111111'));
            // Not the stored hash either.
            expect(await hash('guest-1', '111111')).not.toContain(await id('guest-1', '111111'));

            const h = startHarness();
            await handleGuestEmailStart(post({ email: 'ada@example.com' }), h.deps);
            await handleGuestEmailStart(post({ email: 'ada@example.com' }), h.deps);
            h.deps.generateCode = () => '000111';
            await handleGuestEmailStart(post({ email: 'ada@example.com' }), h.deps);
            const keys = h.sent.map((mail) => mail.idempotencyKey);
            expect(keys[0]).toMatch(/^guest-email-code-[0-9a-f]{40}$/);
            expect(keys[1]).toBe(keys[0]);
            expect(keys[2]).not.toBe(keys[0]);
        });
    });

    it('fails closed when the account lookup cannot answer', async () => {
        const h = startHarness({ taken: null });
        expect((await handleGuestEmailStart(post({ email: 'a@example.com' }), h.deps)).status).toBe(503);
        expect(h.sent).toEqual([]);
    });

    it('refuses a guest whose account is being deleted: nothing saved, mailed or asked about the address', async () => {
        const h = startHarness({ deletion: 'pending' });
        const response = await handleGuestEmailStart(post({ email: 'ada@example.com' }), h.deps);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual(GUEST_EMAIL_ERRORS.accountDeletionPending);
        expect(GUEST_EMAIL_ERRORS.accountDeletionPending.code).toBe('account_deletion_pending');
        expect(h.deps.accountDeletionPending).toHaveBeenCalledWith(GUEST.userId);
        expect(h.saved).toEqual([]);
        expect(h.sent).toEqual([]);
        expect(h.calls).not.toContain('taken:ada@example.com');
        expect(h.calls.filter((call) => call.startsWith('rate:guest-email-to'))).toEqual([]);
    });

    it('refuses with a retry when that check cannot be answered (launch-fix item 16)', async () => {
        const h = startHarness({ deletion: 'unknown' });
        const response = await handleGuestEmailStart(post({ email: 'ada@example.com' }), h.deps);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual(GUEST_EMAIL_ERRORS.deletionCheckUnavailable);
        expect(h.saved).toEqual([]);
        expect(h.sent).toEqual([]);
    });

    it('limits per IP, per guest and per recipient address, hourly and daily', async () => {
        for (const blocked of [
            'guest-email-start:ip',
            'guest-email-start:user',
            'guest-email-to:',
            'guest-email-to-day:',
        ]) {
            const h = startHarness();
            h.deps.checkRateLimit = vi.fn(async (key: string) =>
                key.startsWith(blocked) ? { ok: false as const, retryAfterSec: 600 } : { ok: true as const },
            );
            const response = await handleGuestEmailStart(post({ email: 'a@example.com' }), h.deps);
            expect(response.status, blocked).toBe(429);
            expect(await response.json()).toMatchObject({ code: 'rate_limited', retryAfterSec: 600 });
            expect(h.sent, blocked).toEqual([]);
        }
        expect(GUEST_EMAIL_LIMITS.startPerRecipient.limit).toBeLessThanOrEqual(3);
        // Codes mailed to one address a day x tries per code: the most a stranger can guess.
        expect(GUEST_EMAIL_LIMITS.startPerRecipientDaily.limit * 5).toBeLessThanOrEqual(50);
    });
});

const confirmHarness = (
    options: {
        check?: CodeCheck | null;
        attach?: 'ok' | 'email_taken' | 'weak_password' | 'invalid_email' | 'failed';
        caller?: GuestCaller | Response;
        /** guest_email_taken's answers, one per call (the last one repeats). */
        taken?: (boolean | null)[];
        deletion?: 'clear' | 'pending' | 'unknown';
    } = {},
) => {
    const calls: string[] = [];
    const checked: { userId: string; email: string; codeHash: string }[] = [];
    const attached: { userId: string; email: string; password: string }[] = [];
    const deps: GuestEmailConfirmDeps = {
        ...common(calls, options.caller, options.deletion),
        password: { passwordProblem, passwordProblemMessage },
        emailTaken: vi.fn(async (email: string) => {
            calls.push(`taken:${email}`);
            const answers = options.taken ?? [false];
            return answers.length > 1 ? (answers.shift() ?? false) : (answers[0] ?? false);
        }),
        checkCode: vi.fn(async (userId, email, codeHash) => {
            calls.push('check');
            checked.push({ userId, email, codeHash });
            return options.check === undefined ? 'ok' : options.check;
        }),
        attach: vi.fn(async (userId, email, password) => {
            calls.push('attach');
            attached.push({ userId, email, password });
            return options.attach ?? 'ok';
        }),
        deletePending: vi.fn(async () => {
            calls.push('delete');
        }),
    };
    return { deps, calls, checked, attached };
};

const goodConfirm = { email: 'Ada@Example.com', code: '482 913', password: 'Correct1horse ' };

describe('guest-email-confirm', () => {
    it('attaches the email and password only after the code matches, then clears the pending code', async () => {
        const h = confirmHarness();
        const response = await handleGuestEmailConfirm(post(goodConfirm), h.deps);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, email: 'ada@example.com' });
        expect(h.checked).toEqual([
            {
                userId: GUEST.userId,
                email: 'ada@example.com',
                codeHash: await hashGuestEmailCode(SECRET, GUEST.userId, 'ada@example.com', '482913'),
            },
        ]);
        // The password exactly as typed — trailing space included.
        expect(h.attached).toEqual([{ userId: GUEST.userId, email: 'ada@example.com', password: 'Correct1horse ' }]);
        expect(h.calls.slice(-4)).toEqual(['check', 'taken:ada@example.com', 'attach', 'delete']);
    });

    it('attaches nothing for a wrong, expired, used-up or missing code', async () => {
        const cases: [CodeCheck, number, object][] = [
            ['mismatch', 400, GUEST_EMAIL_ERRORS.invalidCode],
            ['locked', 410, GUEST_EMAIL_ERRORS.codeLocked],
            ['expired', 410, GUEST_EMAIL_ERRORS.codeExpired],
            ['missing', 410, GUEST_EMAIL_ERRORS.codeExpired],
        ];
        for (const [check, status, body] of cases) {
            const h = confirmHarness({ check });
            const response = await handleGuestEmailConfirm(post(goodConfirm), h.deps);
            expect(response.status, check).toBe(status);
            expect(await response.json()).toEqual(body);
            expect(h.attached, check).toEqual([]);
        }
        const failed = confirmHarness({ check: null });
        expect((await handleGuestEmailConfirm(post(goodConfirm), failed.deps)).status).toBe(503);
        expect(failed.attached).toEqual([]);
    });

    it('refuses a guest whose account is being deleted before the code is tried: nothing attached', async () => {
        const h = confirmHarness({ deletion: 'pending' });
        const response = await handleGuestEmailConfirm(post(goodConfirm), h.deps);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual(GUEST_EMAIL_ERRORS.accountDeletionPending);
        expect(h.calls).not.toContain('check');
        expect(h.attached).toEqual([]);
        // The pending code is left alone: usable again if the deletion is abandoned.
        expect(h.calls).not.toContain('delete');

        const unknown = confirmHarness({ deletion: 'unknown' });
        const failed = await handleGuestEmailConfirm(post(goodConfirm), unknown.deps);
        expect(failed.status).toBe(503);
        expect(await failed.json()).toEqual(GUEST_EMAIL_ERRORS.deletionCheckUnavailable);
        expect(unknown.attached).toEqual([]);
    });

    it('checks the password before the code, so a weak one does not spend a try', async () => {
        const h = confirmHarness();
        const response = await handleGuestEmailConfirm(post({ ...goodConfirm, password: 'short' }), h.deps);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: 'weak_password' });
        expect(h.calls).not.toContain('check');
    });

    it('does not consult the database for a code that cannot be one', async () => {
        const h = confirmHarness();
        expect((await handleGuestEmailConfirm(post({ ...goodConfirm, code: '12ab' }), h.deps)).status).toBe(400);
        expect(h.calls).not.toContain('check');
    });

    it('says sign in instead when the address was registered in the meantime', async () => {
        // Seen before the attach: nothing is attempted, and the code is withdrawn.
        const before = confirmHarness({ taken: [true] });
        const response = await handleGuestEmailConfirm(post(goodConfirm), before.deps);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual(GUEST_EMAIL_ERRORS.emailInUse);
        expect(before.attached).toEqual([]);
        expect(before.calls).toContain('delete');

        // Registered between the check and the attach. GoTrue's admin update has
        // no duplicate check: the unique index answers, as a generic failure.
        const during = confirmHarness({ attach: 'failed', taken: [false, true] });
        const raced = await handleGuestEmailConfirm(post(goodConfirm), during.deps);
        expect(raced.status).toBe(409);
        expect(await raced.json()).toEqual(GUEST_EMAIL_ERRORS.emailInUse);
        expect(during.calls.slice(-3)).toEqual(['attach', 'taken:ada@example.com', 'delete']);

        const reported = confirmHarness({ attach: 'email_taken' });
        expect((await handleGuestEmailConfirm(post(goodConfirm), reported.deps)).status).toBe(409);
        expect(reported.calls).toContain('delete');
    });

    it('withdraws the code when GoTrue refuses the address itself, rather than failing every retry', async () => {
        const h = confirmHarness({ attach: 'invalid_email' });
        const response = await handleGuestEmailConfirm(post(goodConfirm), h.deps);
        expect(response.status).toBe(422);
        expect(await response.json()).toEqual(GUEST_EMAIL_ERRORS.invalidEmail);
        expect(h.calls.slice(-2)).toEqual(['attach', 'delete']);

        // One GoTrue would refuse is not even checked against its code.
        const early = confirmHarness();
        const refused = await handleGuestEmailConfirm(post({ ...goodConfirm, email: 'josé@example.com' }), early.deps);
        expect(refused.status).toBe(422);
        expect(early.calls).not.toContain('check');
        expect(early.attached).toEqual([]);
    });

    it('keeps the code for a retry when the attach fails for another reason', async () => {
        const h = confirmHarness({ attach: 'failed' });
        expect((await handleGuestEmailConfirm(post(goodConfirm), h.deps)).status).toBe(502);
        expect(h.calls).not.toContain('delete');

        // An account lookup that cannot answer does not stand in the way.
        const unknown = confirmHarness({ taken: [null] });
        expect((await handleGuestEmailConfirm(post(goodConfirm), unknown.deps)).status).toBe(200);
    });

    it('refuses registered accounts and limits per IP and per guest', async () => {
        const registered = confirmHarness({ caller: { userId: 'u', isAnonymous: false } });
        expect((await handleGuestEmailConfirm(post(goodConfirm), registered.deps)).status).toBe(403);
        expect(registered.attached).toEqual([]);

        for (const blocked of ['guest-email-confirm:ip', 'guest-email-confirm:user']) {
            const h = confirmHarness();
            h.deps.checkRateLimit = vi.fn(async (key: string) =>
                key.startsWith(blocked) ? { ok: false as const, retryAfterSec: 30 } : { ok: true as const },
            );
            expect((await handleGuestEmailConfirm(post(goodConfirm), h.deps)).status, blocked).toBe(429);
            expect(h.attached).toEqual([]);
        }
    });
});

describe('guest email helpers', () => {
    it('codes are six digits, and differ', () => {
        const codes = new Set(Array.from({ length: 50 }, () => generateGuestEmailCode()));
        for (const code of codes) {
            expect(code).toMatch(/^\d{6}$/);
        }
        expect(codes.size).toBeGreaterThan(40);
    });

    it('a code hash is bound to the guest and the address', async () => {
        const base = await hashGuestEmailCode(SECRET, 'u1', 'a@example.com', '123456');
        expect(await hashGuestEmailCode(SECRET, 'u2', 'a@example.com', '123456')).not.toBe(base);
        expect(await hashGuestEmailCode(SECRET, 'u1', 'b@example.com', '123456')).not.toBe(base);
        expect(await hashGuestEmailCode('other', 'u1', 'a@example.com', '123456')).not.toBe(base);
    });

    it('counts mail to a mailbox however its address is tagged', async () => {
        const key = await recipientRateKey(SECRET, 'victim@example.com');
        expect(await recipientRateKey(SECRET, 'victim+1@example.com')).toBe(key);
        expect(await recipientRateKey(SECRET, 'victim+cleffy-2@example.com', 'day')).toBe(
            await recipientRateKey(SECRET, 'victim@example.com', 'day'),
        );
        expect(await recipientRateKey(SECRET, 'victim2@example.com')).not.toBe(key);
        expect(await recipientRateKey(SECRET, 'victim@example.org')).not.toBe(key);
    });

    it('the recipient rate keys never contain the address, and each window has its own', async () => {
        const key = await recipientRateKey(SECRET, 'ada@example.com');
        const daily = await recipientRateKey(SECRET, 'ada@example.com', 'day');
        expect(key).not.toContain('ada');
        expect(daily).not.toContain('ada');
        expect(daily).not.toBe(key);
        expect(key.length).toBeLessThanOrEqual(200);
    });

    it('the email names the code and what ignoring it means', () => {
        const message = guestEmailMessage('482913');
        expect(message.subject).toContain('482913');
        expect(message.text).toMatch(/ignore this email/);
        expect(message.html).toContain('482913');
    });
});

describe('the browser no longer attaches an email itself', () => {
    it('no client code calls updateUser with an email', () => {
        const sources = readdirSync(resolve(process.cwd(), 'src'), { recursive: true, encoding: 'utf8' }).filter(
            (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
        );
        expect(sources.length).toBeGreaterThan(50);
        for (const path of sources) {
            const source = readFileSync(resolve(process.cwd(), 'src', path), 'utf8');
            expect(source, path).not.toMatch(/updateUser\s*\(\s*\{[^}]*\bemail\b/);
        }
        const banner = readFileSync(resolve(process.cwd(), 'src/features/auth/UpgradeBanner.tsx'), 'utf8');
        expect(banner).toMatch(/startGuestEmailUpgrade/);
    });

    it('the server refuses an unproven address however it arrives (PUT /auth/v1/user included)', () => {
        const migration = readFileSync(
            resolve(process.cwd(), 'supabase/migrations/20261010120200_guest_email_verification.sql'),
            'utf8',
        );
        expect(migration).toMatch(
            /create trigger guard_guest_email\s+before update of email, is_anonymous on auth\.users/,
        );
        // The new code's upsert clears any earlier proof (the trigger reads verified_email).
        const start = readFileSync(resolve(process.cwd(), 'supabase/functions/guest-email-start/index.ts'), 'utf8');
        expect(start).toMatch(/verified_email: null/);
        expect(start).toMatch(/verified_at: null/);
    });

    it('both functions are declared, JWT required', () => {
        const config = readFileSync(resolve(process.cwd(), 'supabase/config.toml'), 'utf8');
        expect(config).toMatch(/\[functions\.guest-email-start\]\s*\nverify_jwt = true/);
        expect(config).toMatch(/\[functions\.guest-email-confirm\]\s*\nverify_jwt = true/);
    });
});

describe('guest email body cap', () => {
    it('guest-email-start answers 413 to a chunked body past the control cap and mails nothing', async () => {
        expect(BODY_MAX_BYTES).toBe(CONTROL_BODY_MAX_BYTES);
        const h = startHarness();
        const response = await handleGuestEmailStart(
            chunkedJson({ email: 'a@example.com' }, BODY_MAX_BYTES + 1, { headers: { Authorization: 'Bearer jwt' } }),
            h.deps,
        );
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual(PAYLOAD_TOO_LARGE);
        expect(h.sent).toHaveLength(0);
    });

    it('guest-email-confirm answers 413 the same way', async () => {
        const h = confirmHarness();
        const response = await handleGuestEmailConfirm(
            chunkedJson({ email: 'a@example.com', code: '123456' }, BODY_MAX_BYTES + 1, {
                headers: { Authorization: 'Bearer jwt' },
            }),
            h.deps,
        );
        expect(response.status).toBe(413);
    });
});
