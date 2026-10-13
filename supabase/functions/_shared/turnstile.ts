/**
 * Cloudflare Turnstile, server side: the decision half.
 *
 * NO runtime imports, like stripeMode.ts and guestEmail.ts — Deno loads this
 * with the `.ts` extension and vitest without it, and neither can follow the
 * specifier the other uses. So everything that needs `Deno.env` or `fetch`
 * arrives through `TurnstileDeps`, and `_shared/turnstileVerify.ts` is the thin
 * Deno adapter that binds them. This is the thing standing between a scripted
 * flood and our mail quota, so it is tested directly rather than by proxy.
 *
 * What a captcha is worth here: a Turnstile token proves nothing about WHO the
 * caller is, only that a browser ran Cloudflare's challenge for the site key
 * once and has not spent that token yet. That is exactly the property the abuse
 * paths need — sign-up and the guest-email code are both "anybody at all may
 * ask", and both cost an email to answer.
 *
 * Two configuration facts shape the whole module:
 *
 *  * `TURNSTILE_SECRET_KEY` (an Edge Function secret) is what verification
 *    needs, and `VITE_TURNSTILE_SITE_KEY` (a client build variable) is what
 *    renders the widget. Until BOTH are set this branch must behave exactly as
 *    the one before it: no browser can produce a token without the site key, so
 *    a deploy with the secret and not the site key would refuse every caller.
 *    Hence `not_configured` — an ADMIT, reported distinctly so no caller can
 *    read "nothing was checked" as "the check passed" or as "the check failed".
 *    See TurnstileVerdict for how the type makes that confusion impossible.
 *
 *  * Cloudflare publishes test keys which always pass (site
 *    `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`)
 *    and always fail (site `2x00000000000000000000AB`, secret
 *    `2x0000000000000000000000000000000AA`). Those are what dev and CI use:
 *    a real site key is bound to real hostnames, so a localhost or preview
 *    build with the production key fails every challenge. `.env.example`
 *    carries them.
 */

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare's tokens are a few hundred characters and documented as at most
 * 2048. A longer string cannot be one of theirs, so it is refused here rather
 * than forwarded: this endpoint is reachable by anyone, and siteverify is an
 * outbound request we would otherwise let a caller size.
 */
export const TURNSTILE_TOKEN_MAX = 2048;

/**
 * The refusal codes, stable because the browser branches on them: re-solve the
 * widget (`captcha_missing`, `captcha_failed`) versus wait and retry
 * (`captcha_unavailable`, which is our problem and not the user's).
 *
 * `_shared/guestEmail.ts` restates these three strings in GUEST_EMAIL_ERRORS —
 * it takes no runtime imports either, so it cannot read them from here.
 * `tests/security/turnstile.test.ts` holds the two lists equal.
 */
export const TURNSTILE_CODES = {
    missing: 'captcha_missing',
    failed: 'captcha_failed',
    unavailable: 'captcha_unavailable',
} as const;

export type TurnstileRefusalCode = (typeof TURNSTILE_CODES)[keyof typeof TURNSTILE_CODES];

/** HTTP status per refusal: an incomplete request, a refused proof, our outage. */
export const TURNSTILE_STATUS: Record<TurnstileRefusalCode, number> = {
    captcha_missing: 400,
    captcha_failed: 403,
    captcha_unavailable: 503,
};

/**
 * Why a token was not vouched for, as far as this module can tell:
 *  * `missing`  — no token in the request at all, or one that cannot be one.
 *  * `failed`   — Cloudflare looked and said no: forged, expired, or already
 *                 redeemed (a token is single-use).
 *  * `unavailable` — we could not get an answer we can act on: siteverify was
 *                 unreachable, or it answered with a fault in OUR configuration
 *                 (a missing or wrong secret), which no amount of re-solving
 *                 the widget can fix.
 */
export type TurnstileFault = 'missing' | 'failed' | 'unavailable';

/**
 * The outcome, shaped so "nothing was checked" cannot be mistaken for either
 * "checked and passed" or "checked and refused".
 *
 * Every refusal is `ok: false` and nothing else is, so the one-line guard
 * `if (!verdict.ok) return refuse(verdict)` is correct and complete. A caller
 * that additionally cares whether a check really happened — a log line, a
 * metric, a test asserting this branch ships inert — reads `verified`, which is
 * true only when Cloudflare itself vouched for a token.
 */
export type TurnstileVerdict =
    | { ok: true; verified: true }
    | { ok: true; verified: false; reason: 'not_configured' }
    | { ok: false; verified: false; fault: TurnstileFault; code: TurnstileRefusalCode; status: number };

export interface TurnstileDeps {
    /** TURNSTILE_SECRET_KEY, or null on a deploy that has none. */
    secretKey: () => string | null;
    /**
     * The caller's address, for siteverify's `remoteip`, or null when we do not
     * have one we trust. MUST be `clientKey(req)` from `_shared/rateLimit.ts`
     * and never the first `x-forwarded-for` hop — read that function's note:
     * the client appends to that header, so its first entry is whatever the
     * caller chose to put there. Sending a forged address to Cloudflare would
     * poison the signal they use it for, which is the one thing passing it is
     * supposed to buy.
     */
    remoteIp: () => string | null;
    /** POST the form body to siteverify; null when no answer could be had at all. */
    siteverify: (body: URLSearchParams) => Promise<unknown>;
    logError: (message: string, err?: unknown) => void;
}

/**
 * The token a request carries, or null. `captchaToken` is the field name
 * supabase-js uses for the same value (`options.captchaToken`), so the browser
 * spells it one way everywhere.
 */
export const turnstileTokenIn = (body: unknown): string | null => {
    const token = body && typeof body === 'object' ? (body as Record<string, unknown>)['captchaToken'] : undefined;
    if (typeof token !== 'string') {
        return null;
    }
    const trimmed = token.trim();
    return trimmed.length > 0 && trimmed.length <= TURNSTILE_TOKEN_MAX ? trimmed : null;
};

/** The siteverify form: the secret, the token, and the address we actually observed. */
export const siteverifyBody = (secret: string, token: string, remoteIp: string | null): URLSearchParams => {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) {
        body.set('remoteip', remoteIp);
    }
    return body;
};

/**
 * Error codes that are about the TOKEN — the caller can fix these by solving
 * the widget again. `timeout-or-duplicate` is both an expired token and a
 * replayed one, and Cloudflare does not distinguish them; either way the answer
 * to the user is the same sentence.
 */
const TOKEN_FAULT_CODES = ['missing-input-response', 'invalid-input-response', 'timeout-or-duplicate'];

/**
 * What a siteverify answer means.
 *
 * `success: true` is the only admit. Everything else refuses, and the only
 * question is which refusal is honest:
 *
 * A fault in our own configuration (no secret, the wrong secret, a malformed
 * request, Cloudflare's own internal error) is reported as `unavailable`, not
 * `failed`: telling a user to re-solve a challenge that cannot succeed until
 * someone fixes a secret is a loop with no exit, and the 503 is what shows up
 * in logs as ours. An answer we cannot place at all is `unavailable` for the
 * same reason — we have no basis to blame the token.
 *
 * Nothing here can admit on a missing or unparseable answer. That is
 * deliberate and it is this codebase's house style for gates
 * (`checkRateLimit` fails closed on an RPC failure, and says why). A captcha
 * that admits everyone the moment Cloudflare is slow is a captcha an attacker
 * arranges: load is cheap to manufacture, and "fail open under load" hands them
 * precisely the window they want. The cost of the other choice is real and
 * smaller — during a Cloudflare outage sign-up and the guest-email code answer
 * 503 "try again in a moment", which is true, while every other path in the app
 * keeps working.
 */
export const readSiteverify = (payload: unknown): 'verified' | 'failed' | 'unavailable' => {
    if (!payload || typeof payload !== 'object') {
        return 'unavailable';
    }
    const record = payload as { success?: unknown; 'error-codes'?: unknown };
    if (record.success === true) {
        return 'verified';
    }
    const codes = Array.isArray(record['error-codes'])
        ? record['error-codes'].filter((code): code is string => typeof code === 'string')
        : [];
    return codes.some((code) => TOKEN_FAULT_CODES.includes(code)) ? 'failed' : 'unavailable';
};

const refuse = (fault: TurnstileFault): TurnstileVerdict => {
    const code = TURNSTILE_CODES[fault];
    return { ok: false, verified: false, fault, code, status: TURNSTILE_STATUS[code] };
};

/**
 * Verify the token on a request, or report that there is nothing to verify
 * with.
 *
 * Order matters: the secret is read FIRST, so a deploy without one never looks
 * at the token and never calls Cloudflare. That is what makes this branch inert
 * until Max sets the two keys — an unconfigured deploy cannot refuse anybody,
 * whatever (or nothing) the browser sent.
 */
export const verifyTurnstile = async (body: unknown, deps: TurnstileDeps): Promise<TurnstileVerdict> => {
    const secret = deps.secretKey();
    if (!secret) {
        return { ok: true, verified: false, reason: 'not_configured' };
    }
    const token = turnstileTokenIn(body);
    if (!token) {
        return refuse('missing');
    }
    let answer: unknown;
    try {
        answer = await deps.siteverify(siteverifyBody(secret, token, deps.remoteIp()));
    } catch (err) {
        deps.logError('turnstile siteverify could not be reached', err);
        return refuse('unavailable');
    }
    const outcome = readSiteverify(answer);
    if (outcome === 'verified') {
        return { ok: true, verified: true };
    }
    if (outcome === 'unavailable') {
        // Our configuration or Cloudflare's, never the caller's: worth a log
        // line, because nobody can sign up until it is fixed.
        deps.logError('turnstile siteverify gave no answer we can act on');
    }
    return refuse(outcome);
};
