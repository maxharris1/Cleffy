import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import {
    deliverDistrictNotices,
    type DistrictNoticeMessage,
    type DistrictNoticeRow,
} from '../_shared/districtNotice.ts';
import { logError } from '../_shared/errorReporting.ts';
import { serviceClient } from '../_shared/rateLimit.ts';
import { secretsEqual } from '../_shared/secretCompare.ts';

/**
 * Sends the 14-day export notice to a district's owner before its data is
 * purged (20261021120700_district_retention.sql; the mail and the loop are in
 * _shared/districtNotice.ts).
 *
 * Woken by retention_district_run through pg_net, which has no Supabase JWT:
 * the request is authenticated by x-district-notice-secret, or a service-role
 * bearer for a hand trigger, each compared in constant time, as imslp-sync is.
 */

const RESEND_API = 'https://api.resend.com';

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

const send = async (to: string, message: DistrictNoticeMessage): Promise<'sent' | 'failed' | 'unconfigured'> => {
    const apiKey = Deno.env.get('RESEND_API_KEY');
    if (!apiKey) {
        return 'unconfigured';
    }
    const res = await fetch(`${RESEND_API}/emails`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: mailFrom(), to: [to], reply_to: 'support@cleffy.io', ...message }),
    });
    if (!res.ok) {
        // The status and Resend's reason, never the address.
        logError('district-retention-notices', new Error(`resend returned ${res.status}`), {
            code: 'send_failed',
            detail: (await res.text()).slice(0, 300),
        });
        return 'failed';
    }
    return 'sent';
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
    });
    if (!result) {
        return jsonResponse({ error: 'Could not read the notices' }, 502);
    }
    return jsonResponse(result);
});
