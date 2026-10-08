/**
 * The IMSLP PDF fetch behind imslp-download: bounded, host-checked outbound
 * requests and the wait-page → CDN pipeline built on them.
 *
 * Every request IMSLP is asked for here is bounded three ways, because the
 * function runs on a shared egress IP and a paying user is waiting on it:
 * - time: an AbortSignal deadline covers headers AND body, and the whole
 *   pipeline shares one budget so a slow IMSLP cannot run the invocation into
 *   the platform's wall clock (the client gives up at its own timeout);
 * - size: Content-Length is checked before a byte is read, and the body is
 *   streamed against a running cap (a lying or absent length cannot make the
 *   worker buffer more than MAX_PDF_BYTES);
 * - destination: only https URLs on IMSLP's own hosts are fetched, including
 *   every redirect hop and the CDN URL scraped from IMSLP's HTML — the page is
 *   third-party content, and following it blindly would let it point a
 *   service-side fetch anywhere.
 * HTTP status is checked explicitly: 429 is IMSLP throttling us (the caller
 * backs the whole deployment off), 403 is a refusal the user can only get past
 * in a browser; neither is retried here.
 *
 * The disclaimer cookies and the wait-page parse are deliberately unchanged
 * from the original implementation (a legal decision on them is pending).
 *
 * NO imports — loaded by Deno (with the `.ts` extension) and by vitest
 * (without it), so the pipeline is testable with an injected fetch.
 */

export const IMSLP_ORIGIN = 'https://imslp.org';
/** Browser-like UA — IMSLP's friendly-redirect gate is stricter with bare bot UAs. */
export const USER_AGENT =
    'Mozilla/5.0 (compatible; Cleffy/1.0; +https://cleffy.app) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** Soft size cap — matches the private `scores` bucket limit. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** Cookies that skip IMSLP's JS redirect interstitial + disclaimer confirm. */
const IMSLP_SESSION_COOKIES = 'imslpdisclaimeraccepted=yes; imslp_wikiLanguageSelectorLanguage=en; redirectPassed=1';

/**
 * Hosts a download may be fetched from: imslp.org and its CDN/mirror nodes
 * (ks15.imslp.org, vmirror.imslp.org, cdn.imslp.org…), the legacy imslp.net
 * file servers, and the Petrucci Music Library mirrors IMSLP runs in Canada.
 * imslp.eu is absent on purpose: EU-hosted files are never directly
 * downloadable (isDownloadable) and the function runs US-side.
 */
const ALLOWED_HOST_SUFFIXES = ['imslp.org', 'imslp.net', 'petruccimusiclibrary.ca', 'imslp.simssa.ca'] as const;

/** True for an https URL on an IMSLP host, with no credentials and the default port. */
export const isAllowedImslpUrl = (raw: string): boolean => {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
        return false;
    }
    if (url.port && url.port !== '443') {
        return false;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

export type ImslpFetchFailure =
    /** The deadline passed before the body was complete. */
    | 'timeout'
    /** HTTP 403. */
    | 'forbidden'
    /** HTTP 429: IMSLP is throttling this egress IP. */
    | 'rate_limited'
    /** Any other non-2xx, or a redirect without a usable Location. */
    | 'http_error'
    /** Content-Length or the streamed body passed the cap. */
    | 'too_large'
    /** The URL (or a redirect hop) is not an https IMSLP URL. */
    | 'blocked_host'
    /** DNS / TLS / connection failure. */
    | 'network';

export class ImslpFetchError extends Error {
    readonly code: ImslpFetchFailure;
    readonly status: number | null;
    /** Seconds IMSLP asked us to wait (429 Retry-After), when it said. */
    readonly retryAfterSec: number | null;

    constructor(
        code: ImslpFetchFailure,
        message: string,
        detail: { status?: number | null; retryAfterSec?: number | null } = {},
    ) {
        super(message);
        this.name = 'ImslpFetchError';
        this.code = code;
        this.status = detail.status ?? null;
        this.retryAfterSec = detail.retryAfterSec ?? null;
    }
}

/** Longest Retry-After honoured from IMSLP; anything longer is clamped. */
export const MAX_RETRY_AFTER_SEC = 900;

/** Retry-After as whole seconds (delta-seconds or HTTP-date), clamped to [1, MAX]; null when absent/garbage. */
export const parseRetryAfterSec = (raw: string | null, nowMs = Date.now()): number | null => {
    if (!raw) {
        return null;
    }
    const trimmed = raw.trim();
    let seconds: number;
    if (/^\d+$/.test(trimmed)) {
        seconds = Number(trimmed);
    } else {
        const at = Date.parse(trimmed);
        if (!Number.isFinite(at)) {
            return null;
        }
        seconds = Math.ceil((at - nowMs) / 1000);
    }
    return Math.min(MAX_RETRY_AFTER_SEC, Math.max(1, seconds));
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export interface BoundedFetchOptions {
    accept: string;
    /** Hard cap on body bytes. */
    maxBytes: number;
    /** Deadline for the whole exchange: every redirect hop, headers and body. */
    timeoutMs: number;
    fetchImpl?: typeof fetch;
}

export interface BoundedFetchResult {
    bytes: Uint8Array;
    contentType: string | null;
    finalUrl: string;
}

const discardBody = async (res: Response): Promise<void> => {
    try {
        await res.body?.cancel();
    } catch {
        // already closed
    }
};

const isAbort = (err: unknown): boolean =>
    err instanceof DOMException
        ? err.name === 'TimeoutError' || err.name === 'AbortError'
        : err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

/** Read a body, throwing ImslpFetchError('too_large') past `maxBytes` whatever Content-Length said. */
export const readBodyCapped = async (res: Response, maxBytes: number): Promise<Uint8Array> => {
    const reader = res.body?.getReader();
    if (!reader) {
        return new Uint8Array(0);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (!value) {
            continue;
        }
        size += value.byteLength;
        if (size > maxBytes) {
            try {
                await reader.cancel();
            } catch {
                // already closed
            }
            throw new ImslpFetchError('too_large', `IMSLP response exceeded ${maxBytes} bytes`);
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
};

/**
 * GET an IMSLP URL under the time/size/host bounds above. Redirects are
 * followed by hand (redirect: 'manual') so each hop is host-checked before it
 * is requested. Throws ImslpFetchError for every failure.
 */
export const fetchImslpBytes = async (url: string, options: BoundedFetchOptions): Promise<BoundedFetchResult> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const signal = AbortSignal.timeout(Math.max(1, options.timeoutMs));
    let current = url;
    try {
        for (let hop = 0; ; hop++) {
            if (!isAllowedImslpUrl(current)) {
                throw new ImslpFetchError('blocked_host', 'Refusing to fetch a non-IMSLP URL');
            }
            let res: Response;
            try {
                res = await fetchImpl(current, {
                    redirect: 'manual',
                    headers: {
                        'User-Agent': USER_AGENT,
                        Accept: options.accept,
                        Cookie: IMSLP_SESSION_COOKIES,
                        Referer: `${IMSLP_ORIGIN}/`,
                    },
                    signal,
                });
            } catch (err) {
                if (err instanceof ImslpFetchError) {
                    throw err;
                }
                if (signal.aborted || isAbort(err)) {
                    throw new ImslpFetchError('timeout', 'IMSLP did not answer in time');
                }
                throw new ImslpFetchError('network', 'Could not reach IMSLP');
            }

            if (REDIRECT_STATUSES.has(res.status)) {
                const location = res.headers.get('location');
                await discardBody(res);
                if (!location || hop >= MAX_REDIRECTS) {
                    throw new ImslpFetchError('http_error', 'IMSLP redirected without a usable target', {
                        status: res.status,
                    });
                }
                current = new URL(location, current).toString();
                continue;
            }
            if (res.status === 429) {
                await discardBody(res);
                throw new ImslpFetchError('rate_limited', 'IMSLP is rate limiting downloads', {
                    status: 429,
                    retryAfterSec: parseRetryAfterSec(res.headers.get('retry-after')),
                });
            }
            if (res.status === 403) {
                await discardBody(res);
                throw new ImslpFetchError('forbidden', 'IMSLP refused this download', { status: 403 });
            }
            if (!res.ok) {
                await discardBody(res);
                throw new ImslpFetchError('http_error', `IMSLP answered HTTP ${res.status}`, { status: res.status });
            }

            const declared = Number(res.headers.get('content-length') ?? '');
            if (Number.isFinite(declared) && declared > options.maxBytes) {
                await discardBody(res);
                throw new ImslpFetchError('too_large', `IMSLP file is ${declared} bytes`, { status: res.status });
            }
            const bytes = await readBodyCapped(res, options.maxBytes);
            return { bytes, contentType: res.headers.get('content-type'), finalUrl: current };
        }
    } catch (err) {
        if (err instanceof ImslpFetchError) {
            throw err;
        }
        // A deadline that fires mid-body surfaces from reader.read().
        if (signal.aborted || isAbort(err)) {
            throw new ImslpFetchError('timeout', 'IMSLP did not answer in time');
        }
        throw new ImslpFetchError('network', 'Could not reach IMSLP');
    }
};

export const imagefromIndexUrl = (filename: string): string =>
    `${IMSLP_ORIGIN}/wiki/Special:ImagefromIndex/${encodeURIComponent(filename)}`;

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

export type DownloadFailureCode =
    | 'bot_check'
    | 'disclaimer'
    | 'not_pdf'
    | 'too_large'
    | 'upstream'
    /** IMSLP answered 403. */
    | 'forbidden'
    /** IMSLP did not deliver the file within the download budget. */
    | 'timeout'
    /** IMSLP answered 429 — the caller backs the deployment off and the client retries. */
    | 'rate_limited';

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
 * The URL is third-party HTML: only an https IMSLP host is returned, so a
 * tampered or unexpected page cannot aim the service-side fetch elsewhere.
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
            if (/^https?:\/\//i.test(url) && /\.pdf(\?|#|$)/i.test(url) && isAllowedImslpUrl(url)) {
                return url;
            }
        }
    }
    return null;
};

/** Wall-clock budget for one whole download attempt (every request in the pipeline). */
export const DOWNLOAD_BUDGET_MS = 90_000;
/** One HTML page (ImagefromIndex / the wait page). */
const PAGE_TIMEOUT_MS = 20_000;
/** One PDF transfer: up to 50 MB from IMSLP's CDN. */
const PDF_TIMEOUT_MS = 60_000;

export type MwFetch = (params: Record<string, string>) => Promise<unknown>;

export interface DownloadDeps {
    /** MediaWiki API call (imslp.ts mwFetch) for the imageinfo fallback. */
    mwFetch: MwFetch;
    fetchImpl?: typeof fetch;
    budgetMs?: number;
    now?: () => number;
}

export type DownloadResult =
    | { ok: true; bytes: Uint8Array; filename: string }
    | {
          ok: false;
          code: DownloadFailureCode;
          openUrl: string;
          filename: string;
          message: string;
          /** Set with code 'rate_limited': how long IMSLP asked us to back off. */
          retryAfterSec?: number | null;
      };

const FAILURE_MESSAGES: Record<DownloadFailureCode, string> = {
    bot_check: 'IMSLP requires a browser verification before this file can download.',
    disclaimer: 'IMSLP showed a copyright disclaimer page instead of the PDF.',
    not_pdf: 'IMSLP did not return a PDF for this file.',
    too_large: `File is larger than ${MAX_PDF_BYTES / (1024 * 1024)} MB.`,
    upstream: 'Could not reach IMSLP to download this file.',
    forbidden: 'IMSLP refused to serve this file to Cleffy.',
    timeout: 'IMSLP took too long to send this file.',
    rate_limited: 'IMSLP is busy right now.',
};

/** The DownloadFailureCode a fetch failure reports to the user. */
const codeForFetchFailure = (failure: ImslpFetchFailure): DownloadFailureCode => {
    switch (failure) {
        case 'timeout':
            return 'timeout';
        case 'forbidden':
            return 'forbidden';
        case 'rate_limited':
            return 'rate_limited';
        case 'too_large':
            return 'too_large';
        case 'http_error':
        case 'blocked_host':
        case 'network':
            return 'upstream';
        default: {
            const _exhaustive: never = failure;
            return _exhaustive;
        }
    }
};

/** Failures that end the attempt at once: more requests would not help, or would hurt. */
const isTerminal = (code: DownloadFailureCode): boolean =>
    code === 'rate_limited' || code === 'too_large' || code === 'timeout';

/**
 * Fully automated PDF fetch:
 * 1. Hit ImagefromIndex with disclaimer + redirectPassed cookies
 * 2. Parse the CDN URL from the wait page (no need to actually wait 15s)
 * 3. Download from the CDN mirror
 *
 * Falls back to imageinfo / ImagefromIndex direct URLs when the wait page isn't
 * served — but never after IMSLP said 429 (hammering a throttled host is how an
 * IP gets banned), a file proved too large, or the budget ran out.
 */
export const tryDownloadPdfWith = async (filename: string, deps: DownloadDeps): Promise<DownloadResult> => {
    const now = deps.now ?? Date.now;
    const deadline = now() + (deps.budgetMs ?? DOWNLOAD_BUDGET_MS);
    const remaining = () => deadline - now();
    const openUrl = imagefromIndexUrl(filename);
    let retryAfterSec: number | null = null;
    const fail = (code: DownloadFailureCode): DownloadResult => ({
        ok: false,
        code,
        openUrl,
        filename,
        message: FAILURE_MESSAGES[code],
        ...(code === 'rate_limited' ? { retryAfterSec } : {}),
    });
    const fetchWithin = async (url: string, accept: string, capMs: number): Promise<BoundedFetchResult> => {
        const left = remaining();
        if (left <= 0) {
            throw new ImslpFetchError('timeout', 'Download budget exhausted');
        }
        return fetchImslpBytes(url, {
            accept,
            maxBytes: MAX_PDF_BYTES,
            timeoutMs: Math.min(capMs, left),
            fetchImpl: deps.fetchImpl,
        });
    };
    const failureFrom = (err: unknown): DownloadFailureCode => {
        if (err instanceof ImslpFetchError) {
            if (err.code === 'rate_limited') {
                retryAfterSec = err.retryAfterSec;
            }
            return codeForFetchFailure(err.code);
        }
        return 'upstream';
    };

    // Primary path: wait-page HTML → CDN URL (skips the cosmetic 15s timer).
    let lastCode: DownloadFailureCode = 'upstream';
    try {
        const page = await fetchWithin(openUrl, 'text/html,application/xhtml+xml,application/pdf,*/*', PAGE_TIMEOUT_MS);
        const direct = classifyDownloadBody(page.bytes, page.contentType);
        if (direct.ok) {
            return { ok: true, bytes: page.bytes, filename };
        }

        const html = new TextDecoder('utf-8', { fatal: false }).decode(page.bytes);
        if (html.toLowerCase().includes('bot check') || html.toLowerCase().includes('mtcaptcha')) {
            return fail('bot_check');
        }

        const cdnUrl = extractCdnUrlFromWaitPage(html);
        if (cdnUrl) {
            const pdf = await fetchWithin(cdnUrl, 'application/pdf,*/*', PDF_TIMEOUT_MS);
            const classified = classifyDownloadBody(pdf.bytes, pdf.contentType);
            if (classified.ok) {
                return { ok: true, bytes: pdf.bytes, filename };
            }
            return fail(classified.code);
        }
    } catch (err) {
        lastCode = failureFrom(err);
        if (isTerminal(lastCode)) {
            return fail(lastCode);
        }
        // Otherwise fall through to the legacy candidates.
    }

    // Legacy: MediaWiki imageinfo URL + ImagefromIndex (often blocked / disclaimer HTML).
    let imageUrl: string | null = null;
    if (remaining() > 0) {
        try {
            const data = (await deps.mwFetch({
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
                return fail('too_large');
            }
            if (info?.url) {
                const candidate = info.url.startsWith('//') ? `https:${info.url}` : info.url;
                // Same host rule as the scraped CDN URL: the API answer is IMSLP's,
                // but a plain-http or off-site URL is still not fetched.
                imageUrl = isAllowedImslpUrl(candidate) ? candidate : null;
            }
        } catch {
            // ignore
        }
    }

    const candidates = [imageUrl, openUrl].filter((u): u is string => Boolean(u));
    for (const url of candidates) {
        try {
            const got = await fetchWithin(url, 'application/pdf,*/*', PDF_TIMEOUT_MS);
            const classified = classifyDownloadBody(got.bytes, got.contentType);
            if (classified.ok) {
                return { ok: true, bytes: got.bytes, filename };
            }
            lastCode = classified.code;
        } catch (err) {
            lastCode = failureFrom(err);
            if (isTerminal(lastCode)) {
                return fail(lastCode);
            }
        }
    }

    return fail(lastCode);
};
