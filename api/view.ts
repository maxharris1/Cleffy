/// <reference types="node" />
/**
 * Vercel Function (Node.js runtime) between the /v viewer page and the
 * view-link Edge Function (packet U13-2). The child's browser talks only to
 * this origin; this forwards the JSON body and nothing else.
 *
 * - 404 unless VIEW_LINKS_ENABLED is exactly "1" (set on Preview/dev only, by
 *   Max; production leaves it unset until counsel signs off — DEPLOY.md).
 * - Forwards NO client header: no address (x-forwarded-for, x-real-ip,
 *   cf-connecting-ip, ...), user agent, referer, cookie or language. The
 *   upstream request carries only the anon key, the proxy secret and a
 *   content type, and a body rebuilt from the three known fields.
 * - Cache-Control: no-store on every answer; upstream headers are not copied
 *   (no Set-Cookie, no gateway headers), bar Content-Type and Retry-After.
 * - Logs nothing.
 * - PDFs stream through. The Edge Function sends only files up to 4,000,000
 *   bytes this way, under Vercel's 4.5 MB function body limit; larger ones get
 *   a 60 s signed URL instead.
 *
 * Env (Vercel): VIEW_LINKS_ENABLED, VIEW_LINKS_SUPABASE_URL,
 * VIEW_LINKS_ANON_KEY, VIEW_PROXY_SECRET. The service-role key stays in
 * Supabase.
 *
 * No path aliases and no imports: Vercel compiles api/ without tsconfig paths.
 */

export const VIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const BODY_MAX_BYTES = 1024;

const BASE_HEADERS = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
} as const;

const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { ...BASE_HEADERS, 'Content-Type': 'application/json' },
    });

const notFound = () => json({ error: 'not_found' }, 404);

interface Upstream {
    url: string;
    anonKey: string;
    secret: string;
}

const upstream = (): Upstream | null => {
    if (process.env.VIEW_LINKS_ENABLED !== '1') {
        return null;
    }
    const base = process.env.VIEW_LINKS_SUPABASE_URL?.trim();
    const anonKey = process.env.VIEW_LINKS_ANON_KEY?.trim();
    const secret = process.env.VIEW_PROXY_SECRET?.trim();
    if (!base || !anonKey || !secret) {
        return null;
    }
    return { url: `${base.replace(/\/+$/, '')}/functions/v1/view-link`, anonKey, secret };
};

/** The body as text, or null past the cap. Counted on the bytes, not Content-Length. */
const readCapped = async (req: Request): Promise<string | null> => {
    const reader = req.body?.getReader();
    if (!reader) {
        return '';
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        size += value.byteLength;
        if (size > BODY_MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
};

/** Only the fields the Edge Function reads, re-serialized. */
const forwardBody = (raw: unknown): { token: string; since?: number; pdf?: true } | null => {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const { token, since, pdf } = raw as Record<string, unknown>;
    if (typeof token !== 'string' || !VIEW_TOKEN_PATTERN.test(token)) {
        return null;
    }
    return {
        token,
        ...(Number.isSafeInteger(since) && (since as number) >= 0 ? { since: since as number } : {}),
        ...(pdf === true ? { pdf: true as const } : {}),
    };
};

export async function POST(req: Request): Promise<Response> {
    const target = upstream();
    if (!target) {
        return notFound();
    }

    let text: string | null;
    try {
        text = await readCapped(req);
    } catch {
        return json({ error: 'bad_request' }, 400);
    }
    if (text === null) {
        return json({ error: 'payload_too_large' }, 413);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return json({ error: 'bad_request' }, 400);
    }
    const body = forwardBody(parsed);
    if (!body) {
        return json({ gone: true }, 410);
    }

    let res: Response;
    try {
        res = await fetch(target.url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                apikey: target.anonKey,
                authorization: `Bearer ${target.anonKey}`,
                'x-cleffy-view-proxy': target.secret,
            },
            body: JSON.stringify(body),
            redirect: 'error',
            cache: 'no-store',
        });
    } catch {
        return json({ error: 'upstream_unreachable' }, 502);
    }

    const headers: Record<string, string> = { ...BASE_HEADERS };
    const type = res.headers.get('content-type') ?? '';
    headers['Content-Type'] = type.startsWith('application/pdf') ? 'application/pdf' : 'application/json';
    const retryAfter = res.headers.get('retry-after');
    if (res.status === 429 && retryAfter && /^\d{1,4}$/.test(retryAfter)) {
        headers['Retry-After'] = retryAfter;
    }
    return new Response(res.body, { status: res.status, headers });
}

/** Only POST is served; anything else is not found, switched on or off. */
export function GET(): Response {
    return notFound();
}
