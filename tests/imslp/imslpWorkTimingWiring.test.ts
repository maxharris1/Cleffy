import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('supabase/functions/imslp-work/index.ts', 'utf8');
const licenses = readFileSync('supabase/functions/_shared/imslpWorkLicenses.ts', 'utf8');

describe('imslp-work Server-Timing wiring', () => {
    it('serves through withServerTiming under the imslp-work name', () => {
        expect(source).toMatch(
            /Deno\.serve\(\s*withServerTiming<WorkSpan>\('imslp-work', async \(req, timing, fields\) =>/,
        );
    });

    it('times the rate limit before the body read', () => {
        const rl = source.indexOf("timing.time('rl', () => checkRateLimit(");
        expect(rl).toBeGreaterThan(0);
        expect(rl).toBeLessThan(source.indexOf('readCappedJson(req'));
    });

    it('times the work page fetch and every imageinfo batch', () => {
        expect(source).toContain("timing.time('mw_page', () => fetchWorkPageOrImages(title, mwFetch))");
        expect(source).toMatch(/timing\.time\('mw_imageinfo', \(\) =>\s+mwFetch\(\{\s+action: 'query',/);
    });

    it('hands timing to the shared resolveLicenses and no longer defines its own', () => {
        expect(source).toContain('{ admin: serviceClient(), fetchWorkPageHtml, timing }');
        expect(source).toContain("from '../_shared/imslpWorkLicenses.ts'");
        expect(source).not.toMatch(/const resolveLicenses\s*=/);
        expect(source).not.toContain('interface LicenseRow');
    });

    it('logs counts and the license source, never the titles', () => {
        expect(source).toContain('fields.pdfTitles = pdfTitles.length;');
        expect(source).toContain('fields.licenseSource = licenseSource;');
        expect(source).toContain('fields.imageinfoBatches = ++imageinfoBatches;');
        expect(source).not.toMatch(/fields\.\w+ = (pdfTitles|title|page|editions|body)\b(?!\.length)/);
    });

    it('times the cache read, the live parse and the cache write in that order', () => {
        const db = licenses.indexOf("io.timing.time('lic_db'");
        const parse = licenses.indexOf("io.timing.time('lic_parse'");
        const upsert = licenses.indexOf("io.timing.time('lic_upsert'");
        expect(db).toBeGreaterThan(0);
        expect(parse).toBeGreaterThan(db);
        expect(upsert).toBeGreaterThan(parse);
        expect(licenses).not.toContain("from './imslp.ts'");
    });
});
