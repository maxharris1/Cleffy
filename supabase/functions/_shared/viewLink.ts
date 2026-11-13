/**
 * The view-link Edge Function's control flow (packet U13-2): read-only access
 * to one score through an under-13 view link, for the Vercel proxy
 * (api/view.ts) only.
 *
 * NO runtime imports, like guestEmail.ts: Deno loads this file with the `.ts`
 * extension and vitest without (tests/viewLinks/viewLinkEdge.test.ts), and
 * index.ts hands in everything it runs against.
 *
 * What it promises:
 * - Off unless the VIEW_LINKS_ENABLED secret is exactly "1" (404).
 * - Only the proxy may call it: x-cleffy-view-proxy must equal
 *   VIEW_PROXY_SECRET, compared in constant time; an unset secret fails closed.
 * - Rate limited per link, by a SHA-256 of the token. Never by IP: the
 *   function never reads an address, and the proxy sends none.
 * - Nothing about the request is logged — no token, address or header.
 * - Answers only for an active, unexpired link on a live score; anything else
 *   is one indistinguishable 410 {gone:true}.
 * - Never sends created_by, a name or an email: marks are rebuilt here from a
 *   fixed list of fields, whatever the database returned.
 * - Never sends an erased mark's content: a tombstone goes out as
 *   {id, seq, deleted:true} only. A live mark's payload keeps only the keys
 *   the renderer draws with (VIEW_PAYLOAD_KEYS). view_mark_for_viewer in the
 *   migration does the same; this is the second lock on the same door.
 */

export const VIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const PROXY_HEADER = 'x-cleffy-view-proxy';

/** A poll body is a token, a number and a flag. */
export const VIEW_BODY_MAX_BYTES = 1024;

/**
 * Largest PDF streamed through the proxy. Vercel Functions cap a response
 * body at 4.5 MB; anything bigger gets a short-lived signed URL instead.
 * VIEW_PDF_PROXY_MAX overrides it.
 */
export const VIEW_PDF_PROXY_MAX_DEFAULT = 4_000_000;

/** The direct-download fallback's lifetime. */
export const VIEW_SIGNED_URL_TTL_S = 60;

/** Per link, shared by everyone holding it. VIEW_RATE_PER_MIN overrides the limit. */
export const VIEW_RATE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

/** Marks per poll answer; the viewer asks again at once while `more` is true. */
export const VIEW_PAGE_SIZE = 500;

/**
 * The payload keys a viewer may see, per kind: what strokeRenderer.ts and
 * musicFont.ts draw with. Provenance flags (src, sf) and any unknown key a
 * payload may carry are dropped.
 */
export const VIEW_PAYLOAD_KEYS = {
    stroke: ['pts', 'w', 'sp'],
    highlight: ['pts', 'w', 'sp'],
    text: ['x', 'y', 'size', 'text', 'hw', 'font', 'bold', 'italic'],
} as const;

export interface ViewMarkOut {
    id: string;
    page: number;
    kind: string;
    color: string;
    payload: Record<string, unknown>;
    seq: number;
    deleted: false;
}

/** An erased mark: which one, and when. Nothing of what it was. */
export interface ViewTombstoneOut {
    id: string;
    seq: number;
    deleted: true;
}

export type ViewAnnotationOut = ViewMarkOut | ViewTombstoneOut;

/** What view_link_poll returns (20261112130000_view_links.sql). */
export interface ViewPollRow {
    doc: { pages: number | null; pdf_rev: number };
    pdf_bytes: number | null;
    annotations: ViewAnnotationOut[];
    max_seq: number;
    more: boolean;
}

type RateResult = { ok: true } | { ok: false; retryAfterSec: number };
type CappedRead = { ok: true; value: unknown } | { ok: false; status: 413 | 400 };

export interface ViewLinkDeps {
    env: (name: string) => string | undefined;
    secretsEqual: (received: string | null | undefined, expected: string | null | undefined) => Promise<boolean>;
    readJson: (req: Request, maxBytes: number) => Promise<CappedRead>;
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<RateResult>;
    /** null: no such live link. 'error': could not tell. */
    poll: (token: string, since: number, limit: number) => Promise<ViewPollRow | null | 'error'>;
    pdfObject: (token: string) => Promise<{ storagePath: string; bytes: number | null } | null | 'error'>;
    download: (storagePath: string) => Promise<Blob | ReadableStream<Uint8Array> | null>;
    signedUrl: (storagePath: string, ttlSeconds: number) => Promise<string | null>;
}

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...NO_STORE, ...extra },
    });

const GONE = () => json({ gone: true }, 410);

const hex = (bytes: ArrayBuffer): string =>
    [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The rate-limit bucket for a link: `view:` and the token's SHA-256, never the token itself. */
export const viewRateLimitKey = async (token: string): Promise<string> =>
    `view:${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))}`;

const positiveInt = (raw: string | undefined, fallback: number): number => {
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : fallback;
};

const pickPayload = (kind: string, payload: unknown): Record<string, unknown> => {
    const keys: readonly string[] = VIEW_PAYLOAD_KEYS[kind as keyof typeof VIEW_PAYLOAD_KEYS] ?? [];
    const source = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
            out[key] = source[key];
        }
    }
    return out;
};

const pickAnnotation = (row: ViewAnnotationOut): ViewAnnotationOut => {
    // Anything but an explicit `false` is treated as erased: when in doubt,
    // send nothing of the mark.
    if (row.deleted !== false) {
        return { id: String(row.id), seq: Number(row.seq), deleted: true };
    }
    const kind = String(row.kind);
    return {
        id: String(row.id),
        page: Number(row.page),
        kind,
        color: String(row.color),
        payload: pickPayload(kind, row.payload),
        seq: Number(row.seq),
        deleted: false,
    };
};

export const handleViewLink = async (req: Request, deps: ViewLinkDeps): Promise<Response> => {
    if (deps.env('VIEW_LINKS_ENABLED') !== '1') {
        return json({ error: 'not_found' }, 404);
    }
    if (req.method !== 'POST') {
        return json({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    }
    if (!(await deps.secretsEqual(req.headers.get(PROXY_HEADER), deps.env('VIEW_PROXY_SECRET')))) {
        return json({ error: 'unauthorized' }, 401);
    }

    const read = await deps.readJson(req, VIEW_BODY_MAX_BYTES);
    if (!read.ok) {
        return json({ error: read.status === 413 ? 'payload_too_large' : 'bad_request' }, read.status);
    }
    const body = (read.value && typeof read.value === 'object' ? read.value : {}) as Record<string, unknown>;
    const token = body.token;
    if (typeof token !== 'string' || !VIEW_TOKEN_PATTERN.test(token)) {
        return GONE();
    }

    const limit = positiveInt(deps.env('VIEW_RATE_PER_MIN'), VIEW_RATE_LIMIT.limit);
    const rate = await deps.checkRateLimit(await viewRateLimitKey(token), limit, VIEW_RATE_LIMIT.windowMs);
    if (!rate.ok) {
        return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(rate.retryAfterSec) });
    }

    const proxyMax = positiveInt(deps.env('VIEW_PDF_PROXY_MAX'), VIEW_PDF_PROXY_MAX_DEFAULT);

    if (body.pdf === true) {
        const object = await deps.pdfObject(token);
        if (object === 'error') {
            return json({ error: 'unavailable' }, 503);
        }
        if (object === null) {
            return GONE();
        }
        if (object.bytes !== null && object.bytes <= proxyMax) {
            const bytes = await deps.download(object.storagePath);
            if (!bytes) {
                return json({ error: 'unavailable' }, 503);
            }
            return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf', ...NO_STORE } });
        }
        const url = await deps.signedUrl(object.storagePath, VIEW_SIGNED_URL_TTL_S);
        if (!url) {
            return json({ error: 'unavailable' }, 503);
        }
        return json({ pdf: 'direct', url });
    }

    const since = Number.isSafeInteger(body.since) && (body.since as number) >= 0 ? (body.since as number) : 0;
    const poll = await deps.poll(token, since, VIEW_PAGE_SIZE);
    if (poll === 'error') {
        return json({ error: 'unavailable' }, 503);
    }
    if (poll === null) {
        return GONE();
    }
    return json({
        doc: { pages: poll.doc.pages ?? null, pdf_rev: Number(poll.doc.pdf_rev) },
        pdf: poll.pdf_bytes !== null && poll.pdf_bytes <= proxyMax ? 'proxy' : 'direct',
        annotations: poll.annotations.map(pickAnnotation),
        max_seq: Number(poll.max_seq),
        more: poll.more === true,
    });
};
