import type { readCappedJson } from '../_shared/readCappedJson.ts';
import { type ShareSigningKey, sha256Hex, signViewerJwt, verifyViewerJwt } from '../_shared/shareSession.ts';

/**
 * share-session (Share v2, #104): a signed-out visitor's general link, turned
 * into what the viewer page needs. A live viewer link gets a 10-minute viewer
 * token and a 5-minute signed URL for the PDF; an editor link mints nothing
 * (the app signs in a guest and redeems it); a dead link gets only its state.
 *
 * Rate limits are keyed by a hash of the link's id, never by IP or token, and
 * fail closed. `share-viewers` caps how many people a link can let in per 10
 * minutes (D10); a viewer renewing its own token is already counted, so a
 * renewal skips it, otherwise renewals alone would fill the cap.
 */

export type ResolvedLink =
    | { state: 'invalid' }
    | { state: 'revoked' | 'expired' | 'unavailable'; link_id: string }
    | {
          state: 'live';
          role: 'viewer' | 'editor';
          link_id: string;
          doc: { id: string; title: string; page_count: number | null; content_rev: number };
          pdf_path: string;
          link_expires_at: string | null;
      };

type Gate = { ok: true } | { ok: false; retryAfterSec: number };

export interface ShareSessionDeps {
    enabled: () => boolean;
    json: (body: unknown, status?: number) => Response;
    options: () => Response;
    readJson: typeof readCappedJson;
    /** share_session_resolve; null when the read failed. */
    resolve: (token: string) => Promise<ResolvedLink | null>;
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    signingKey: () => Promise<ShareSigningKey | null>;
    /** A signed URL for the score's PDF in the scores bucket; null on failure. */
    signedPdfUrl: (path: string, expiresInSec: number) => Promise<string | null>;
    /** SHARE_VIEWER_CAP: new viewers a link admits per window (D10). */
    viewerCap: number;
    now: () => number;
}

export const BODY_MAX_BYTES = 1024;
export const MINT_LIMIT = { limit: 120, windowMs: 60_000 };
export const VIEWER_WINDOW_MS = 10 * 60_000;
export const DEFAULT_VIEWER_CAP = 40;
export const RENEW_GRACE_SEC = 15 * 60;
export const PDF_URL_TTL_SEC = 300;

const TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** SHARE_VIEWER_CAP as a positive whole number, else the default. */
export const viewerCapFrom = (raw: string | undefined): number => {
    const parsed = Number(raw?.trim());
    return raw?.trim() && Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_VIEWER_CAP;
};

export const handleShareSession = async (req: Request, deps: ShareSessionDeps): Promise<Response> => {
    const { json } = deps;
    if (!deps.enabled()) {
        return json({ error: 'not_found' }, 404);
    }
    if (req.method === 'OPTIONS') {
        return deps.options();
    }
    if (req.method !== 'POST') {
        return json({ error: 'Method not allowed' }, 405);
    }

    const read = await deps.readJson(req, BODY_MAX_BYTES);
    if (!read.ok) {
        return read.status === 413
            ? json({ error: 'Request body too large', code: 'payload_too_large' }, 413)
            : json({ error: 'bad_request' }, 400);
    }
    const body = read.value && typeof read.value === 'object' ? (read.value as Record<string, unknown>) : {};
    const token = body['token'];
    if (typeof token !== 'string' || !TOKEN.test(token)) {
        return json({ state: 'invalid' });
    }

    const link = await deps.resolve(token);
    if (!link) {
        return json({ error: 'unavailable' }, 503);
    }
    if (link.state === 'invalid') {
        return json({ state: 'invalid' });
    }

    const linkKey = await sha256Hex(link.link_id);
    const mint = await deps.checkRateLimit(`share-mint:${linkKey}`, MINT_LIMIT.limit, MINT_LIMIT.windowMs);
    if (!mint.ok) {
        return json({ reason: 'rate_limited', retry_after: mint.retryAfterSec }, 429);
    }
    if (link.state !== 'live') {
        return json({ state: link.state });
    }
    if (link.role === 'editor') {
        return json({ state: 'live', role: 'editor', link_expires_at: link.link_expires_at });
    }

    const key = await deps.signingKey();
    if (!key) {
        return json({ error: 'unavailable' }, 503);
    }
    const nowSec = Math.floor(deps.now() / 1000);
    const renewed =
        typeof body['renew'] === 'string' ? await verifyViewerJwt(key, body['renew'], nowSec, RENEW_GRACE_SEC) : null;
    if (!renewed || renewed.link !== link.link_id || renewed.doc !== link.doc.id) {
        const viewers = await deps.checkRateLimit(`share-viewers:${linkKey}`, deps.viewerCap, VIEWER_WINDOW_MS);
        if (!viewers.ok) {
            return json({ reason: 'too_many_viewers', retry_after: viewers.retryAfterSec }, 429);
        }
    }

    const { jwt, exp } = await signViewerJwt(key, { doc: link.doc.id, link: link.link_id, v: 1 }, nowSec);
    const pdfUrl = await deps.signedPdfUrl(link.pdf_path, PDF_URL_TTL_SEC);
    if (!pdfUrl) {
        return json({ error: 'unavailable' }, 503);
    }
    return json({
        state: 'live',
        role: 'viewer',
        session_jwt: jwt,
        exp,
        doc: link.doc,
        pdf_url: pdfUrl,
        link_expires_at: link.link_expires_at,
    });
};
