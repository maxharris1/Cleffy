import { describe, expect, it, vi } from 'vitest';

import {
    MAX_PDF_BYTES,
    ImslpFetchError,
    extractCdnUrlFromWaitPage,
    fetchImslpBytes,
    isAllowedImslpUrl,
    parseRetryAfterSec,
    tryDownloadPdfWith,
} from '../../supabase/functions/_shared/imslpDownload';

const PDF = new TextEncoder().encode('%PDF-1.4 tiny');
const CDN = 'https://ks15.imslp.org/files/imglnks/usimg/0/07/IMSLP51037-PMLP01458-Op.27-2_Manuscript.pdf';
const waitPage = (url: string) =>
    `<!DOCTYPE html><html><body><span id="sm_dl_wait" data-id="${url}">Please wait 15 seconds</span></body></html>`;

const pdfResponse = (bytes = PDF, headers: Record<string, string> = {}) =>
    new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf', ...headers } });
const htmlResponse = (html: string) => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });

/** A body that never ends — for exercising the deadline mid-transfer. */
const hangingBody = (signal: AbortSignal | null | undefined) =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('%PDF-1.4 '));
            signal?.addEventListener('abort', () => controller.error(signal.reason));
        },
    });

const errorOf = async (promise: Promise<unknown>): Promise<ImslpFetchError> => {
    try {
        await promise;
    } catch (err) {
        if (err instanceof ImslpFetchError) {
            return err;
        }
        throw err;
    }
    throw new Error('expected an ImslpFetchError');
};

describe('isAllowedImslpUrl', () => {
    it('accepts https on imslp.org and its CDN / mirror hosts', () => {
        expect(isAllowedImslpUrl('https://imslp.org/wiki/Special:ImagefromIndex/a.pdf')).toBe(true);
        expect(isAllowedImslpUrl(CDN)).toBe(true);
        expect(isAllowedImslpUrl('https://vmirror.imslp.org/files/a.pdf')).toBe(true);
        expect(isAllowedImslpUrl('https://ks.imslp.net/files/a.pdf')).toBe(true);
        expect(isAllowedImslpUrl('https://petruccimusiclibrary.ca/files/a.pdf')).toBe(true);
        expect(isAllowedImslpUrl('https://imslp.simssa.ca/files/a.pdf')).toBe(true);
    });

    it('refuses plain http, other hosts, look-alikes, credentials and odd ports', () => {
        expect(isAllowedImslpUrl('http://imslp.org/a.pdf')).toBe(false);
        expect(isAllowedImslpUrl('https://evil.example/a.pdf')).toBe(false);
        expect(isAllowedImslpUrl('https://imslp.org.evil.example/a.pdf')).toBe(false);
        expect(isAllowedImslpUrl('https://notimslp.org/a.pdf')).toBe(false);
        expect(isAllowedImslpUrl('https://user:pw@imslp.org/a.pdf')).toBe(false);
        expect(isAllowedImslpUrl('https://imslp.org:8443/a.pdf')).toBe(false);
        expect(isAllowedImslpUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
        expect(isAllowedImslpUrl('https://imslp.eu/files/a.pdf')).toBe(false);
        expect(isAllowedImslpUrl('not a url')).toBe(false);
    });
});

describe('extractCdnUrlFromWaitPage', () => {
    it('returns the IMSLP CDN URL from the wait page', () => {
        expect(extractCdnUrlFromWaitPage(waitPage(CDN))).toBe(CDN);
    });

    it('ignores a wait page that points off IMSLP or at plain http', () => {
        expect(extractCdnUrlFromWaitPage(waitPage('https://evil.example/score.pdf'))).toBeNull();
        expect(extractCdnUrlFromWaitPage(waitPage('http://ks15.imslp.org/files/score.pdf'))).toBeNull();
    });
});

describe('parseRetryAfterSec', () => {
    it('reads seconds and HTTP dates, clamped', () => {
        expect(parseRetryAfterSec('30')).toBe(30);
        expect(parseRetryAfterSec('0')).toBe(1);
        expect(parseRetryAfterSec('999999')).toBe(900);
        const now = Date.parse('2026-10-08T00:00:00Z');
        expect(parseRetryAfterSec('Thu, 08 Oct 2026 00:01:00 GMT', now)).toBe(60);
        expect(parseRetryAfterSec(null)).toBeNull();
        expect(parseRetryAfterSec('soon')).toBeNull();
    });
});

describe('fetchImslpBytes', () => {
    const opts = { accept: 'application/pdf', maxBytes: 1024, timeoutMs: 5_000 };

    it('returns the body of a 200', async () => {
        const fetchImpl = vi.fn(async () => pdfResponse());
        const got = await fetchImslpBytes(CDN, { ...opts, fetchImpl });
        expect(new TextDecoder().decode(got.bytes)).toBe('%PDF-1.4 tiny');
        expect(got.finalUrl).toBe(CDN);
        const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
        expect(init.redirect).toBe('manual');
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('never requests a non-IMSLP URL', async () => {
        const fetchImpl = vi.fn(async () => pdfResponse());
        const err = await errorOf(fetchImslpBytes('https://evil.example/a.pdf', { ...opts, fetchImpl }));
        expect(err.code).toBe('blocked_host');
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('follows an IMSLP redirect but refuses one that leaves IMSLP', async () => {
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: CDN } }))
            .mockResolvedValueOnce(pdfResponse());
        const got = await fetchImslpBytes('https://imslp.org/wiki/Special:ImagefromIndex/a.pdf', {
            ...opts,
            fetchImpl,
        });
        expect(got.finalUrl).toBe(CDN);

        const offsite = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/internal' } }),
            );
        const err = await errorOf(
            fetchImslpBytes('https://imslp.org/wiki/Special:ImagefromIndex/a.pdf', { ...opts, fetchImpl: offsite }),
        );
        expect(err.code).toBe('blocked_host');
        expect(offsite).toHaveBeenCalledTimes(1);
    });

    it('stops after too many redirects', async () => {
        const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: CDN } }));
        const err = await errorOf(fetchImslpBytes(CDN, { ...opts, fetchImpl }));
        expect(err.code).toBe('http_error');
        expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(6);
    });

    it('maps 429 (with Retry-After) and 403 to distinct failures', async () => {
        const throttled = await errorOf(
            fetchImslpBytes(CDN, {
                ...opts,
                fetchImpl: async () => new Response('slow down', { status: 429, headers: { 'retry-after': '120' } }),
            }),
        );
        expect(throttled.code).toBe('rate_limited');
        expect(throttled.retryAfterSec).toBe(120);

        const forbidden = await errorOf(
            fetchImslpBytes(CDN, { ...opts, fetchImpl: async () => new Response('no', { status: 403 }) }),
        );
        expect(forbidden.code).toBe('forbidden');

        const broken = await errorOf(
            fetchImslpBytes(CDN, { ...opts, fetchImpl: async () => new Response('oops', { status: 503 }) }),
        );
        expect(broken.code).toBe('http_error');
        expect(broken.status).toBe(503);
    });

    it('refuses an oversized Content-Length before reading the body', async () => {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ cancel });
        const err = await errorOf(
            fetchImslpBytes(CDN, {
                ...opts,
                fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-length': '4096' } }),
            }),
        );
        expect(err.code).toBe('too_large');
        expect(cancel).toHaveBeenCalled();
    });

    it('caps a body whose length was absent or a lie', async () => {
        const big = new Uint8Array(4096).fill(0x25);
        const err = await errorOf(
            fetchImslpBytes(CDN, {
                ...opts,
                fetchImpl: async () => new Response(big, { status: 200, headers: { 'content-length': '10' } }),
            }),
        );
        expect(err.code).toBe('too_large');
    });

    it('times out a transfer that stalls mid-body', async () => {
        const err = await errorOf(
            fetchImslpBytes(CDN, {
                ...opts,
                timeoutMs: 30,
                fetchImpl: async (_url, init) => new Response(hangingBody(init?.signal), { status: 200 }),
            }),
        );
        expect(err.code).toBe('timeout');
    });

    it('reports a connection failure as network', async () => {
        const err = await errorOf(
            fetchImslpBytes(CDN, {
                ...opts,
                fetchImpl: async () => {
                    throw new TypeError('connection reset');
                },
            }),
        );
        expect(err.code).toBe('network');
    });
});

describe('tryDownloadPdfWith', () => {
    const mwFetch = vi.fn(async () => ({ query: { pages: {} } }));

    it('downloads through the wait page', async () => {
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(htmlResponse(waitPage(CDN)))
            .mockResolvedValueOnce(pdfResponse());
        const result = await tryDownloadPdfWith('a.pdf', { mwFetch, fetchImpl });
        expect(result.ok).toBe(true);
        expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
            'https://imslp.org/wiki/Special:ImagefromIndex/a.pdf',
            CDN,
        ]);
    });

    it('never fetches a CDN URL the wait page points off IMSLP', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse(waitPage('https://evil.example/a.pdf')));
        const result = await tryDownloadPdfWith('a.pdf', { mwFetch, fetchImpl });
        expect(result.ok).toBe(false);
        expect(fetchImpl.mock.calls.map((c) => String(c[0])).some((u) => u.includes('evil.example'))).toBe(false);
    });

    it('stops at the first 429 and reports how long IMSLP asked us to wait', async () => {
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '45' } }));
        mwFetch.mockClear();
        const result = await tryDownloadPdfWith('a.pdf', { mwFetch, fetchImpl });
        expect(result).toMatchObject({ ok: false, code: 'rate_limited', retryAfterSec: 45 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        // No legacy fallbacks against a throttled host.
        expect(mwFetch).not.toHaveBeenCalled();
    });

    it('reports a 403 as forbidden with the open-on-IMSLP URL', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 }));
        const result = await tryDownloadPdfWith('a.pdf', { mwFetch, fetchImpl });
        expect(result).toMatchObject({
            ok: false,
            code: 'forbidden',
            openUrl: 'https://imslp.org/wiki/Special:ImagefromIndex/a.pdf',
        });
    });

    it('refuses an oversized CDN file without downloading it', async () => {
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(htmlResponse(waitPage(CDN)))
            .mockResolvedValueOnce(
                new Response(new ReadableStream(), {
                    status: 200,
                    headers: { 'content-length': String(MAX_PDF_BYTES + 1) },
                }),
            );
        const result = await tryDownloadPdfWith('a.pdf', { mwFetch, fetchImpl });
        expect(result).toMatchObject({ ok: false, code: 'too_large' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('gives up as timeout once the shared budget is spent', async () => {
        let clock = 0;
        const fetchImpl = vi.fn<typeof fetch>(async () => {
            clock += 60_000;
            return htmlResponse('<html>no wait page here</html>');
        });
        const result = await tryDownloadPdfWith('a.pdf', {
            mwFetch,
            fetchImpl,
            budgetMs: 90_000,
            now: () => clock,
        });
        expect(result.ok).toBe(false);
        // Page (60 s) + one fallback candidate (60 s) spend the 90 s budget; no third request.
        expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it('skips an imageinfo URL that is not an https IMSLP URL', async () => {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse('<html>bot check</html>'));
        const legacyMw = vi.fn(async () => ({
            query: { pages: { '1': { imageinfo: [{ url: 'http://evil.example/a.pdf', size: 10 }] } } },
        }));
        // First response is a bot check → returned at once; force the legacy path with a plain page instead.
        fetchImpl.mockResolvedValueOnce(htmlResponse('<html>nothing</html>'));
        await tryDownloadPdfWith('a.pdf', { mwFetch: legacyMw, fetchImpl });
        expect(fetchImpl.mock.calls.map((c) => String(c[0])).some((u) => u.includes('evil.example'))).toBe(false);
    });
});
