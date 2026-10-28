import { describe, expect, it } from 'vitest';

import { DEMO_DOC_ID, DEMO_PDF_REQUEST_URL, DEMO_PDF_URL, DEMO_SCORE_CACHE_PATTERN } from '@/features/demo/demoScore';
import { isCloudDocId } from '@/sync/docIds';

/** Workbox tests a route's RegExp against the request's full URL. */
const href = (path: string) => new URL(path, 'https://cleffy.io').href;

describe('demo score', () => {
    it('is a local doc id, never a cloud one', () => {
        expect(DEMO_DOC_ID.startsWith('local-')).toBe(true);
        expect(isCloudDocId(DEMO_DOC_ID)).toBe(false);
    });

    it('is requested at a URL the service worker’s demo-score route caches, versioned by the doc id', () => {
        expect(DEMO_PDF_REQUEST_URL.startsWith(`${DEMO_PDF_URL}?`)).toBe(true);
        expect(new URL(href(DEMO_PDF_REQUEST_URL)).searchParams.get('v')).toBe(DEMO_DOC_ID);
        expect(DEMO_SCORE_CACHE_PATTERN.test(href(DEMO_PDF_REQUEST_URL))).toBe(true);
    });

    it('caches nothing but the demo PDFs', () => {
        for (const path of [
            '/try',
            '/try?utm_source=tiktok',
            '/demo/fur-elise.html',
            '/demo/fur-elise.pdf.js',
            '/doc/local-demo-v1',
        ]) {
            expect(DEMO_SCORE_CACHE_PATTERN.test(href(path)), path).toBe(false);
        }
    });
});
