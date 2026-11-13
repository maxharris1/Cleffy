import { serviceClient, checkRateLimit } from '../_shared/rateLimit.ts';
import { readCappedJson } from '../_shared/readCappedJson.ts';
import { secretsEqual } from '../_shared/secretCompare.ts';
import { handleViewLink, type ViewPollRow } from '../_shared/viewLink.ts';

/**
 * Under-13 view links: what the Vercel proxy (api/view.ts) calls. The flow,
 * the switch, the proxy secret and the per-link rate limit are in
 * _shared/viewLink.ts; this file only wires them to the database and Storage.
 *
 * No JWT (supabase/config.toml): the proxy holds no user session, and the
 * x-cleffy-view-proxy secret is the gate. The service role is used for the two
 * definer reads and the scores bucket, and never leaves this function.
 *
 * Logging: fixed messages only. Never the token, an address or a header.
 */

Deno.serve((req) =>
    handleViewLink(req, {
        env: (name) => Deno.env.get(name),
        secretsEqual,
        readJson: readCappedJson,
        checkRateLimit,
        poll: async (token, since, limit) => {
            const admin = serviceClient();
            if (!admin) {
                return 'error';
            }
            const { data, error } = await admin.rpc('view_link_poll', {
                p_token: token,
                p_since: since,
                p_limit: limit,
            });
            if (error) {
                console.error('view_link_poll failed');
                return 'error';
            }
            return (data as ViewPollRow | null) ?? null;
        },
        pdfObject: async (token) => {
            const admin = serviceClient();
            if (!admin) {
                return 'error';
            }
            const { data, error } = await admin.rpc('view_link_pdf', { p_token: token });
            if (error) {
                console.error('view_link_pdf failed');
                return 'error';
            }
            const row = (data as Array<{ storage_path: string; pdf_bytes: number | null }> | null)?.[0];
            return row ? { storagePath: row.storage_path, bytes: row.pdf_bytes } : null;
        },
        download: async (storagePath) => {
            const admin = serviceClient();
            if (!admin) {
                return null;
            }
            const { data, error } = await admin.storage.from('scores').download(storagePath);
            if (error || !data) {
                console.error('view-link PDF download failed');
                return null;
            }
            return data;
        },
        signedUrl: async (storagePath, ttlSeconds) => {
            const admin = serviceClient();
            if (!admin) {
                return null;
            }
            const { data, error } = await admin.storage.from('scores').createSignedUrl(storagePath, ttlSeconds);
            if (error || !data?.signedUrl) {
                console.error('view-link signed URL failed');
                return null;
            }
            return data.signedUrl;
        },
    }),
);
