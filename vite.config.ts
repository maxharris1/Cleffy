/// <reference types="vitest/config" />
import { createReadStream, cpSync, existsSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// ngrok / tunnel hosts allowed to reach the dev + preview servers.
const TUNNEL_HOSTS = ['.ngrok-free.app', '.ngrok.app', '.ngrok.dev', '.trycloudflare.com'];

const PDFJS_WASM_SRC = fileURLToPath(new URL('./node_modules/pdfjs-dist/wasm', import.meta.url));
const PDFJS_WASM_PUBLIC = '/pdfjs-wasm';

/** Serve / copy pdf.js WASM decoders (JBIG2 / OpenJPEG) required by pdf.js 5.x. */
const pdfjsWasmPlugin = (): Plugin => ({
    name: 'pdfjs-wasm',
    configureServer(server) {
        server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith(`${PDFJS_WASM_PUBLIC}/`)) {
                next();
                return;
            }
            // Strip query string (cache busters) and map onto node_modules/pdfjs-dist/wasm.
            const rel = req.url.slice(PDFJS_WASM_PUBLIC.length + 1).split('?')[0] ?? '';
            const filePath = fileURLToPath(new URL(rel, `file://${PDFJS_WASM_SRC}/`));
            if (!filePath.startsWith(PDFJS_WASM_SRC) || !existsSync(filePath)) {
                res.statusCode = 404;
                res.end('Not found');
                return;
            }
            if (filePath.endsWith('.wasm')) {
                res.setHeader('Content-Type', 'application/wasm');
            } else if (filePath.endsWith('.js')) {
                res.setHeader('Content-Type', 'application/javascript');
            }
            createReadStream(filePath).pipe(res);
        });
    },
    writeBundle(outputOptions) {
        const outDir = outputOptions.dir ?? 'dist';
        cpSync(PDFJS_WASM_SRC, `${outDir}${PDFJS_WASM_PUBLIC}`, { recursive: true });
    },
});

/**
 * `<link rel="preconnect">` for every Supabase origin the build knows about.
 *
 * The app picks its project at runtime by hostname (see src/lib/supabase.ts),
 * so the HTML cannot name just one — but both candidates are in the env at
 * build time, and a preconnect to an origin that goes unused costs a socket
 * for a few seconds. What it buys on a cold start is the DNS + TCP + TLS
 * handshake to the API host, done while the shell bundle is still parsing
 * instead of in front of the first request.
 */
const supabasePreconnectPlugin = (): Plugin => {
    let origins: string[] = [];
    return {
        name: 'supabase-preconnect',
        configResolved(config) {
            const env = loadEnv(config.mode, config.envDir ?? process.cwd(), 'VITE_');
            origins = [
                ...new Set(
                    ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PROD_URL', 'VITE_SUPABASE_DEV_URL']
                        .map((key) => env[key])
                        .filter((value): value is string => Boolean(value))
                        .map((value) => {
                            try {
                                return new URL(value).origin;
                            } catch {
                                return null;
                            }
                        })
                        .filter((value): value is string => value !== null && /^https:/.test(value)),
                ),
            ];
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

export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
        pdfjsWasmPlugin(),
        supabasePreconnectPlugin(),
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
