import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ROOT = process.cwd();

describe.skipIf(!CHROMIUM)('landing ink when Caveat fails', () => {
    let browser: Browser | undefined;
    let server: ViteDevServer | undefined;

    beforeAll(async () => {
        server = await createServer({
            configFile: false,
            root: ROOT,
            cacheDir: resolve(ROOT, 'node_modules/.vite-landing-ink'),
            logLevel: 'error',
            plugins: [react(), tailwindcss()],
            resolve: { alias: { '@': resolve(ROOT, 'src') } },
            server: { host: '127.0.0.1', port: 0, hmr: false },
        });
        await server.listen();
        browser = await chromium.launch({ executablePath: CHROMIUM });
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        await server?.close();
    });

    it('draws every mark and chip in the hero and the live band', async () => {
        const page = await browser!.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' });
        try {
            await page.route('**/caveat-latin-wght*.woff2', (route) => route.abort());
            await page.goto(`${server!.resolvedUrls!.local[0]}tests/ui/fixtures/landingInk.html`);
            await page.waitForSelector('.hero-chip', { state: 'attached' });
            await page.locator('.ink-score-card').scrollIntoViewIfNeeded();
            await page.waitForTimeout(500);
            await page.locator('#live-title').scrollIntoViewIfNeeded();
            await page.waitForTimeout(5500);
            const styles = await page.evaluate(() => ({
                strokes: Array.from(
                    document.querySelectorAll('.hero-ink'),
                    (node) => getComputedStyle(node).strokeDashoffset,
                ),
                chips: Array.from(document.querySelectorAll('.hero-chip'), (node) => getComputedStyle(node).opacity),
            }));
            expect(styles.strokes.length).toBeGreaterThanOrEqual(6);
            expect(new Set(styles.strokes)).toEqual(new Set(['0px']));
            expect(styles.chips).toEqual(['1', '1']);
        } finally {
            await page.close();
        }
    }, 30_000);
});
