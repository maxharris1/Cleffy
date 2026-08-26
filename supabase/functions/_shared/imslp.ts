import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

/** Shared IMSLP MediaWiki helpers for Edge Functions. */

export const IMSLP_ORIGIN = 'https://imslp.org';
export const IMSLP_API = `${IMSLP_ORIGIN}/api.php`;
/** Browser-like UA — IMSLP's friendly-redirect gate is stricter with bare bot UAs. */
export const USER_AGENT =
    'Mozilla/5.0 (compatible; Cleffy/1.0; +https://cleffy.app) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Soft size cap — matches the private `scores` bucket limit. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** Cookies that skip IMSLP's JS redirect interstitial + disclaimer confirm. */
const IMSLP_SESSION_COOKIES =
    'imslpdisclaimeraccepted=yes; imslp_wikiLanguageSelectorLanguage=en; redirectPassed=1';

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

const memoryRateLimit = (
    key: string,
    limit: number,
    windowMs: number,
): { ok: true } | { ok: false; retryAfterSec: number } => {
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
        rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
        return { ok: true };
    }
    if (bucket.count >= limit) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    return { ok: true };
};

/** Service-role client for shared rate-limit RPCs (cached). */
let cachedService: SupabaseClient | null | undefined;

export const serviceClient = (): SupabaseClient | null => {
    if (cachedService !== undefined) {
        return cachedService;
    }
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) {
        cachedService = null;
        return null;
    }
    cachedService = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return cachedService;
};

/**
 * Cross-isolate sliding window via Postgres. When a service-role client is
 * available, RPC failure fails closed (429) so Free-plan quotas are not
 * silently bypassed by per-isolate memory. Memory fallback is only for local
 * Edge without service-role credentials.
 */
export const checkRateLimit = async (
    key: string,
    limit: number,
    windowMs: number,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> => {
    const admin = serviceClient();
    if (!admin) {
        return memoryRateLimit(key, limit, windowMs);
    }
    try {
        const { data, error } = await admin.rpc('check_edge_rate_limit', {
            p_key: key,
            p_limit: limit,
            p_window_ms: windowMs,
        });
        if (!error && data && typeof data === 'object') {
            const record = data as { ok?: boolean; retryAfterSec?: number };
            if (record.ok === true) {
                return { ok: true };
            }
            if (record.ok === false) {
                return {
                    ok: false,
                    retryAfterSec: typeof record.retryAfterSec === 'number' ? record.retryAfterSec : 1,
                };
            }
        }
    } catch {
        // fall through to fail-closed
    }
    return { ok: false, retryAfterSec: 5 };
};

/**
 * The rate-limit bucket key for a request — which must be something the CALLER
 * cannot choose, or every limit built on it is decorative.
 *
 * cf-connecting-ip first: the edge proxy OVERWRITES it on every hop, so a header
 * the client sets is discarded. x-forwarded-for is APPENDED to instead, which
 * means its FIRST entry is whatever the client sent (`X-Forwarded-For: 10.0.0.$RANDOM`
 * would hand an attacker a fresh bucket per request against the open student-login
 * endpoint) and only its LAST entry is the address a proxy actually observed.
 */
export const clientKey = (req: Request): string => {
    const connecting = req.headers.get('cf-connecting-ip')?.trim();
    if (connecting) {
        return connecting;
    }
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) {
        const hops = forwarded.split(',');
        return hops[hops.length - 1]?.trim() || 'unknown';
    }
    return 'unknown';
};

export const mwFetch = async (params: Record<string, string>): Promise<unknown> => {
    const url = new URL(IMSLP_API);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }
    url.searchParams.set('format', 'json');

    const res = await fetch(url.toString(), {
        headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
        },
    });
    if (!res.ok) {
        throw new Error(`IMSLP API HTTP ${res.status}`);
    }
    return res.json();
};

export const workPageUrl = (title: string): string =>
    `${IMSLP_ORIGIN}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

export const imagefromIndexUrl = (filename: string): string =>
    `${IMSLP_ORIGIN}/wiki/Special:ImagefromIndex/${encodeURIComponent(filename)}`;

export const parseComposerFromTitle = (title: string): string | null => {
    const match = title.match(/\(([^)]+)\)\s*$/);
    return match?.[1]?.trim() ?? null;
};

export const stripFilePrefix = (title: string): string => title.replace(/^File:/i, '');

export const isPdfFileTitle = (title: string): boolean =>
    stripFilePrefix(title).toLowerCase().endsWith('.pdf');

export const looksLikePdf = (bytes: Uint8Array): boolean => {
    if (bytes.length < 5) {
        return false;
    }
    // %PDF-
    return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
};

export const looksLikeHtml = (bytes: Uint8Array): boolean => {
    const sample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 512)).toLowerCase();
    return (
        sample.includes('<!doctype html') ||
        sample.includes('<html') ||
        sample.includes('bot check') ||
        sample.includes('friendlytest') ||
        sample.includes('disclaimer')
    );
};

export type DownloadFailureCode = 'bot_check' | 'disclaimer' | 'not_pdf' | 'too_large' | 'upstream';

export const classifyDownloadBody = (
    bytes: Uint8Array,
    contentType: string | null,
): { ok: true } | { ok: false; code: DownloadFailureCode } => {
    if (bytes.length > MAX_PDF_BYTES) {
        return { ok: false, code: 'too_large' };
    }
    if (looksLikePdf(bytes)) {
        return { ok: true };
    }
    const type = (contentType ?? '').toLowerCase();
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 2000)).toLowerCase();
    if (text.includes('bot check') || text.includes('friendlytest') || text.includes('mtcaptcha')) {
        return { ok: false, code: 'bot_check' };
    }
    if (text.includes('disclaimer') || text.includes('imslpdisclaimer')) {
        return { ok: false, code: 'disclaimer' };
    }
    if (type.includes('html') || looksLikeHtml(bytes)) {
        return { ok: false, code: 'bot_check' };
    }
    return { ok: false, code: 'not_pdf' };
};

const decodeHtmlEntities = (value: string): string =>
    value
        .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(Number(dec)))
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

/**
 * IMSLP's free-user "wait 15 seconds" page already embeds the real CDN URL in
 * `#sm_dl_wait[data-id]` — the timer only delays revealing it in the browser.
 */
export const extractCdnUrlFromWaitPage = (html: string): string | null => {
    const patterns = [
        /id=["']sm_dl_wait["'][^>]*data-id=["']([^"']+)["']/i,
        /data-id=["']([^"']+)["'][^>]*id=["']sm_dl_wait["']/i,
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) {
            const url = decodeHtmlEntities(match[1]).trim();
            if (/^https?:\/\//i.test(url) && /\.pdf(\?|#|$)/i.test(url)) {
                return url;
            }
        }
    }
    return null;
};

const fetchBytes = async (
    url: string,
    accept: string,
): Promise<{ bytes: Uint8Array; contentType: string | null; finalUrl: string }> => {
    const res = await fetch(url, {
        redirect: 'follow',
        headers: {
            'User-Agent': USER_AGENT,
            Accept: accept,
            Cookie: IMSLP_SESSION_COOKIES,
            Referer: `${IMSLP_ORIGIN}/`,
        },
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
        bytes,
        contentType: res.headers.get('content-type'),
        finalUrl: res.url,
    };
};

/**
 * Fully automated PDF fetch:
 * 1. Hit ImagefromIndex with disclaimer + redirectPassed cookies
 * 2. Parse the CDN URL from the wait page (no need to actually wait 15s)
 * 3. Download from the CDN mirror
 *
 * Falls back to imageinfo / ImagefromIndex direct URLs when the wait page isn't served.
 */
export const tryDownloadPdf = async (
    filename: string,
): Promise<
    | { ok: true; bytes: Uint8Array; filename: string }
    | { ok: false; code: DownloadFailureCode; openUrl: string; filename: string; message: string }
> => {
    const openUrl = imagefromIndexUrl(filename);
    const fail = (code: DownloadFailureCode, message: string) => ({
        ok: false as const,
        code,
        openUrl,
        filename,
        message,
    });

    const messages: Record<DownloadFailureCode, string> = {
        bot_check: 'IMSLP requires a browser verification before this file can download.',
        disclaimer: 'IMSLP showed a copyright disclaimer page instead of the PDF.',
        not_pdf: 'IMSLP did not return a PDF for this file.',
        too_large: `File is larger than ${MAX_PDF_BYTES / (1024 * 1024)} MB.`,
        upstream: 'Could not reach IMSLP to download this file.',
    };

    // Primary path: wait-page HTML → CDN URL (skips the cosmetic 15s timer).
    try {
        const page = await fetchBytes(openUrl, 'text/html,application/xhtml+xml,application/pdf,*/*');
        const direct = classifyDownloadBody(page.bytes, page.contentType);
        if (direct.ok) {
            return { ok: true, bytes: page.bytes, filename };
        }

        const html = new TextDecoder('utf-8', { fatal: false }).decode(page.bytes);
        if (html.toLowerCase().includes('bot check') || html.toLowerCase().includes('mtcaptcha')) {
            return fail('bot_check', messages.bot_check);
        }

        const cdnUrl = extractCdnUrlFromWaitPage(html);
        if (cdnUrl) {
            const pdf = await fetchBytes(cdnUrl, 'application/pdf,*/*');
            const classified = classifyDownloadBody(pdf.bytes, pdf.contentType);
            if (classified.ok) {
                return { ok: true, bytes: pdf.bytes, filename };
            }
            return fail(classified.code, messages[classified.code]);
        }
    } catch {
        // Fall through to legacy candidates.
    }

    // Legacy: MediaWiki imageinfo URL + ImagefromIndex (often blocked / disclaimer HTML).
    let imageUrl: string | null = null;
    try {
        const data = (await mwFetch({
            action: 'query',
            titles: `File:${filename}`,
            prop: 'imageinfo',
            iiprop: 'url|size|mime',
        })) as {
            query?: {
                pages?: Record<string, { imageinfo?: Array<{ url?: string; size?: number; mime?: string }> }>;
            };
        };
        const page = Object.values(data.query?.pages ?? {})[0];
        const info = page?.imageinfo?.[0];
        if (info?.size && info.size > MAX_PDF_BYTES) {
            return fail('too_large', messages.too_large);
        }
        if (info?.url) {
            imageUrl = info.url.startsWith('//') ? `https:${info.url}` : info.url;
        }
    } catch {
        // ignore
    }

    const candidates = [imageUrl, openUrl].filter((u): u is string => Boolean(u));
    let lastCode: DownloadFailureCode = 'upstream';
    for (const url of candidates) {
        try {
            const got = await fetchBytes(url, 'application/pdf,*/*');
            const classified = classifyDownloadBody(got.bytes, got.contentType);
            if (classified.ok) {
                return { ok: true, bytes: got.bytes, filename };
            }
            lastCode = classified.code;
        } catch {
            lastCode = 'upstream';
        }
    }

    return fail(lastCode, messages[lastCode]);
};
