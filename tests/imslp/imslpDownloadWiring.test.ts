import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('supabase/functions/imslp-download/index.ts', 'utf8');

describe('IMSLP entry point security wiring', () => {
    it('checks anonymous/student and SQL insertion eligibility before cache reads or claims', () => {
        const cache = source.indexOf('flow = await withImslpPdfCache(');
        const auth = source.indexOf('if (isAnonymous || userType');
        const eligibility = source.indexOf("userClient.rpc('can_import_imslp')");
        const refusal = source.indexOf('if (canImport !== true)');
        expect(auth).toBeGreaterThan(0);
        expect(eligibility).toBeGreaterThan(auth);
        expect(refusal).toBeGreaterThan(eligibility);
        expect(refusal).toBeLessThan(cache);
    });

    it('requires fresh license clearance to skip pacing on a byte-cache hit', () => {
        expect(source).toContain('imslpCachedClearance(row)');
        expect(source).toContain('cache.entry && freshClearance');
        expect(source).toContain('const licenseFilename = cache.entry?.filename ?? canonicalFilename');
        expect(source).toContain('parseWorkPageLicenses(page.html).get(licenseFilename)');
        expect(source).not.toContain('downloadable: false');
    });

    it('turns typed validation failures into the open-on-IMSLP flow contract', () => {
        expect(source).toContain('error instanceof SharedPdfValidationError');
        expect(source).toContain("code: 'incomplete'");
        expect(source).toContain('openUrl: imagefromIndexUrl(canonicalFilename)');
    });

    it('keeps policy helpers out of RPC schemas and drops the unused import URL', () => {
        const config = readFileSync('supabase/config.toml', 'utf8');
        expect(config).toContain('schemas = ["public", "graphql_public"]');
        expect(config).not.toMatch(/schemas = .*imslp_private/);
        expect(source).not.toContain('createSignedUrl');
        expect(source).toContain('() => downloadQueued(30)');
    });
});
