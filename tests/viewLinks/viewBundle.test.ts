// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectDenylist } from './swDenylist';

/**
 * Builds the app with the real vite.config.ts (both pages, the PWA, every
 * plugin) into a temporary directory, then reads what /v actually ships: the
 * HTML, every script and stylesheet it loads, and the service worker. The
 * child's page must carry none of the app's integrations — no Supabase client
 * or preconnect, no error monitoring, no web events, no service worker, no
 * device storage — and the service worker must neither precache nor serve it.
 *
 * A Sentry DSN is set for this build, so the app's own bundle does carry the
 * SDK: the viewer's not carrying it is then a real result.
 */

const root = process.cwd();
let outDir = '';

beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'cleffy-view-bundle-'));
    vi.stubEnv('VITE_SENTRY_DSN', 'https://publickey@o0.ingest.sentry.io/0');
    try {
        await build({
            configFile: resolve(root, 'vite.config.ts'),
            root,
            logLevel: 'silent',
            build: { outDir, emptyOutDir: true },
        });
    } finally {
        vi.unstubAllEnvs();
    }
}, 300_000);

afterAll(() => {
    if (outDir && existsSync(outDir)) {
        rmSync(outDir, { recursive: true, force: true });
    }
});

const read = (rel: string) => readFileSync(join(outDir, rel), 'utf8');
const viewHtml = () => read('view.html');

/** Every same-origin file view.html loads (script src, modulepreload, stylesheet). */
const viewFiles = () => [...viewHtml().matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/g)].map((m) => m[1] as string);

/** The pdf.js worker the viewer starts: emitted beside the chunks, loaded with `new URL`. */
const workerFiles = () => readdirSync(join(outDir, 'assets')).filter((f) => /^pdfWorkerEntry-.*\.js$/.test(f));

describe('the viewer as built', () => {
    it('is a page of its own, loading a view-* entry chunk', () => {
        expect(viewHtml()).toMatch(/<script type="module" crossorigin src="\/assets\/view-[^"]+\.js">/);
        expect(viewFiles().length).toBeGreaterThan(1);
    });

    it('references nothing off this origin: no Supabase preconnect, no manifest', () => {
        const html = viewHtml();
        expect(html).not.toMatch(/https?:\/\//);
        expect(html).not.toMatch(/supabase/i);
        expect(html).not.toMatch(/rel="manifest"|registerSW|sw\.js/);
    });

    it('while the app page keeps its manifest (the strip is view.html only)', () => {
        expect(read('index.html')).toMatch(/rel="manifest"/);
    });

    it.each([
        ['Supabase client code', /supabase-js|GoTrueClient|RealtimeClient|PostgrestClient|\.supabase\.co/],
        ['error monitoring', /@sentry|ingest\.sentry\.io|sentry-trace|__SENTRY/],
        ['web events', /webEvents|record_web_events|web_events/],
        ['service-worker code', /serviceWorker|registerSW|workbox/],
        ['device storage', /localStorage|sessionStorage|indexedDB|IDBFactory|document\.cookie|caches\.open|Dexie/],
        ['app-shell code', /installStaleChunkRecovery|captureAuthUrlError|installPrimitivesPrefetch/],
    ])('carries no %s in any file it loads', (_label, pattern) => {
        const hits = [...viewFiles(), ...workerFiles().map((f) => `assets/${f}`)]
            .filter((f) => pattern.test(read(f)))
            .map((f) => `${f}: ${read(f).match(pattern)?.[0]}`);
        expect(hits).toEqual([]);
    });

    it('the app’s bundle does carry Sentry in this build (so the check above can fail)', () => {
        const all = readdirSync(join(outDir, 'assets')).filter((f) => f.endsWith('.js'));
        expect(all.some((f) => /ingest\.sentry\.io|@sentry/.test(read(`assets/${f}`)))).toBe(true);
    });
});

describe('the service worker', () => {
    const sw = () => read('sw.js');

    it('precaches neither view.html nor a view-* chunk', () => {
        // Minified or not (workbox's mode follows NODE_ENV): `"url":"x"` or `"url": "x"`.
        expect(sw()).not.toMatch(/"url":\s*"view\.html"/);
        expect(sw()).not.toMatch(/"url":\s*"assets\/view-/);
        expect(sw()).toMatch(/"url":\s*"index\.html"/);
    });

    it('never answers /v, /v?…, /view.html or /api/* with the app shell, and still serves the app', () => {
        // Workbox emits `new NavigationRoute(handler, { denylist: [...] })`.
        const list = sw().match(/denylist:\s*\[[^\]]*\]/)?.[0] ?? '';
        expectDenylist(list.replace(/^denylist/, 'navigateFallbackDenylist'));
    });
});
