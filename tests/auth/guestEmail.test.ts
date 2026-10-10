// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
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
    type CodeCheck,
    type GuestCaller,
    type GuestEmailConfirmDeps,
    type GuestEmailStartDeps,
} from '../../supabase/functions/_shared/guestEmail';
import { passwordProblem, passwordProblemMessage } from '../../supabase/functions/_shared/passwordPolicy';

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

const common = (calls: string[], caller: GuestCaller | Response = GUEST) => ({
    json,
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
    logError: vi.fn(),
});

const startHarness = (
    options: {
        taken?: boolean | null;
        send?: 'sent' | 'failed' | 'unconfigured';
        caller?: GuestCaller | Response;
    } = {},
) => {
    const calls: string[] = [];
    const saved: { userId: string; email: string; codeHash: string; expiresAt: string }[] = [];
    const sent: { to: string; subject: string; text: string }[] = [];
    const deps: GuestEmailStartDeps = {
        ...common(calls, options.caller),
        emailTaken: vi.fn(async (email: string) => {
            calls.push(`taken:${email}`);
            return options.taken === undefined ? false : options.taken;
        }),
        savePending: vi.fn(async (row) => {
            calls.push('save');
            saved.push(row);
            return true;
        }),
        deletePending: vi.fn(async () => {
            calls.push('delete');
        }),
        sendEmail: vi.fn(async (to, message) => {
            calls.push('send');
            sent.push({ to, subject: message.subject, text: message.text });
            return options.send ?? 'sent';
        }),
        generateCode: () => '482913',
        now: () => NOW,
    };
    return { deps, calls, saved, sent };
};

describe('guest-email-start', () => {
    it('mails a code to the address and stores only its HMAC, bound to the guest and the address', async () => {
        const h = startHarness();
        const response = await handleGuestEmailStart(post({ email: '  Ada@Example.COM ' }), h.deps);

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
        // IP gate before the auth round-trip; then the guest, the lookup, and
        // only for a code about to be mailed, the address's own allowance.
        expect(h.calls).toEqual([
            'rate:guest-email-start:ip',
            'auth',
            'rate:guest-email-start:user',
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
        expect(GUEST_EMAIL_LIMITS.startGlobal.limit).toBeLessThan(GUEST_EMAIL_LIMITS.startGlobalDaily.limit);
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

    it('withdraws the code when the mail could not be sent', async () => {
        const failed = startHarness({ send: 'failed' });
        expect((await handleGuestEmailStart(post({ email: 'a@example.com' }), failed.deps)).status).toBe(502);
        expect(failed.calls.slice(-2)).toEqual(['send', 'delete']);

        const unconfigured = startHarness({ send: 'unconfigured' });
        const response = await handleGuestEmailStart(post({ email: 'a@example.com' }), unconfigured.deps);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual(GUEST_EMAIL_ERRORS.unavailable);
    });

    it('fails closed when the account lookup cannot answer', async () => {
        const h = startHarness({ taken: null });
        expect((await handleGuestEmailStart(post({ email: 'a@example.com' }), h.deps)).status).toBe(503);
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
    } = {},
) => {
    const calls: string[] = [];
    const checked: { userId: string; email: string; codeHash: string }[] = [];
    const attached: { userId: string; email: string; password: string }[] = [];
    const deps: GuestEmailConfirmDeps = {
        ...common(calls, options.caller),
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
