/** Shared IMSLP MediaWiki helpers for Edge Functions. */

// Rate limiting moved to _shared/rateLimit.ts (matching the deployed split);
// re-exported so existing function imports keep working unchanged.
export { checkRateLimit, clientKey, serviceClient } from './rateLimit.ts';

export {
    IMSLP_ORIGIN,
    MAX_PDF_BYTES,
    USER_AGENT,
    classifyDownloadBody,
    extractCdnUrlFromWaitPage,
    imagefromIndexUrl,
    looksLikeHtml,
    looksLikePdf,
    type DownloadFailureCode,
    type DownloadResult,
} from './imslpDownload.ts';
import {
    IMSLP_ORIGIN,
    ImslpFetchError,
    USER_AGENT,
    parseRetryAfterSec,
    readBodyCapped,
    tryDownloadPdfWith,
    type DownloadResult,
    type MwFetchOptions,
} from './imslpDownload.ts';

export const IMSLP_API = `${IMSLP_ORIGIN}/api.php`;

/** Bound every MW call — a slow IMSLP must not hang the invocation to the worker wall-clock. */
const MW_TIMEOUT_MS = 10_000;
const MW_429_ATTEMPTS = 3;
/**
 * Largest API answer read. action=parse of the biggest work pages runs to a
 * few MB; anything past this is not a work page, and buffering it unbounded
 * would put the worker's memory at IMSLP's mercy.
 */
const MW_MAX_BYTES = 16 * 1024 * 1024;

/**
 * attempts: tries on timeout / 429 (default 3) — one for best-effort lookups
 * that must not stall a request, and for anything on the import path, where a
 * 429 must reach the caller (as ImslpFetchError 'rate_limited') rather than be
 * retried against a host that is throttling us.
 */
export type { MwFetchOptions };

const retryAfterMs = (res: Response): number => {
    const raw = res.headers.get('Retry-After');
    if (!raw) {
        return 2000;
    }
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(Math.max(seconds * 1000, 500), 30_000);
    }
    return 2000;
};

export const mwFetch = async (params: Record<string, string>, options: MwFetchOptions = {}): Promise<unknown> => {
    const attempts = Math.max(1, options.attempts ?? MW_429_ATTEMPTS);
    const timeoutMs = options.timeoutMs ?? MW_TIMEOUT_MS;
    const url = new URL(IMSLP_API);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }
    url.searchParams.set('format', 'json');

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let res: Response;
        try {
            res = await fetch(url.toString(), {
                headers: {
                    'User-Agent': USER_AGENT,
                    Accept: 'application/json',
                },
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            if (err instanceof DOMException && err.name === 'TimeoutError') {
                lastError = new Error('IMSLP API timeout', { cause: err });
                if (attempt < attempts) {
                    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
                    continue;
                }
                throw lastError;
            }
            throw err;
        }
        if (res.status === 429) {
            if (attempt < attempts) {
                await res.body?.cancel().catch(() => undefined);
                await new Promise((resolve) => setTimeout(resolve, retryAfterMs(res)));
                continue;
            }
            // Typed, so the download path can back the deployment off for as
            // long as IMSLP asked instead of reading this as a plain failure.
            await res.body?.cancel().catch(() => undefined);
            // The message is unchanged from the untyped error it replaces:
            // categorySync retries on /HTTP 429/ and records it as lastError.
            throw new ImslpFetchError('rate_limited', 'IMSLP API HTTP 429', {
                status: 429,
                retryAfterSec: parseRetryAfterSec(res.headers.get('Retry-After')),
            });
        }
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            throw new Error(`IMSLP API HTTP ${res.status}`);
        }
        const declared = Number(res.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > MW_MAX_BYTES) {
            await res.body?.cancel().catch(() => undefined);
            throw new Error('IMSLP API answer too large');
        }
        const payload: unknown = JSON.parse(new TextDecoder().decode(await readBodyCapped(res, MW_MAX_BYTES)));
        if (payload && typeof payload === 'object' && 'error' in payload) {
            const err = (payload as { error: unknown }).error;
            if (err) {
                const info =
                    typeof err === 'object' &&
                    err &&
                    'info' in err &&
                    typeof (err as { info: unknown }).info === 'string'
                        ? (err as { info: string }).info
                        : 'IMSLP API error';
                throw new Error(info);
            }
        }
        return payload;
    }
    throw lastError instanceof Error ? lastError : new Error('IMSLP API timeout');
};

export const workPageUrl = (title: string): string =>
    `${IMSLP_ORIGIN}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

export type WorkPageFetch =
    | { ok: true; html: string }
    /** IMSLP answered 429: it is throttling this egress IP. */
    | { ok: false; reason: 'rate_limited'; retryAfterSec: number | null }
    /** Timeout, API error, or no rendered text — the license is simply unknown. */
    | { ok: false; reason: 'unavailable' };

/**
 * Rendered work page HTML via action=parse — the only place IMSLP exposes
 * per-file license tags with their regional Non-PD flags. Never throws: a
 * throttled API is reported as such (the import path backs off on it), any
 * other failure as unavailable.
 */
export const fetchWorkPage = async (title: string, options: MwFetchOptions = {}): Promise<WorkPageFetch> => {
    try {
        const data = (await mwFetch({ action: 'parse', page: title, prop: 'text' }, options)) as {
            parse?: { text?: { '*'?: string } };
        };
        const html = data.parse?.text?.['*'];
        return typeof html === 'string' ? { ok: true, html } : { ok: false, reason: 'unavailable' };
    } catch (err) {
        if (err instanceof ImslpFetchError && err.code === 'rate_limited') {
            return { ok: false, reason: 'rate_limited', retryAfterSec: err.retryAfterSec };
        }
        return { ok: false, reason: 'unavailable' };
    }
};

/**
 * Work page HTML, or null on any failure so callers degrade to
 * license-unknown instead of failing the lookup.
 */
export const fetchWorkPageHtml = async (title: string, options: MwFetchOptions = {}): Promise<string | null> => {
    const page = await fetchWorkPage(title, options);
    return page.ok ? page.html : null;
};

export const parseComposerFromTitle = (title: string): string | null => {
    const match = title.match(/\(([^)]+)\)\s*$/);
    return match?.[1]?.trim() ?? null;
};

export const stripFilePrefix = (title: string): string => title.replace(/^File:/i, '');

export const isPdfFileTitle = (title: string): boolean => stripFilePrefix(title).toLowerCase().endsWith('.pdf');

/**
 * Fetch one IMSLP PDF (wait page → CDN, legacy fallbacks) under the bounds in
 * imslpDownload.ts. The pipeline lives there, import-free, so vitest can drive
 * it with a fake fetch.
 */
export const tryDownloadPdf = (filename: string): Promise<DownloadResult> => tryDownloadPdfWith(filename, { mwFetch });
