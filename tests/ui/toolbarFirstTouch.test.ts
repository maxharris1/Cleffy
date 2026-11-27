import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium, type Browser, type CDPSession, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ROOT = process.cwd();

interface Point {
    x: number;
    y: number;
}

type Interleave = (page: Page) => Promise<void>;

const INTERLEAVES: ReadonlyArray<[string, Interleave, Interleave, string[]]> = [
    ['nothing else', async () => {}, async () => {}, []],
    [
        'Enter on a focused outside button while the finger is down',
        async (page) => page.getByRole('button', { name: 'Outside' }).focus(),
        async (page) => page.keyboard.press('Enter'),
        ['Outside'],
    ],
    [
        'a right-click outside while the finger is down, then a 600 ms hold',
        async () => {},
        async (page) => {
            const outside = (await page.getByRole('button', { name: 'Outside' }).boundingBox())!;
            await page.mouse.click(outside.x + 4, outside.y + 4, { button: 'right' });
            await page.waitForTimeout(600);
        },
        [],
    ],
];

const CONTROLS: ReadonlyArray<[string, string[], string]> = [
    ['Redo', ['Redo'], 'pen'],
    ['Undo', ['Undo'], 'pen'],
    ['Highlighter', [], 'highlighter'],
];

describe.skipIf(!CHROMIUM)('the first touch on a fine-pointer Toolbar in Chromium', () => {
    let browser: Browser | undefined;
    let server: ViteDevServer | undefined;

    beforeAll(async () => {
        server = await createServer({
            configFile: false,
            root: ROOT,
            cacheDir: resolve(ROOT, 'node_modules/.vite-toolbar-first-touch'),
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

    const touch = (cdp: CDPSession, type: 'touchStart' | 'touchEnd', at: Point) =>
        cdp.send('Input.dispatchTouchEvent', {
            type,
            touchPoints: type === 'touchEnd' ? [] : [{ x: at.x, y: at.y, id: 1 }],
        });

    const controlAt = (page: Page, at: Point) =>
        page.evaluate(
            ({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? null,
            at,
        );

    describe.each([390, 1280])('at %i px', (width) => {
        describe.each(INTERLEAVES)('with %s', (_, before, during, outside) => {
            it.each(CONTROLS)(
                'invokes %s, the control under the finger from press to release',
                async (name, calls, tool) => {
                    const page = await browser!.newPage({ viewport: { width, height: 800 } });
                    try {
                        await page.goto(`${server!.resolvedUrls!.local[0]}tests/ui/fixtures/toolbarFirstTouch.html`);
                        const control = page.getByRole('button', { name, exact: true });
                        await control.waitFor();
                        expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
                        const box = (await control.boundingBox())!;
                        const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
                        const cdp = await page.context().newCDPSession(page);

                        await before(page);
                        await touch(cdp, 'touchStart', at);
                        await during(page);
                        const underFinger = await controlAt(page, at);
                        await touch(cdp, 'touchEnd', at);

                        expect(underFinger, `the control under the finger at release`).toBe(name);
                        await expect.poll(() => page.evaluate(() => window.viewerState().touchSeen)).toBe(true);
                        await page.getByRole('button', { name: 'Finger scrolls' }).waitFor();
                        expect(await page.evaluate(() => window.invoked)).toEqual([...outside, ...calls]);
                        expect(await page.evaluate(() => window.viewerState())).toMatchObject({
                            tool,
                            fingerDraws: false,
                        });
                    } finally {
                        await page.close();
                    }
                },
                20_000,
            );
        });
    });
});
