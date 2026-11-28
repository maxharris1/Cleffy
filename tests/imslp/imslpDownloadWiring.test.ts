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

    it('times the pre-flow checks in order and wraps the flow deps through the span table', () => {
        const order = [
            "timing.time('rl_ip', () =>",
            'checkRateLimit(`download:${clientKey(req)}`',
            "timing.time('auth', () => requireUser(req))",
            "timing.time('elig_rl_del', () =>\n        userClient.rpc('can_import_imslp')",
            "timing.time('elig_rl_del', () =>\n        checkRateLimit(`download:user:${userId}`",
            "timing.time('elig_rl_del', () => accountDeletionPending(admin, userId))",
            'timedCacheDeps(timing, imslpPdfCacheStore(admin))',
            'fields.cacheHit = cache.entry !== null',
            'timedImportDeps(timing, fields, {',
        ].map((needle) => source.indexOf(needle));
        expect(order.every((at) => at > 0)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(source).toContain('const fields = downloadFields(telemetry);');
        expect(source).toContain('tryDownloadPdf(canonicalFilename, (phase, run) =>');
        expect(source).toContain("timing.time('imslp_credits', () =>");
        expect(source).toContain("Deno.serve(withServerTiming('imslp-download', handle));");
    });

    it('keeps policy helpers out of RPC schemas and drops the unused import URL', () => {
        const config = readFileSync('supabase/config.toml', 'utf8');
        expect(config).toContain('schemas = ["public", "graphql_public"]');
        expect(config).not.toMatch(/schemas = .*imslp_private/);
        expect(source).not.toContain('createSignedUrl');
        expect(source).toContain('() => downloadQueued(30)');
    });
});
