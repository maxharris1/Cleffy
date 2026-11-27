import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium, type Browser, type Page } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LibraryShell } from '@/features/library/LibraryShell';

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ROOT = process.cwd();

vi.mock('@/lib/supabase', () => ({ isSupabaseConfigured: () => true }));

vi.mock('@/features/auth/AuthGates', () => ({
    RequireRegistered: ({ children }: { children: (session: unknown) => unknown }) =>
        children({ user: { id: 'teacher-1', email: 'ada@example.org' } }),
}));

vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    displayNameOf: () => 'Ada Teacher',
    storedDisplayNameOf: () => 'Ada Teacher',
}));

vi.mock('@/features/billing/useEntitlements', () => ({
    useEntitlements: () => ({
        entitlements: {
            user_id: 'teacher-1',
            tier: 'teacher',
            status: 'active',
            source: 'subscription',
            current_period_end: null,
            limits: {
                cloud_scores: -1,
                omr_runs: -1,
                vision_reads: -1,
                smart_imports: -1,
                pdf_exports: -1,
                students: -1,
            },
        },
        loading: false,
        refresh: async () => {},
    }),
}));

const shellMarkup = () =>
    renderToStaticMarkup(
        createElement(
            MemoryRouter,
            { initialEntries: ['/library'] },
            createElement(
                Routes,
                null,
                createElement(
                    Route,
                    { element: createElement(LibraryShell) },
                    createElement(Route, { path: '/library', element: createElement('div', null, 'Library') }),
                ),
            ),
        ),
    );

const SETTINGS = [
    [320, 9],
    [390, 12],
    [390, 16],
] as const;

describe.skipIf(!CHROMIUM)('the favorite-error toast over the phone Library header in Chromium', () => {
    let browser: Browser | undefined;
    let server: ViteDevServer | undefined;
    let url = '';
    const markup = shellMarkup();

    beforeAll(async () => {
        server = await createServer({
            configFile: false,
            root: ROOT,
            cacheDir: resolve(ROOT, 'node_modules/.vite-library-toast'),
            logLevel: 'error',
            plugins: [react(), tailwindcss()],
            resolve: { alias: { '@': resolve(ROOT, 'src') } },
            server: { host: '127.0.0.1', port: 0, hmr: false },
        });
        await server.listen();
        url = `${server.resolvedUrls!.local[0]}tests/ui/fixtures/libraryToast.html`;
        browser = await chromium.launch({ executablePath: CHROMIUM });
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        await server?.close();
    });

    const withToast = async <T>(width: number, defaultFont: number, run: (page: Page) => Promise<T>) => {
        const context = await browser!.newContext({ viewport: { width, height: 844 }, hasTouch: true });
        const page = await context.newPage();
        try {
            const cdp = await context.newCDPSession(page);
            await cdp.send('Page.setFontSizes', { fontSizes: { standard: defaultFont } });
            await page.goto(url);
            await page.addStyleTag({
                content: '*,*::before,*::after{animation:none!important;transition:none!important}',
            });
            await page.evaluate((html) => {
                document.getElementById('shell')!.innerHTML = html;
                window.showFavoriteError();
            }, markup);
            await page
                .locator('[data-sonner-toast][data-mounted="true"]', { hasText: 'Could not update favorites.' })
                .waitFor();
            return await run(page);
        } finally {
            await context.close();
        }
    };

    it.each(SETTINGS)(
        'lands a tap 2 px above the bottom of Upload score on it at %i px with a %i px default font',
        async (width, defaultFont) => {
            const hit = await withToast(width, defaultFont, async (page) => {
                const point = await page.evaluate(() => {
                    const rect = document.querySelector('label.shell-upload')!.getBoundingClientRect();
                    return { x: rect.left + rect.width / 2, y: rect.bottom - 2 };
                });
                await page.evaluate(() => {
                    document.addEventListener(
                        'touchstart',
                        (event) => {
                            const target = event.target as Element;
                            document.body.dataset.touched = target.closest('[data-sonner-toast]')
                                ? 'toast'
                                : (target
                                      .closest('label.shell-upload')
                                      ?.querySelector('input')
                                      ?.getAttribute('aria-label') ?? target.tagName);
                        },
                        { once: true, capture: true },
                    );
                });
                await page.touchscreen.tap(point.x, point.y);
                return page.evaluate(() => document.body.dataset.touched);
            });
            expect(hit).toBe('Upload score');
        },
    );

    it.each(SETTINGS)(
        'opens the file chooser on Enter from Upload score at %i px with a %i px default font',
        async (width, defaultFont) => {
            const chose = await withToast(width, defaultFont, async (page) => {
                await page.getByLabel('Upload score', { exact: true }).focus();
                const chooser = page.waitForEvent('filechooser', { timeout: 5_000 });
                await page.keyboard.press('Enter');
                return (await chooser).element().getAttribute('aria-label');
            });
            expect(chose).toBe('Upload score');
        },
    );
});
