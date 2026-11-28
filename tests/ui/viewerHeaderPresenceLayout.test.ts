import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ROOT = process.cwd();

const WIDE_CAPS = ['WILLIAM MAXWELL WILSON', 'CHRISTOPHER WILLIAMSON', 'CAMELOT QUINCY MAXWELL'];
const NARROW_LETTERS = ['Liliana Lillian Miller', 'Jillian Lillian Miller'];
const ENSEMBLE = Array.from({ length: 16 }, (_, i) => `MAXWELL WILLIAMSON  ${String(i).padStart(2, '0')}`);

const roster = (lead: string[], count: number) => [...lead, ...ENSEMBLE].slice(0, count);

interface Layout {
    header: number;
    shareOnTitleRow: boolean;
    chips: string[];
}

/**
 * The owner's viewer header laid out in a real Chromium with the app's CSS and
 * fonts, with people whose names are 22 characters long. Needs a Chromium:
 *
 *     CLEFFY_UI_CHROMIUM=/usr/bin/google-chrome npx vitest run tests/ui/viewerHeaderPresenceLayout.test.ts
 */
describe.skipIf(!CHROMIUM)('the owner’s viewer header with an ensemble present, in Chromium', () => {
    let browser: Browser | undefined;
    let server: ViteDevServer | undefined;

    beforeAll(async () => {
        server = await createServer({
            configFile: false,
            root: ROOT,
            cacheDir: resolve(ROOT, 'node_modules/.vite-viewer-header-presence'),
            logLevel: 'error',
            plugins: [react(), tailwindcss()],
            resolve: { alias: { '@': resolve(ROOT, 'src') } },
            server: { host: '127.0.0.1', port: 0, hmr: false },
            define: {
                'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('http://127.0.0.1:1'),
                'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('anon'),
            },
        });
        await server.listen();
        browser = await chromium.launch({ executablePath: CHROMIUM });
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        await server?.close();
    });

    const layout = async (width: number, names: string[], options: { touch?: boolean; source?: boolean } = {}) => {
        const page = await browser!.newPage({
            viewport: { width, height: 900 },
            hasTouch: options.touch,
            isMobile: options.touch,
        });
        try {
            const query = new URLSearchParams({ count: String(names.length), source: options.source ? '1' : '0' });
            names.forEach((name) => query.append('name', name));
            await page.goto(`${server!.resolvedUrls!.local[0]}tests/ui/fixtures/viewerHeader.html?${query}`);
            await page.getByRole('button', { name: 'Share' }).waitFor();
            await page.evaluate(() => document.fonts.ready);
            return await page.evaluate((): Layout => {
                const box = (el: Element) => el.getBoundingClientRect();
                const title = box(document.querySelector('header button[aria-expanded]')!);
                const share = box(
                    [...document.querySelectorAll('header button')].find((b) => b.textContent === 'Share')!,
                );
                const group = document.querySelector('[aria-label$="collaborators viewing"]');
                return {
                    header: Math.round(box(document.querySelector('header')!).height),
                    shareOnTitleRow: share.top < title.bottom && share.bottom > title.top,
                    chips: group ? [...group.querySelectorAll('button')].map((b) => b.textContent ?? '') : [],
                };
            });
        } finally {
            await page.close();
        }
    };

    it.each([1, 3, 4, 16])(
        'keeps the header at 1440px to one 64px row with Share on it, with %i people named in wide capitals',
        async (count) => {
            const { header, shareOnTitleRow, chips } = await layout(1440, roster(WIDE_CAPS, count), { source: true });
            expect(chips).toHaveLength(Math.min(count, 4));
            expect({ header, shareOnTitleRow }).toEqual({ header: 64, shareOnTitleRow: true });
        },
        30_000,
    );

    describe.each([
        ['narrow letters', NARROW_LETTERS],
        ['wide capitals', WIDE_CAPS],
    ])('at 390px, with the first names in %s', (_kind, lead) => {
        it.each([
            ['a mouse', false],
            ['touch', true],
        ])(
            'is no taller with 3, 4 or 16 people than with 2, by %s',
            async (_pointer, touch) => {
                const two = await layout(390, roster(lead, 2), { touch });
                for (const count of [3, 4, 16]) {
                    const crowd = await layout(390, roster(lead, count), { touch });
                    expect(crowd.chips).toHaveLength(3);
                    expect({ count, header: crowd.header }).toEqual({
                        count,
                        header: expect.toSatisfy((h: number) => h <= two.header, `<= ${two.header}px`),
                    });
                }
            },
            60_000,
        );
    });
});
