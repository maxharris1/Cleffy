import { logError } from './errorReporting.ts';
import { clientKey } from './rateLimit.ts';
import { TURNSTILE_SITEVERIFY_URL, verifyTurnstile, type TurnstileVerdict } from './turnstile.ts';

/**
 * Deno adapter over `turnstile.ts`.
 *
 * Everything decision-making lives there, import-free, so the vitest suite can
 * load and test the same file Deno runs (the `stripeMode.ts` + `stripe.ts`
 * split). All this module adds is the three things only Deno has: `Deno.env`,
 * `fetch`, and the request the caller's address is read off.
 */

export { TURNSTILE_CODES, TURNSTILE_STATUS, type TurnstileRefusalCode, type TurnstileVerdict } from './turnstile.ts';

/**
 * The verification secret, or null on a deploy without one — which is every
 * deploy until Max sets it, and is why this ships inert. Set with
 * `npx supabase secrets set TURNSTILE_SECRET_KEY=… --project-ref <ref>`; dev
 * and CI use Cloudflare's always-passes test secret
 * `1x0000000000000000000000000000000AA` (see `.env.example`).
 */
export const turnstileSecretKey = (): string | null => Deno.env.get('TURNSTILE_SECRET_KEY')?.trim() || null;

/** How long we wait for Cloudflare before treating the check as unavailable. */
const SITEVERIFY_TIMEOUT_MS = 5000;

/**
 * The Turnstile verdict for `req`, given the parsed request body the token
 * travels in (`captchaToken`).
 *
 * `clientKey(req)` is the address sent to Cloudflare — the one header a client
 * cannot forge, per its note. It answers the string 'unknown' when there is no
 * usable header at all, which is not an address and must not be sent as one.
 *
 * The timeout exists because the alternative to an answer is a hung sign-up:
 * an edge invocation blocking on Cloudflare holds the caller's request open for
 * as long as the platform allows. A timeout lands on `unavailable` — the gate
 * refuses rather than admits, which is the whole point of failing closed.
 */
export const verifyTurnstileRequest = (req: Request, body: unknown): Promise<TurnstileVerdict> =>
    verifyTurnstile(body, {
        secretKey: turnstileSecretKey,
        remoteIp: () => {
            const key = clientKey(req);
            return key === 'unknown' ? null : key;
        },
        siteverify: async (form) => {
            const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: form,
                signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
            });
            if (!response.ok) {
                // Not an answer about the token: a non-200 from siteverify is
                // Cloudflare refusing the REQUEST. Thrown so it lands on
                // `unavailable` rather than being read as a verdict of "no".
                throw new Error(`siteverify returned ${response.status}`);
            }
            return await response.json();
        },
        logError: (message, err) => logError('turnstile', err ?? new Error(message), { code: message }),
    });
