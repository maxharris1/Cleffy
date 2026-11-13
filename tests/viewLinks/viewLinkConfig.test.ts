// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { expectDenylist } from './swDenylist';

/**
 * The wiring around view links that no unit can see: Vercel routing and
 * headers, the PWA's reach, the build inputs, the Edge Function's JWT setting,
 * one token format in three places, and the deploy notes for the switches
 * (two runtime switches gate serving; the build flag gates only the UI).
 */

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

type Rewrite = { source: string; destination: string };
type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };
const vercel = JSON.parse(read('vercel.json')) as { rewrites: Rewrite[]; headers: HeaderRule[] };

/** vercel.json sources used here are plain regexes once anchored (no :params). */
const matches = (source: string, path: string) => new RegExp(`^${source}$`).test(path);
const routeOf = (path: string) => vercel.rewrites.find((r) => matches(r.source, path))?.destination ?? path;

describe('vercel.json', () => {
    it('sends /v to the viewer page, before the catch-all', () => {
        expect(vercel.rewrites[0]).toEqual({ source: '/v', destination: '/view.html' });
        expect(routeOf('/v')).toBe('/view.html');
    });

    it('never rewrites /api/* to the app shell', () => {
        expect(routeOf('/api/view')).toBe('/api/view');
        expect(routeOf('/api/anything/else')).toBe('/api/anything/else');
    });

    it('still sends every app route to index.html', () => {
        for (const path of ['/', '/library', '/children-privacy', '/join/abc', '/viewer/x', '/vv']) {
            expect(routeOf(path)).toBe('/index.html');
        }
    });

    it('sends no Referer from /v', () => {
        const rule = vercel.headers.find((h) => h.source === '/v');
        expect(rule?.headers).toContainEqual({ key: 'Referrer-Policy', value: 'no-referrer' });
        const order = vercel.headers.map((h) => h.source);
        // Vercel applies every matching rule in order; the later one wins for a key.
        expect(order.indexOf('/v')).toBeGreaterThan(order.indexOf('/(.*)'));
    });

    it('keeps /api/view out of every cache', () => {
        const rule = vercel.headers.find((h) => h.source === '/api/(.*)');
        expect(rule?.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store' });
    });
});

describe('view.html', () => {
    const html = read('view.html');

    it('loads only the viewer entry', () => {
        expect(html).toMatch(/<script type="module" src="\/src\/view\/main\.tsx"><\/script>/);
        expect(html).not.toMatch(/src\/main\.tsx/);
    });

    it('sends no Referer, links no manifest, and is not indexed', () => {
        expect(html).toMatch(/<meta name="referrer" content="no-referrer"/);
        expect(html).toMatch(/<meta name="robots" content="noindex/);
        expect(html).not.toMatch(/rel="manifest"/);
        expect(html).not.toMatch(/https?:\/\//);
    });
});

describe('vite.config.ts', () => {
    const config = read('vite.config.ts');

    it('builds view.html as its own input', () => {
        expect(config).toMatch(/input:\s*\{[^}]*main:\s*[^,]*index\.html[^}]*view:\s*[^,]*view\.html/s);
    });

    it('keeps the service worker away from /v, /v?…, /view.html and /api, and not from the app', () => {
        expectDenylist(config);
    });

    it('precaches neither view.html nor the viewer chunks', () => {
        expect(config).toMatch(/VIEW_PRECACHE_IGNORES\s*=\s*\['view\.html',\s*'\*\*\/assets\/view-\*\.js'/);
        expect(config).toMatch(/globIgnores:\s*\[[^\]]*\.\.\.VIEW_PRECACHE_IGNORES/);
    });
});

describe('TypeScript and ESLint cover api/', () => {
    it('is in tsconfig include', () => {
        const tsconfig = JSON.parse(read('tsconfig.json')) as { include: string[] };
        expect(tsconfig.include).toContain('api');
    });

    it('is not ignored by ESLint', () => {
        expect(read('eslint.config.js')).not.toMatch(/ignores:\s*\[[^\]]*'api/);
    });
});

describe('the view-link Edge Function', () => {
    it('is reached without a user JWT: the proxy secret is its gate', () => {
        expect(read('supabase/config.toml')).toMatch(/\[functions\.view-link\]\s*\nverify_jwt = false/);
    });
});

describe('one token format', () => {
    const pattern = (file: string) => {
        const m = read(file).match(/VIEW_TOKEN_PATTERN\s*=\s*(\/[^\n]+\/);/);
        return m?.[1];
    };

    it('is the same 43-character base64url pattern in the viewer, the proxy and the Edge Function', () => {
        const expected = '/^[A-Za-z0-9_-]{43}$/';
        expect(pattern('src/view/viewToken.ts')).toBe(expected);
        expect(pattern('api/view.ts')).toBe(expected);
        expect(pattern('supabase/functions/_shared/viewLink.ts')).toBe(expected);
    });
});

describe('DEPLOY.md', () => {
    const deploy = read('DEPLOY.md');

    it('documents the switches and the proxy settings', () => {
        for (const name of [
            'VITE_FEATURE_VIEW_LINKS',
            'VIEW_LINKS_ENABLED',
            'VIEW_PROXY_SECRET',
            'VIEW_LINKS_SUPABASE_URL',
            'VIEW_LINKS_ANON_KEY',
            'VIEW_PDF_PROXY_MAX',
        ]) {
            expect(deploy).toContain(name);
        }
        expect(deploy).toMatch(/lawyer|counsel/i);
    });
});
