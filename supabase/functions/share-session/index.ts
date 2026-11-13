import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, serviceClient } from '../_shared/rateLimit.ts';
import { readCappedJson } from '../_shared/readCappedJson.ts';
import { shareSigningKey } from '../_shared/shareSession.ts';
import { handleShareSession, type ResolvedLink, viewerCapFrom } from './handler.ts';

/** Wiring for handler.ts. No JWT (supabase/config.toml): the caller is signed out. */

const env = (name: string): string | undefined => Deno.env.get(name);

Deno.serve((req) =>
    handleShareSession(req, {
        enabled: () => env('SHARE_V2_ENABLED') === '1',
        json: jsonResponse,
        options: optionsResponse,
        readJson: readCappedJson,
        resolve: async (token) => {
            const admin = serviceClient();
            if (!admin) {
                return null;
            }
            const { data, error } = await admin.rpc('share_session_resolve', { p_token: token });
            if (error || !data || typeof data !== 'object') {
                console.error(`share_session_resolve failed: ${error?.message ?? 'no answer'}`);
                return null;
            }
            return data as ResolvedLink;
        },
        checkRateLimit,
        signingKey: () => shareSigningKey(env),
        signedPdfUrl: async (path, expiresInSec) => {
            const admin = serviceClient();
            if (!admin) {
                return null;
            }
            const { data, error } = await admin.storage.from('scores').createSignedUrl(path, expiresInSec);
            if (error || !data?.signedUrl) {
                console.error(`could not sign the score PDF URL: ${error?.message ?? 'no url'}`);
                return null;
            }
            return data.signedUrl;
        },
        viewerCap: viewerCapFrom(env('SHARE_VIEWER_CAP')),
        now: () => Date.now(),
    }),
);
