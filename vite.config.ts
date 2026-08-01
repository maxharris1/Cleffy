/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// ngrok / tunnel hosts allowed to reach the dev + preview servers.
const TUNNEL_HOSTS = ['.ngrok-free.app', '.ngrok.app', '.ngrok.dev'];

export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['icons/apple-touch-icon.png'],
            manifest: {
                name: 'Sheet Music Scribbler',
                short_name: 'Scribbler',
                description: 'Real-time collaborative sheet music annotation',
                theme_color: '#4f46e5',
                background_color: '#f5f5f4',
                display: 'standalone',
                orientation: 'any',
                icons: [
                    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
                    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                ],
            },
            workbox: {
                // App shell only. Supabase traffic must never be cached by the SW;
                // PDFs are cached as blobs in IndexedDB (see plan §sync), not here.
                globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
                navigateFallback: '/index.html',
                navigateFallbackDenylist: [/^\/auth\/callback/],
                maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
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
