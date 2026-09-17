import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyImslpResponse, nextImslpDownloadStep, retryAfterMs } from '../../scripts/playalong-corpus.mjs';
import {
    classifyDownloadBody,
    extractCdnUrlFromWaitPage,
    looksLikePdf,
} from '../../supabase/functions/_shared/imslpWaitPage';

/**
 * Wait-page → CDN parse used by live `tryDownloadPdf` and the corpus seed.
 * Fixtures only — no imslp.org fetch.
 */
const waitPage = (url: string, attrOrder: 'id-first' | 'data-first' = 'id-first'): string => {
    const attrs = attrOrder === 'id-first' ? `id="sm_dl_wait" data-id="${url}"` : `data-id="${url}" id="sm_dl_wait"`;
    return `<!doctype html><html><body><div ${attrs}>Please wait 15 seconds</div></body></html>`;
};

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const pdfBytes = (): Uint8Array => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

describe('extractCdnUrlFromWaitPage', () => {
    it('is re-exported from the live Edge helper without changing tryDownloadPdf', () => {
        const imslpTs = readFileSync(resolve(process.cwd(), 'supabase/functions/_shared/imslp.ts'), 'utf8');
        expect(imslpTs).toContain("from './imslpWaitPage.ts'");
        expect(imslpTs).toContain('extractCdnUrlFromWaitPage');
        expect(imslpTs).toContain('export const tryDownloadPdf');
    });

    it('reads sm_dl_wait[data-id] in either attribute order and decodes entities', () => {
        const url = 'https://cdn.imslp.org/files/imglnks/usimg/0/0a/PMLP123-score.pdf';
        expect(extractCdnUrlFromWaitPage(waitPage(url))).toBe(url);
        expect(extractCdnUrlFromWaitPage(waitPage(url, 'data-first'))).toBe(url);
        expect(
            extractCdnUrlFromWaitPage(
                `<span id="sm_dl_wait" data-id="https://cdn.example.org/a.pdf?x=1&amp;y=2"></span>`,
            ),
        ).toBe('https://cdn.example.org/a.pdf?x=1&y=2');
        expect(extractCdnUrlFromWaitPage('<div id="sm_dl_wait" data-id="/relative.pdf"></div>')).toBeNull();
        expect(
            extractCdnUrlFromWaitPage('<div id="sm_dl_wait" data-id="https://x.example/not-a-score"></div>'),
        ).toBeNull();
        expect(extractCdnUrlFromWaitPage('<p>no wait widget</p>')).toBeNull();
    });
});

describe('nextImslpDownloadStep', () => {
    it('accepts a PDF immediately, parses the wait page, and circuits on bot check', () => {
        expect(looksLikePdf(pdfBytes())).toBe(true);
        expect(nextImslpDownloadStep(pdfBytes())).toEqual({ action: 'accept' });

        const cdn = 'https://cdn.imslp.org/files/imglnks/usimg/1/11/score.pdf';
        expect(nextImslpDownloadStep(bytesOf(waitPage(cdn)))).toEqual({ action: 'cdn', url: cdn });

        expect(nextImslpDownloadStep(bytesOf('<html><title>IMSLP - Bot Check</title><p>mtcaptcha</p></html>'))).toEqual(
            { action: 'circuit', code: 'bot_check' },
        );
        expect(nextImslpDownloadStep(bytesOf('<html>friendlytest bot wall</html>'))).toEqual({
            action: 'circuit',
            code: 'bot_check',
        });
        expect(nextImslpDownloadStep(bytesOf('<html>imslpdisclaimer copyright</html>'))).toEqual({
            action: 'fail',
            code: 'disclaimer',
        });
        expect(nextImslpDownloadStep(bytesOf('<html>no pdf here</html>'))).toEqual({
            action: 'fail',
            code: 'not_pdf',
        });
        const rippingBan =
            '<html>You have reached this message because the site ripping ban script has been triggered. Site ripping is forbidden. Please do not reload this page often, because every reload refreshes the ban length.</html>';
        expect(nextImslpDownloadStep(bytesOf(rippingBan))).toEqual({
            action: 'circuit',
            code: 'ripping_ban',
        });
        expect(classifyImslpResponse(403, bytesOf(rippingBan))).toEqual({
            action: 'circuit',
            code: 'ripping_ban',
        });
        // Live classifyDownloadBody is unchanged: ripping-ban HTML is still a bot wall there.
        expect(classifyDownloadBody(bytesOf(rippingBan), 'text/html; charset=UTF-8')).toEqual({
            ok: false,
            code: 'bot_check',
        });
    });

    it('honours Retry-After in full (seconds or HTTP date); only a missing header falls back', () => {
        expect(retryAfterMs(null)).toBe(30_000);
        expect(retryAfterMs('0')).toBe(500);
        expect(retryAfterMs('5')).toBe(5000);
        expect(retryAfterMs('120')).toBe(120_000);
        expect(retryAfterMs('900')).toBe(900_000);
        expect(retryAfterMs(new Date(5_000_000).toUTCString(), { now: 4_000_000 })).toBe(1_000_000);
        expect(retryAfterMs('nope')).toBe(30_000);
    });
});
