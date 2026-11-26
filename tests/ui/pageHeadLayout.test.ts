import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PageHead, type PageHeadProps } from '@/ui/PageHead';

/**
 * The page head laid out with the production CSS in a real browser, inside the
 * shell's content column. Needs `npm run build` and a Chromium:
 *
 *     npm run build && CLEFFY_UI_CHROMIUM=/usr/bin/google-chrome npx vitest run tests/ui/pageHeadLayout.test.ts
 */

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ASSETS = resolve(process.cwd(), 'dist/assets');
const CSS = existsSync(ASSETS) ? readdirSync(ASSETS).find((name) => /^index-.*\.css$/.test(name)) : undefined;

const LONG_EMAIL = 'theconservatoryofmusicandperformingartsdepartment@example.org';

const pageMarkup = (head: PageHeadProps) =>
    renderToStaticMarkup(
        createElement(
            'div',
            { className: 'mx-auto w-full max-w-[100rem] px-4 sm:px-6 lg:px-10 py-8 lg:py-10' },
            createElement(
                'div',
                { className: 'library-shell min-w-0' },
                createElement(
                    'div',
                    null,
                    createElement(PageHead, head),
                    createElement(
                        'div',
                        { className: 'w-full max-w-3xl', id: 'body' },
                        createElement('p', { className: 'mt-6', id: 'content' }, 'Content'),
                    ),
                ),
            ),
        ),
    );

describe.skipIf(!CHROMIUM || !CSS)('PageHead layout', () => {
    let browser: Browser;
    let dir: string;

    beforeAll(async () => {
        browser = await chromium.launch({ executablePath: CHROMIUM });
        dir = mkdtempSync(join(tmpdir(), 'page-head-'));
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const measure = async (head: PageHeadProps, width: number) => {
        const file = join(dir, `${Math.random().toString(36).slice(2)}.html`);
        const stylesheet = pathToFileURL(join(ASSETS, CSS!)).href;
        writeFileSync(
            file,
            `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${stylesheet}"></head><body>${pageMarkup(head)}</body></html>`,
        );
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
            await page.goto(pathToFileURL(file).href);
            await page.evaluate(() => document.fonts.ready);
            return await page.evaluate(() => {
                const header = document.querySelector('header')!.getBoundingClientRect();
                return {
                    headWidth: header.width,
                    contentGap: document.getElementById('content')!.getBoundingClientRect().top - header.bottom,
                    bodyWidth: document.getElementById('body')!.getBoundingClientRect().width,
                    scrollWidth: document.documentElement.scrollWidth,
                };
            });
        } finally {
            await page.close();
        }
    };

    it.each([
        ['wide', 1280],
        ['narrow', 1100],
    ] as const)('sizes a %s head to %i px at 1440 px, apart from the body', async (width, expected) => {
        const layout = await measure({ width, eyebrow: 'Ada · 3 scores', title: 'Library' }, 1440);
        expect(layout.headWidth).toBe(expected);
        expect(layout.bodyWidth).toBe(768);
    });

    it.each([1440, 820, 390])('starts content 32 px under the hairline at %i px', async (viewport) => {
        const layout = await measure({ width: 'wide', title: 'Find a score', subtitle: 'Search.' }, viewport);
        expect(layout.contentGap).toBe(32);
    });

    it('wraps a long email in the eyebrow instead of scrolling a phone sideways', async () => {
        const layout = await measure({ width: 'narrow', eyebrow: `${LONG_EMAIL} · Free plan`, title: 'Account' }, 390);
        expect(layout.scrollWidth).toBe(390);
    });
});
