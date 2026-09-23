/**
 * IMSLP wait-page → CDN URL parse, shared by the live Edge download and the
 * corpus seed. The free-user "wait 15 seconds" page already embeds the real
 * file URL in `#sm_dl_wait[data-id]`; the timer only delays revealing it in
 * the browser. Callers fetch the wait page, parse, then GET the CDN URL.
 *
 * No Deno / network imports — Node (seed) and Edge (imslp-download) both load
 * this file. Production `tryDownloadPdf` behaviour is unchanged: it still
 * lives in `_shared/imslp.ts` and re-exports these helpers.
 */

/** Soft size cap — matches the private `scores` / `pd-pdfs` bucket limit. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

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
