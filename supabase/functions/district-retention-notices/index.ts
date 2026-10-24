import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import {
    deliverDistrictNotices,
    type DistrictNoticeMessage,
    type DistrictNoticeRow,
    type MailReservation,
    noticeOutcomeOf,
    type NoticeSendOutcome,
} from '../_shared/districtNotice.ts';
import { logError } from '../_shared/errorReporting.ts';
import { mailLimit } from '../_shared/mailBudget.ts';
import { checkRateLimit, refundRateLimit, serviceClient } from '../_shared/rateLimit.ts';
import { sendViaResend } from '../_shared/resendDelivery.ts';
import { secretsEqual } from '../_shared/secretCompare.ts';

/**
 * Sends the 14-day export notice to a district's owner before its data is
 * purged (20261021120700_district_retention.sql; the mail and the loop are in
 * _shared/districtNotice.ts).
 *
 * Woken by retention_district_run through pg_net, which has no Supabase JWT:
 * the request is authenticated by x-district-notice-secret, or a service-role
 * bearer for a hand trigger, each compared in constant time, as imslp-sync is.
 *
 * No notice leaves without a reservation from the shared mail budget: the
 * `retentionNotice` share of LAUNCH_MAIL_SPLIT, hour and day, counted in the
 * same edge rate-limit buckets every other budgeted sender uses.
 *
 * Resend is called through _shared/resendDelivery.ts (byte-identical to #62's),
 * which says `sent`, `rejected` or `unknown`. Only a certain non-send hands the
 * reservation back; an unknown outcome keeps it and is retried by the next
 * run with the same Idempotency-Key.
 */

const mailFrom = (): string => Deno.env.get('DISTRICT_NOTICE_FROM') ?? 'Cleffy <noreply@cleffy.io>';

const authorized = async (req: Request): Promise<boolean> => {
    const auth = req.headers.get('authorization') ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
    const [secretOk, serviceOk] = await Promise.all([
        secretsEqual(req.headers.get('x-district-notice-secret'), Deno.env.get('DISTRICT_NOTICE_SECRET')),
        secretsEqual(bearer, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')),
    ]);
    return secretOk || serviceOk;
};

const env = (name: string): string | undefined => Deno.env.get(name);

/** The budget buckets, hour then day. Past either, nothing is sent until it moves on. */
const BUDGET = [
    ['district-retention-notices:global', mailLimit('retentionNotice', 'hour', env)],
    ['district-retention-notices:global-day', mailLimit('retentionNotice', 'day', env)],
] as const;

const reserve = async (): Promise<MailReservation> => {
    const reserved: string[] = [];
    const release = async (): Promise<void> => {
        await Promise.all(reserved.map((key) => refundRateLimit(key).catch(() => undefined)));
    };
    for (const [key, { limit, windowMs }] of BUDGET) {
        const gate = await checkRateLimit(key, limit, windowMs);
        if (!gate.ok) {
            await release();
            return { ok: false, retryAfterSec: gate.retryAfterSec };
        }
        reserved.push(key);
    }
    return { ok: true, release };
};

const send = async (to: string, message: DistrictNoticeMessage, idempotencyKey: string): Promise<NoticeSendOutcome> => {
    const result = await sendViaResend({
        apiKey: Deno.env.get('RESEND_API_KEY'),
        idempotencyKey,
        email: { from: mailFrom(), to: [to], reply_to: 'support@cleffy.io', ...message },
    });
    const outcome = noticeOutcomeOf(result);
    if (outcome === 'rejected' || outcome === 'unknown') {
        // The reason, the status and Resend's error, never the address.
        logError('district-retention-notices', new Error(`resend ${outcome}: ${result.reason}`), {
            code: outcome === 'unknown' ? 'send_unknown' : 'send_rejected',
            detail: [result.errorName, result.detail].filter(Boolean).join(' ').slice(0, 300),
        });
    }
    return outcome;
};

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return optionsResponse();
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405);
    }
    if (!(await authorized(req))) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    const admin = serviceClient();
    if (!admin) {
        return jsonResponse({ error: 'Server misconfigured' }, 500);
    }

    const result = await deliverDistrictNotices({
        claim: async (limit) => {
            const { data, error } = await admin.rpc('claim_district_retention_notices', { p_limit: limit });
            if (error) {
                logError('district-retention-notices', new Error(error.message), { code: 'claim_failed' });
                return null;
            }
            return (data ?? []) as DistrictNoticeRow[];
        },
        reserve,
        hourlyLimit: BUDGET[0][1].limit,
        send,
        finish: async (id, failure) => {
            const { error } = await admin.rpc('finish_district_retention_notice', { p_id: id, p_error: failure });
            if (error) {
                // The lease runs out and the notice is claimed again: at worst
                // the owner is told twice, never not at all.
                logError('district-retention-notices', new Error(error.message), { code: 'finish_failed' });
            }
            return !error;
        },
        defer: async (id) => {
            const { error } = await admin.rpc('defer_district_retention_notice', { p_id: id });
            if (error) {
                // The lease runs out and the notice is claimed again later.
                logError('district-retention-notices', new Error(error.message), { code: 'defer_failed' });
            }
            return !error;
        },
    });
    if (!result) {
        return jsonResponse({ error: 'Could not read the notices' }, 502);
    }
    if (result.deferred > 0) {
        logError('district-retention-notices', new Error('the retention notice mail budget is spent'), {
            code: 'budget_deferred',
            detail: `${result.deferred} deferred`,
        });
    }
    return jsonResponse(result);
});
