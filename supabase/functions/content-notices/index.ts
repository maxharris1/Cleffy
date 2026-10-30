import { handleContentNotices } from '../_shared/contentReports.ts';
import { common, sendEmail } from '../_shared/contentReportsWiring.ts';

/**
 * The outbox retry: delivers the content notices still owed (the
 * acknowledgments, statements of reasons and outcomes queued in
 * content_notice_outbox). pg_cron's content_notice_retry_tick posts here every
 * five minutes while anything is due, with the shared secret from the vault
 * (content_notice_secret) in `x-content-notice-secret`, which must equal this
 * function's CONTENT_NOTICE_SECRET. Deployed with `verify_jwt = false`
 * (supabase/config.toml): pg_net has no user JWT to send, and the secret is
 * the gate. The flow is in _shared/contentReports.ts.
 */

const digest = async (value: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));

/** Compare the digests, every byte, so the time taken says nothing about the secret. */
const sameSecret = async (given: string, expected: string): Promise<boolean> => {
    const [a, b] = await Promise.all([digest(given), digest(expected)]);
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
        diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return diff === 0;
};

Deno.serve((req) =>
    handleContentNotices(req, {
        ...common,
        sendEmail,
        authorized: async (request) => {
            const expected = Deno.env.get('CONTENT_NOTICE_SECRET');
            if (!expected) {
                return null;
            }
            return sameSecret(request.headers.get('x-content-notice-secret') ?? '', expected);
        },
    }),
);
