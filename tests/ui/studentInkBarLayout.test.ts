import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StudentInkBar } from '@/features/student/AssignmentsPage';

/**
 * The student's ink bar laid out with the production CSS in a real browser.
 * Needs `npm run build` and a Chromium:
 *
 *     npm run build && CLEFFY_UI_CHROMIUM=/usr/bin/google-chrome npx vitest run tests/ui/studentInkBarLayout.test.ts
 */

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ASSETS = resolve(process.cwd(), 'dist/assets');
const CSS = existsSync(ASSETS) ? readdirSync(ASSETS).find((name) => /^index-.*\.css$/.test(name)) : undefined;

const LONG_NAME = 'Maximiliana Konstantinopoulou-Featherstonehaugh';
const VIEWPORTS = [320, 360, 390, 640, 820, 1440] as const;
const STATES = [
    ['signed in', false],
    ['saving before sign-out', true],
] as const;

describe.skipIf(!CHROMIUM || !CSS)('StudentInkBar layout', () => {
    let browser: Browser | undefined;
    let dir: string | undefined;

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'student-ink-bar-'));
        browser = await chromium.launch({ executablePath: CHROMIUM });
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    const measure = async (saving: boolean, width: number) => {
        const markup = renderToStaticMarkup(
            createElement(StudentInkBar, { name: LONG_NAME, saving, onSignOut: () => {} }),
        );
        const file = join(dir!, `${Math.random().toString(36).slice(2)}.html`);
        const stylesheet = pathToFileURL(join(ASSETS, CSS!)).href;
        writeFileSync(
            file,
            `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${stylesheet}"></head><body>${markup}</body></html>`,
        );
        const page = await browser!.newPage({ viewport: { width, height: 600 } });
        try {
            await page.goto(pathToFileURL(file).href);
            await page.evaluate(() => document.fonts.ready);
            return await page.evaluate((name) => {
                const box = (element: Element) => {
                    const { left, right, top, bottom } = element.getBoundingClientRect();
                    return { left, right, top, bottom };
                };
                const nameText = [...document.querySelectorAll('header span')].findLast(
                    (span) => span.textContent === name,
                )!;
                return {
                    wordmark: box(document.querySelector('header')!.firstElementChild!.firstElementChild!),
                    chip: box(nameText.parentElement!),
                    name: box(nameText),
                    button: box(document.querySelector('header button')!),
                    scrollWidth: document.documentElement.scrollWidth,
                };
            }, LONG_NAME);
        } finally {
            await page.close();
        }
    };

    it.each(STATES.flatMap(([state, saving]) => VIEWPORTS.map((width) => [state, width, saving] as const)))(
        'keeps the truncated name inside the chip and clear of the button when %s at %i px',
        async (_state, width, saving) => {
            const bar = await measure(saving, width);

            expect(bar.scrollWidth).toBe(width);
            expect(bar.name.right - bar.name.left).toBeGreaterThanOrEqual(48);
            expect(bar.name.left).toBeGreaterThanOrEqual(bar.chip.left);
            expect(bar.name.right).toBeLessThanOrEqual(bar.chip.right);
            expect(bar.name.top).toBeGreaterThanOrEqual(bar.chip.top);
            expect(bar.name.bottom).toBeLessThanOrEqual(bar.chip.bottom);

            const sameRow = (a: typeof bar.chip, b: typeof bar.chip) => a.top < b.bottom && b.top < a.bottom;
            if (sameRow(bar.chip, bar.button)) {
                expect(bar.chip.right).toBeLessThanOrEqual(bar.button.left);
            }
            if (!saving) {
                expect(sameRow(bar.wordmark, bar.chip)).toBe(true);
            }
            if (sameRow(bar.wordmark, bar.chip)) {
                expect(bar.wordmark.right).toBeLessThanOrEqual(bar.chip.left);
            }
            expect(bar.button.right).toBeLessThanOrEqual(width);
        },
    );
});
