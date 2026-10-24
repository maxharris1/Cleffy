import { drainBillingMailNow } from '../_shared/billingMailWorker.ts';
import { jsonResponse } from '../_shared/cors.ts';

/**
 * The retry path of the billing mail outbox (migration 20261020160200): the
 * pg_cron job `billing-mail-outbox` posts here every minute while anything is
 * due, and this sends it. Deployed with verify_jwt = false (pg_net has no
 * Supabase JWT, as with imslp-sync); the caller proves itself with the shared
 * secret the cron reads from Vault, which must equal BILLING_OUTBOX_SECRET.
 * `supabase functions deploy billing-mail-outbox --no-verify-jwt`
 */

/** Constant-time, so the comparison does not leak how much of a guess was right. */
const sameSecret = (given: string, expected: string): boolean => {
    const a = new TextEncoder().encode(given);
    const b = new TextEncoder().encode(expected);
    let diff = a.length ^ b.length;
    for (let i = 0; i < b.length; i += 1) {
        diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return diff === 0;
};

Deno.serve(async (req) => {
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }
    const expected = Deno.env.get('BILLING_OUTBOX_SECRET');
    if (!expected) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }
    if (!sameSecret(req.headers.get('x-billing-outbox-secret') ?? '', expected)) {
        return jsonResponse({ error: 'Forbidden' }, 403);
    }
    return jsonResponse(await drainBillingMailNow());
});
