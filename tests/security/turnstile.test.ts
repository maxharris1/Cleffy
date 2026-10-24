// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { GUEST_EMAIL_ERRORS, type CaptchaVerdict } from '../../supabase/functions/_shared/guestEmail';
import {
    readSiteverify,
    siteverifyBody,
    TURNSTILE_CODES,
    TURNSTILE_SITEVERIFY_URL,
    TURNSTILE_STATUS,
    TURNSTILE_TOKEN_MAX,
    turnstileTokenIn,
    verifyTurnstile,
    type TurnstileDeps,
    type TurnstileVerdict,
} from '../../supabase/functions/_shared/turnstile';

/**
 * The Turnstile gate, run for real against stubs.
 *
 * WHAT THESE TESTS DO NOT PROVE, said plainly because it matters: nothing here
 * solves a real challenge or talks to Cloudflare. `siteverify` is a stub, so
 * what is tested is the decision logic — which answers admit, which refuse,
 * what each refusal tells the browser, and above all that nothing admits
 * without a `success: true` from Cloudflare. Whether a real widget hands back a
 * token a real siteverify accepts is only provable with live keys against a
 * real hostname, and is the one part of this that has to be checked by hand
 * once the keys are set.
 */

const SECRET = '1x0000000000000000000000000000000AA';

const deps = (
    answer: unknown,
    options: { secret?: string | null; ip?: string | null } = {},
): TurnstileDeps & { seen: URLSearchParams[] } => {
    const seen: URLSearchParams[] = [];
    return {
        seen,
        secretKey: () => (options.secret === undefined ? SECRET : options.secret),
        remoteIp: () => (options.ip === undefined ? '203.0.113.9' : options.ip),
        siteverify: vi.fn(async (body: URLSearchParams) => {
            seen.push(body);
            if (answer instanceof Error) {
                throw answer;
            }
            return answer;
        }),
        logError: vi.fn(),
    };
};

describe('turnstile token reading', () => {
    it('takes `captchaToken`, trimmed, and nothing else', () => {
        expect(turnstileTokenIn({ captchaToken: '  abc.def  ' })).toBe('abc.def');
        expect(turnstileTokenIn({ captchaToken: '' })).toBeNull();
        expect(turnstileTokenIn({ captchaToken: '   ' })).toBeNull();
        expect(turnstileTokenIn({ captchaToken: 42 })).toBeNull();
        expect(turnstileTokenIn({ token: 'abc' })).toBeNull();
        expect(turnstileTokenIn(null)).toBeNull();
        expect(turnstileTokenIn(undefined)).toBeNull();
        expect(turnstileTokenIn('abc')).toBeNull();
    });

    it('refuses a token longer than Cloudflare issues rather than forwarding it', () => {
        // This endpoint is reachable by anyone and siteverify is an outbound
        // request: without the cap, a caller gets to size it.
        expect(turnstileTokenIn({ captchaToken: 'a'.repeat(TURNSTILE_TOKEN_MAX) })).toHaveLength(TURNSTILE_TOKEN_MAX);
        expect(turnstileTokenIn({ captchaToken: 'a'.repeat(TURNSTILE_TOKEN_MAX + 1) })).toBeNull();
    });
});

describe('reading a siteverify answer', () => {
    it('admits only an explicit success', () => {
        expect(readSiteverify({ success: true })).toBe('verified');
        // Not truthiness: a string, a 1, or a missing field are not a yes.
        for (const payload of [{ success: 'true' }, { success: 1 }, {}, { success: false }]) {
            expect(readSiteverify(payload), JSON.stringify(payload)).not.toBe('verified');
        }
    });

    it('blames the token only for faults that are the token’s', () => {
        for (const code of ['missing-input-response', 'invalid-input-response', 'timeout-or-duplicate']) {
            expect(readSiteverify({ success: false, 'error-codes': [code] }), code).toBe('failed');
        }
    });

    it('calls a fault in our own configuration unavailable, not a failed challenge', () => {
        // Telling a user to re-solve a challenge that cannot pass until a
        // secret is fixed is a loop with no exit — and the 503 is what shows
        // up in the logs as ours rather than theirs.
        for (const code of ['missing-input-secret', 'invalid-input-secret', 'bad-request', 'internal-error']) {
            expect(readSiteverify({ success: false, 'error-codes': [code] }), code).toBe('unavailable');
        }
        // An answer we cannot place at all: no basis to blame the token.
        expect(readSiteverify({ success: false, 'error-codes': ['some-future-code'] })).toBe('unavailable');
        expect(readSiteverify({ success: false })).toBe('unavailable');
    });

    it('fails closed on no answer at all — nothing admits without a success', () => {
        // The house style for gates (checkRateLimit fails closed, and says
        // why). A captcha that admits everyone the moment Cloudflare is slow
        // is a captcha an attacker arranges: load is cheap to manufacture.
        for (const payload of [null, undefined, '', 'ok', 0, []]) {
            expect(readSiteverify(payload), String(payload)).toBe('unavailable');
        }
    });
});

describe('the siteverify request', () => {
    it('sends the secret, the token and the address we actually observed', async () => {
        const d = deps({ success: true });
        await verifyTurnstile({ captchaToken: 'cf-token' }, d);
        expect(d.seen).toHaveLength(1);
        expect(Object.fromEntries(d.seen[0]!)).toEqual({
            secret: SECRET,
            response: 'cf-token',
            remoteip: '203.0.113.9',
        });
    });

    it('omits remoteip when there is no address we trust', async () => {
        // clientKey() answers 'unknown' when no unforgeable header is present
        // and the adapter turns that into null: a forged address sent to
        // Cloudflare would poison the signal that passing it is meant to buy.
        const d = deps({ success: true }, { ip: null });
        await verifyTurnstile({ captchaToken: 'cf-token' }, d);
        expect(d.seen[0]!.has('remoteip')).toBe(false);
    });

    it('posts to Cloudflare’s documented endpoint', () => {
        expect(TURNSTILE_SITEVERIFY_URL).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
        expect(siteverifyBody('s', 't', null).toString()).toBe('secret=s&response=t');
    });
});

describe('verifyTurnstile', () => {
    it('admits, having checked nothing, when the deploy has no secret', async () => {
        // The inertness guarantee this whole branch rests on. Note it does not
        // even look at the token: a request with none is admitted too, which
        // is what it must do while no browser can mint one.
        const d = deps({ success: false }, { secret: null });
        expect(await verifyTurnstile({}, d)).toEqual({ ok: true, verified: false, reason: 'not_configured' });
        expect(d.siteverify).not.toHaveBeenCalled();
    });

    it('never lets "not configured" read as "verified" or as "refused"', async () => {
        const unconfigured = await verifyTurnstile({ captchaToken: 'x' }, deps({ success: true }, { secret: null }));
        const verified = await verifyTurnstile({ captchaToken: 'x' }, deps({ success: true }));
        const refused = await verifyTurnstile({ captchaToken: 'x' }, deps({ success: false }));

        // Every refusal is ok:false and nothing else is, so `if (!ok) refuse`
        // is correct and complete...
        expect(unconfigured.ok).toBe(true);
        expect(verified.ok).toBe(true);
        expect(refused.ok).toBe(false);
        // ...and `verified` is true only when Cloudflare itself said so, so a
        // caller asking "did a check actually happen?" cannot be misled either.
        expect(unconfigured.verified).toBe(false);
        expect(verified.verified).toBe(true);
        expect(refused.verified).toBe(false);
        // The two admits stay distinguishable, which is the point.
        expect(unconfigured).not.toEqual(verified);
    });

    it('refuses a missing token without asking Cloudflare', async () => {
        const d = deps({ success: true });
        expect(await verifyTurnstile({}, d)).toEqual({
            ok: false,
            verified: false,
            fault: 'missing',
            code: 'captcha_missing',
            status: 400,
        });
        expect(d.siteverify).not.toHaveBeenCalled();
    });

    it('refuses a token Cloudflare will not vouch for', async () => {
        const verdict = await verifyTurnstile(
            { captchaToken: 'spent' },
            deps({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
        );
        expect(verdict).toEqual({
            ok: false,
            verified: false,
            fault: 'failed',
            code: 'captcha_failed',
            status: 403,
        });
    });

    it('refuses — and says so in the log — when Cloudflare cannot be reached', async () => {
        const d = deps(new Error('network down'));
        expect(await verifyTurnstile({ captchaToken: 'cf-token' }, d)).toEqual({
            ok: false,
            verified: false,
            fault: 'unavailable',
            code: 'captcha_unavailable',
            status: 503,
        });
        expect(d.logError).toHaveBeenCalled();
    });

    it('logs a configuration fault, because nobody can sign up until it is fixed', async () => {
        const d = deps({ success: false, 'error-codes': ['invalid-input-secret'] });
        expect((await verifyTurnstile({ captchaToken: 'cf-token' }, d)).ok).toBe(false);
        expect(d.logError).toHaveBeenCalled();

        // A refused TOKEN is the user's business, not an incident: no log line.
        const refused = deps({ success: false, 'error-codes': ['invalid-input-response'] });
        expect((await verifyTurnstile({ captchaToken: 'cf-token' }, refused)).ok).toBe(false);
        expect(refused.logError).not.toHaveBeenCalled();
    });

    it('gives each refusal its own code, and a status that says whose problem it is', () => {
        const codes = Object.values(TURNSTILE_CODES);
        expect(new Set(codes).size).toBe(codes.length);
        // "Solve it again" (4xx, the caller's) versus "wait, this is ours"
        // (5xx): a user told the wrong one either retries a challenge that
        // cannot pass, or gives up on one that would.
        expect(TURNSTILE_STATUS[TURNSTILE_CODES.missing]).toBeLessThan(500);
        expect(TURNSTILE_STATUS[TURNSTILE_CODES.failed]).toBeLessThan(500);
        expect(TURNSTILE_STATUS[TURNSTILE_CODES.unavailable]).toBeGreaterThanOrEqual(500);
    });
});

describe('the codes guest-email restates', () => {
    it('match turnstile.ts exactly', () => {
        // _shared/guestEmail.ts takes no runtime imports, so it cannot read
        // TURNSTILE_CODES and spells the three strings out instead. This is
        // what stops the two drifting: a code renamed in turnstile.ts fails
        // here rather than becoming a refusal the browser cannot place.
        expect({
            missing: GUEST_EMAIL_ERRORS.captchaMissing.code,
            failed: GUEST_EMAIL_ERRORS.captchaFailed.code,
            unavailable: GUEST_EMAIL_ERRORS.captchaUnavailable.code,
        }).toEqual({ ...TURNSTILE_CODES });
    });

    it('each say something a guest can act on, and say different things', () => {
        const messages = [
            GUEST_EMAIL_ERRORS.captchaMissing.error,
            GUEST_EMAIL_ERRORS.captchaFailed.error,
            GUEST_EMAIL_ERRORS.captchaUnavailable.error,
        ];
        expect(new Set(messages).size).toBe(messages.length);
        for (const message of messages) {
            expect(message.length).toBeGreaterThan(20);
        }
    });

    it('every verdict turnstile.ts can produce is one guestEmail.ts can read', () => {
        // The structural contract between the two no-imports modules, checked
        // by the compiler: guestEmail.ts declares CaptchaVerdict by hand
        // because it cannot import TurnstileVerdict, so a reshape there has to
        // fail somewhere, and this is where.
        const verdicts: TurnstileVerdict[] = [
            { ok: true, verified: true },
            { ok: true, verified: false, reason: 'not_configured' },
            { ok: false, verified: false, fault: 'missing', code: 'captcha_missing', status: 400 },
            { ok: false, verified: false, fault: 'failed', code: 'captcha_failed', status: 403 },
            { ok: false, verified: false, fault: 'unavailable', code: 'captcha_unavailable', status: 503 },
        ];
        const asRead: CaptchaVerdict[] = verdicts;
        expect(asRead.filter((verdict) => !verdict.ok)).toHaveLength(3);
    });
});

describe('the verifier is the file Deno runs', () => {
    it('takes no runtime imports, so vitest loads exactly what the edge runtime does', () => {
        const source = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/turnstile.ts'), 'utf8');
        const imports = source.match(/^import .*$/gm) ?? [];
        // Type-only imports are fine (they vanish at compile time); a value
        // import would need the `.ts` extension for Deno and no extension for
        // vitest, and no spelling satisfies both.
        expect(imports.filter((line) => !line.startsWith('import type'))).toEqual([]);
    });

    it('is reached through the thin Deno adapter, which is the only half that touches fetch', () => {
        const adapter = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/turnstileVerify.ts'), 'utf8');
        const logic = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/turnstile.ts'), 'utf8');
        expect(adapter).toContain('TURNSTILE_SECRET_KEY');
        expect(adapter).toContain('fetch(');
        // The decision half must not reach for either: it is the file the
        // tests above drive, and `Deno` does not exist under vitest at all.
        // Comments stripped first — the module talks ABOUT Deno.env at length,
        // which is the explaining this codebase wants and not a reference.
        const code = logic.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toContain('Deno.');
        expect(code).not.toMatch(/\bfetch\(/);
    });
});
