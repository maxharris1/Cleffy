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
        // IP gate before the auth round-trip; then the guest, the address, the lookup.
        expect(h.calls).toEqual([
            'rate:guest-email-start:ip',
            'auth',
            'rate:guest-email-start:user',
            'rate:guest-email-to:' + (await recipientRateKey(SECRET, 'ada@example.com')).split(':')[1],
            'taken:ada@example.com',
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

    it('limits per IP, per guest and per recipient address', async () => {
        for (const blocked of ['guest-email-start:ip', 'guest-email-start:user', 'guest-email-to']) {
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
    });
});

const confirmHarness = (
    options: {
        check?: CodeCheck | null;
        attach?: 'ok' | 'email_taken' | 'weak_password' | 'failed';
        caller?: GuestCaller | Response;
    } = {},
) => {
    const calls: string[] = [];
    const checked: { userId: string; email: string; codeHash: string }[] = [];
    const attached: { userId: string; email: string; password: string }[] = [];
    const deps: GuestEmailConfirmDeps = {
        ...common(calls, options.caller),
        password: { passwordProblem, passwordProblemMessage },
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
        expect(h.calls.slice(-3)).toEqual(['check', 'attach', 'delete']);
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
        const h = confirmHarness({ attach: 'email_taken' });
        const response = await handleGuestEmailConfirm(post(goodConfirm), h.deps);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual(GUEST_EMAIL_ERRORS.emailInUse);
    });

    it('keeps the code for a retry when the attach fails', async () => {
        const h = confirmHarness({ attach: 'failed' });
        expect((await handleGuestEmailConfirm(post(goodConfirm), h.deps)).status).toBe(502);
        expect(h.calls).not.toContain('delete');
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

    it('the recipient rate key never contains the address', async () => {
        const key = await recipientRateKey(SECRET, 'ada@example.com');
        expect(key).not.toContain('ada');
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

    it('both functions are declared, JWT required', () => {
        const config = readFileSync(resolve(process.cwd(), 'supabase/config.toml'), 'utf8');
        expect(config).toMatch(/\[functions\.guest-email-start\]\s*\nverify_jwt = true/);
        expect(config).toMatch(/\[functions\.guest-email-confirm\]\s*\nverify_jwt = true/);
    });
});
