/// <reference types="vitest/config" />
import { createReadStream, cpSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { PDFJS_ASSET_DIRS, type PdfjsAssetDir } from './src/features/viewer/pdf/pdfjsAssets';
import { collectSupabasePreconnectOrigins } from './src/lib/supabasePreconnectOrigins';

// ngrok / tunnel hosts allowed to reach the dev + preview servers.
const TUNNEL_HOSTS = ['.ngrok-free.app', '.ngrok.app', '.ngrok.dev', '.trycloudflare.com'];

const PDFJS_DIST = fileURLToPath(new URL('./node_modules/pdfjs-dist', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
    '.wasm': 'application/wasm',
    '.js': 'application/javascript',
    '.bcmap': 'application/octet-stream',
    '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf',
    '.icc': 'application/vnd.iccprofile',
};

/**
 * Serve (dev) and copy (build) the pdf.js data directories listed in
 * pdfjsAssets.ts — WASM decoders, CMaps, standard fonts, ICC profile — so the
 * worker fetches them from our own origin. Excluded files (the unused
 * document-JS interpreter) are neither served nor copied.
 */
const pdfjsAssetsPlugin = (): Plugin => {
    const dirs = Object.values(PDFJS_ASSET_DIRS).map((dir: PdfjsAssetDir) => ({
        ...dir,
        root: path.join(PDFJS_DIST, dir.source),
    }));
    return {
        name: 'pdfjs-assets',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const dir = dirs.find((d) => req.url?.startsWith(d.publicPath));
                if (!req.url || !dir) {
                    next();
                    return;
                }
                const notFound = () => {
                    res.statusCode = 404;
                    res.end('Not found');
                };
                // Strip query string (cache busters) and map onto node_modules/pdfjs-dist/<dir>.
                // A malformed escape (`%E0`) is a missing file, not a server error.
                let rel: string;
                try {
                    rel = decodeURIComponent(req.url.slice(dir.publicPath.length).split('?')[0] ?? '');
                } catch {
                    notFound();
                    return;
                }
                const filePath = path.resolve(dir.root, rel);
                if (
                    !filePath.startsWith(dir.root + path.sep) ||
                    dir.exclude.includes(path.basename(filePath)) ||
                    !existsSync(filePath)
                ) {
                    notFound();
                    return;
                }
                const type = CONTENT_TYPES[path.extname(filePath)];
                if (type) {
                    res.setHeader('Content-Type', type);
                }
                createReadStream(filePath).pipe(res);
            });
        },
        writeBundle(outputOptions) {
            const outDir = outputOptions.dir ?? 'dist';
            for (const dir of dirs) {
                cpSync(dir.root, path.join(outDir, dir.publicPath), {
                    recursive: true,
                    filter: (source) => !dir.exclude.includes(path.basename(source)),
                });
            }
        },
    };
};

/**
 * `<link rel="preconnect">` for every known Supabase HTTPS origin. Runtime
 * picks the project by hostname when `VITE_SUPABASE_URL` is unset (see
 * src/lib/supabase.ts); a production env typically has only `_PROD` and `_DEV`.
 */
const supabasePreconnectPlugin = (): Plugin => {
    let origins: string[] = [];
    return {
        name: 'supabase-preconnect',
        configResolved(config) {
            const env = loadEnv(config.mode, config.envDir ?? process.cwd(), 'VITE_');
            origins = collectSupabasePreconnectOrigins(env);
        },
        transformIndexHtml() {
            return origins.map((href) => ({
                tag: 'link',
                attrs: { rel: 'preconnect', href, crossorigin: '' },
                injectTo: 'head-prepend' as const,
            }));
        },
    };
};

/**
 * Build-time constants for error monitoring (see src/lib/monitoring/index.ts).
 *
 * `__SENTRY_DSN__` is a define rather than an import.meta.env read so that an
 * unset DSN is the literal '' and the minifier drops the SDK import entirely.
 * `__APP_RELEASE__` tags every report with the commit that built it: Vercel
 * provides VERCEL_GIT_COMMIT_SHA to every build, and VITE_SENTRY_RELEASE wins
 * when a release name has to match one uploaded elsewhere (source maps).
 *
 * The test run always compiles monitoring out, whatever a developer's .env
 * holds: vitest must never post a report, and the suite asserts the no-op.
 */
const buildConstantsPlugin = (): Plugin => ({
    name: 'build-constants',
    config(_config, { mode }) {
        const env = loadEnv(mode, process.cwd(), '');
        const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
        const commit = env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12);
        const release = env.VITE_SENTRY_RELEASE || `cleffy@${commit || pkg.version}`;
        return {
            define: {
                __SENTRY_DSN__: JSON.stringify(mode === 'test' ? '' : (env.VITE_SENTRY_DSN ?? '').trim()),
                __APP_RELEASE__: JSON.stringify(release),
            },
        };
    },
});

export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
        pdfjsAssetsPlugin(),
        supabasePreconnectPlugin(),
        buildConstantsPlugin(),
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['icons/apple-touch-icon.png', 'favicon.svg'],
            manifest: {
                name: 'Cleffy',
                short_name: 'Cleffy',
                description: 'Real-time collaborative sheet music annotation',
                // Keep in sync with the @theme palette in src/index.css (accent / paper)
                // and the theme-color meta in index.html.
                theme_color: '#4338ca',
                background_color: '#f7f5ef',
                display: 'standalone',
                orientation: 'any',
                lang: 'en',
                categories: ['education', 'music'],
                start_url: '/library',
                scope: '/',
                id: '/library',
                icons: [
                    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
                    { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                ],
            },
            workbox: {
                // App shell only. Supabase traffic must never be cached by the SW;
                // PDFs are cached as blobs in IndexedDB (see plan §sync), not here.
                globPatterns: ['**/*.{js,css,html,png,svg,woff2,wasm}'],
                // The SMuFL music-text face (~450 KB) serves only the opt-in
                // handwriting → print feature; like the piano samples it is
                // fetched on first use and then kept, not precached.
                globIgnores: ['**/fonts/BravuraText.woff2'],
                navigateFallback: '/index.html',
                navigateFallbackDenylist: [/^\/auth\/callback/],
                maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
                // Piano samples (~0.85 MB) are deliberately NOT precached — they
                // load on first Play and then replay (and work offline) from here.
                runtimeCaching: [
                    {
                        urlPattern: /\/audio\/piano\//,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'piano-samples',
                            expiration: { maxEntries: 40 },
                        },
                    },
                    {
                        // pdf.js CMaps / standard fonts / ICC profile: fetched by the
                        // worker only for PDFs that need them, so not precached —
                        // kept after first use so those scores still render offline.
                        urlPattern: /\/pdfjs-(cmaps|standard-fonts|iccs)\//,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'pdfjs-data',
                            expiration: { maxEntries: 80 },
                        },
                    },
                    {
                        urlPattern: /\/fonts\/BravuraText\.woff2$/,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'music-font',
                            expiration: { maxEntries: 2 },
                        },
                    },
                ],
            },
        }),
    ],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    server: {
        allowedHosts: TUNNEL_HOSTS,
    },
    preview: {
        allowedHosts: TUNNEL_HOSTS,
    },
    test: {
        environment: 'jsdom',
        setupFiles: ['./src/test/setup.ts'],
        include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    },
});
