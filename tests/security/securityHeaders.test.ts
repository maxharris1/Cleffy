import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guards for the production response headers in vercel.json.
 *
 * The policy is verified for real by scripts/csp-smoke.mjs (built app, real
 * Chromium, zero violations). That needs a build and a browser, so it is not in
 * CI; these are the cheap invariants that catch the usual ways a CSP rots:
 * a new Supabase project the policy does not name, an inline script or style
 * that only the production header would block, or a "temporary" unsafe-* that
 * never leaves.
 *
 * Resolved from the project root: the jsdom environment gives import.meta a
 * non-file URL (see tests/applyMigrationsInSync.test.ts).
 */
const read = (...segments: string[]): string => readFileSync(resolve(process.cwd(), ...segments), 'utf8');

interface VercelConfig {
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
}

const vercel = JSON.parse(read('vercel.json')) as VercelConfig;

/** The headers every path gets. */
const globalHeaders = (): Map<string, string> => {
    const rule = vercel.headers.find((r) => r.source === '/(.*)');
    if (!rule) {
        throw new Error('vercel.json has no catch-all header rule');
    }
    return new Map(rule.headers.map(({ key, value }) => [key.toLowerCase(), value]));
};

const csp = (): Map<string, string[]> => {
    const value = globalHeaders().get('content-security-policy');
    if (!value) {
        throw new Error('vercel.json sends no Content-Security-Policy');
    }
    return new Map(
        value
            .split(';')
            .map((part) => part.trim().split(/\s+/))
            .filter((tokens) => tokens[0])
            .map(([name, ...sources]) => [name as string, sources]),
    );
};

const envValues = (prefix: string): string[] =>
    read('.env.production')
        .split('\n')
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(line.indexOf('=') + 1).trim())
        .filter(Boolean);

const walk = (dir: string): string[] =>
    readdirSync(resolve(process.cwd(), dir)).flatMap((name) => {
        const path = join(dir, name);
        return statSync(resolve(process.cwd(), path)).isDirectory() ? walk(path) : [path];
    });

describe('Content-Security-Policy', () => {
    it('allows scripts only from our origin, plus WebAssembly compilation for the pdf.js decoders', () => {
        expect(csp().get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
        expect(csp().get('default-src')).toEqual(["'self'"]);
    });

    it('never allows inline or eval in any directive', () => {
        for (const [directive, sources] of csp()) {
            expect(sources, directive).not.toContain("'unsafe-inline'");
            expect(sources, directive).not.toContain("'unsafe-eval'");
            expect(sources, directive).not.toContain('*');
        }
    });

    it('lets the app reach every Supabase project the bundle can pick, over https and wss', () => {
        const connect = csp().get('connect-src') ?? [];
        const projects = envValues('VITE_SUPABASE_').filter((v) => v.startsWith('https://'));
        // PROD and DEV — the hostname picks between them at runtime.
        expect(projects.length).toBeGreaterThanOrEqual(2);
        for (const url of projects) {
            const host = new URL(url).host;
            expect(connect).toContain(`https://${host}`);
            expect(connect).toContain(`wss://${host}`);
        }
        expect(connect).toContain("'self'");
    });

    it('locks down plugins, framing, base and form targets', () => {
        const policy = csp();
        expect(policy.get('object-src')).toEqual(["'none'"]);
        expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
        expect(policy.get('base-uri')).toEqual(["'self'"]);
        expect(policy.get('form-action')).toEqual(["'self'"]);
        // pdf.js and Vite workers are same-origin module workers.
        expect(policy.get('worker-src')).toEqual(["'self'", 'blob:']);
    });
});

describe('other security headers', () => {
    it('sends HSTS, nosniff, a referrer policy and a minimal permissions policy', () => {
        const headers = globalHeaders();
        expect(headers.get('strict-transport-security')).toMatch(/max-age=\d{8,}/);
        expect(headers.get('x-content-type-options')).toBe('nosniff');
        expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
        expect(headers.get('x-frame-options')).toBe('DENY');
        const permissions = headers.get('permissions-policy') ?? '';
        for (const feature of ['camera', 'microphone', 'geolocation', 'payment']) {
            expect(permissions).toContain(`${feature}=()`);
        }
    });

    it('names only Permissions-Policy features Chromium recognizes', () => {
        // An unknown feature is not ignored quietly: Chromium logs "Error with
        // Permissions-Policy header: Unrecognized feature" on EVERY page load
        // ('bluetooth' was one), which buries real console errors. Check a new
        // name against chromium's permissions_policy_features.json5 first.
        const KNOWN = new Set([
            'accelerometer',
            'browsing-topics',
            'camera',
            'geolocation',
            'gyroscope',
            'hid',
            'magnetometer',
            'microphone',
            'midi',
            'payment',
            'serial',
            'usb',
        ]);
        const features = (globalHeaders().get('permissions-policy') ?? '')
            .split(',')
            .map((entry) => entry.trim().split('=')[0] ?? '');
        for (const feature of features) {
            expect(KNOWN, feature).toContain(feature);
        }
    });
});

describe('nothing the policy would silently block', () => {
    it('index.html has no inline scripts or styles', () => {
        const html = read('index.html');
        for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
            expect(tag, 'every script must be external').toMatch(/\bsrc=/);
        }
        expect(html).not.toMatch(/<style\b/);
        expect(html).not.toMatch(/\sstyle=/);
        expect(html).not.toMatch(/\son[a-z]+=/i);
    });

    it('no component renders an inline <style> element', () => {
        // style-src is 'self' only: an inline <style> would be dropped in
        // production while working everywhere else (StudentCodeCard's print
        // rules were one). Put the rules in a .css file instead.
        const offenders = walk('src')
            .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
            .filter((file) => /<style[\s>]/.test(read(file)));
        expect(offenders).toEqual([]);
    });
});
