import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ROOT = process.cwd();

const TOOLS = ['Pen', 'Highlighter', 'Eraser', 'Text note'] as const;

const VIEWPORTS: ReadonlyArray<[string, { width: number; height: number }, boolean]> = [
    ['a 390 px phone', { width: 390, height: 800 }, true],
    ['a 1024 px coarse-pointer tablet', { width: 1024, height: 768 }, true],
    ['a 1280 px desktop', { width: 1280, height: 800 }, false],
    ['a 1440 px desktop', { width: 1440, height: 900 }, false],
];

const LANDMARKS = ['Undo', 'Redo', 'Color #1f2937', 'Color #9333ea'];

describe.skipIf(!CHROMIUM)('the Toolbar layout in Chromium', () => {
    let browser: Browser | undefined;
    let server: ViteDevServer | undefined;

    beforeAll(async () => {
        server = await createServer({
            configFile: false,
            root: ROOT,
            cacheDir: resolve(ROOT, 'node_modules/.vite-toolbar-layout'),
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

    const open = async (viewport: { width: number; height: number }, coarse: boolean) => {
        const context = await browser!.newContext({ viewport, hasTouch: coarse });
        const page = await context.newPage();
        await page.goto(`${server!.resolvedUrls!.local[0]}tests/ui/fixtures/toolbarFirstTouch.html`);
        await page.getByRole('button', { name: 'Undo', exact: true }).waitFor();
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(coarse);
        if (coarse) {
            await page.getByRole('button', { name: 'Finger draws', exact: true }).click();
        }
        return page;
    };

    const layout = (page: Page) =>
        page.evaluate((names) => {
            const box = (el: Element) => {
                const r = el.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height };
            };
            const control = (name: string) =>
                document.querySelector(`button[aria-label="${name}"]`) as HTMLElement | null;
            const row = control('Undo')!.parentElement!;
            return {
                row: box(row),
                ...Object.fromEntries(
                    names.map((name) => {
                        const el = control(name);
                        return [name, el && el.offsetParent ? box(el) : null];
                    }),
                ),
            };
        }, LANDMARKS);

    const holdPen = async (page: Page) => {
        const pen = page.getByRole('button', { name: 'Pen', exact: true });
        if ((await pen.getAttribute('aria-pressed')) !== 'true') {
            await pen.click();
        }
        await expect.poll(() => pen.getAttribute('aria-pressed')).toBe('true');
    };

    const centre = async (page: Page, name: string) => {
        const box = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };

    it.each(TOOLS)('gives the %s in hand #4338ca text on #e9e8fb', async (tool) => {
        const page = await open({ width: 1440, height: 900 }, false);
        try {
            const button = page.getByRole('button', { name: tool, exact: true });
            if ((await button.getAttribute('aria-pressed')) !== 'true') {
                await button.click();
            }
            await expect.poll(() => button.getAttribute('aria-pressed')).toBe('true');
            const style = await button.evaluate((el) => {
                const s = getComputedStyle(el);
                return { color: s.color, background: s.backgroundColor };
            });
            expect(style).toEqual({ color: 'rgb(67, 56, 202)', background: 'rgb(233, 232, 251)' });
        } finally {
            await page.context().close();
        }
    });

    describe.each(VIEWPORTS)('on %s', (_, viewport, coarse) => {
        it.each(TOOLS)(
            'keeps the row and every control in place as the %s is picked up and put down',
            async (tool) => {
                const page = await open(viewport, coarse);
                try {
                    const button = page.getByRole('button', { name: tool, exact: true });
                    const before = await layout(page);
                    const pressed = await button.getAttribute('aria-pressed');
                    await button.click();
                    await expect.poll(() => button.getAttribute('aria-pressed')).not.toBe(pressed);
                    const after = await layout(page);
                    await button.click();
                    await expect.poll(() => button.getAttribute('aria-pressed')).toBe(pressed);
                    expect(after).toEqual(before);
                    expect(await layout(page)).toEqual(before);
                } finally {
                    await page.context().close();
                }
            },
            20_000,
        );
    });

    describe('on a 1024 px coarse-pointer tablet', () => {
        it('gives every inline swatch and size dot a 44 px target no neighbour overlaps', async () => {
            const page = await open({ width: 1024, height: 768 }, true);
            try {
                await holdPen(page);
                const overlaps = await page.evaluate(() => {
                    const buttons = Array.from(
                        document.querySelectorAll<HTMLButtonElement>(
                            'button[aria-label^="Color #"], button[aria-label^="Pen size "]',
                        ),
                    ).filter((b) => b.offsetParent);
                    const misses: string[] = [];
                    for (const button of buttons) {
                        const r = button.getBoundingClientRect();
                        const cx = r.x + r.width / 2;
                        const cy = r.y + r.height / 2;
                        for (let dx = -21; dx <= 21; dx += 3) {
                            for (let dy = -21; dy <= 21; dy += 3) {
                                const hit = document.elementFromPoint(cx + dx, cy + dy)?.closest('button') ?? null;
                                const onAxis = dx === 0 || dy === 0;
                                if (onAxis ? hit !== button : hit !== null && hit !== button) {
                                    misses.push(
                                        `${button.getAttribute('aria-label')} at (${dx},${dy}) hit ${hit?.getAttribute('aria-label') ?? 'nothing'}`,
                                    );
                                }
                            }
                        }
                    }
                    return { count: buttons.length, misses };
                });
                expect(overlaps.count).toBe(10);
                expect(overlaps.misses).toEqual([]);
            } finally {
                await page.context().close();
            }
        });

        it('selects the swatch a tap lands on, just off its centre', async () => {
            const page = await open({ width: 1024, height: 768 }, true);
            try {
                await holdPen(page);
                await page.getByRole('button', { name: 'Color #9333ea', exact: true }).click();
                const black = await centre(page, 'Color #1f2937');
                await page.touchscreen.tap(black.x + 19, black.y);
                await expect
                    .poll(() =>
                        page.getByRole('button', { name: 'Color #1f2937', exact: true }).getAttribute('aria-pressed'),
                    )
                    .toBe('true');
            } finally {
                await page.context().close();
            }
        });
    });
});
