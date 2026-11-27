import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EmptyLibrary, LibraryUnavailable } from '@/features/library/LibraryPage';
import { NoRosterOnPlan } from '@/features/roster/RosterPage';
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

const pageMarkup = (head: PageHeadProps, content: ReactNode) =>
    renderToStaticMarkup(
        createElement(
            MemoryRouter,
            null,
            createElement(
                'div',
                { className: 'mx-auto w-full max-w-[100rem] px-4 sm:px-6 lg:px-10 py-8 lg:py-10' },
                createElement(
                    'div',
                    { className: 'library-shell min-w-0' },
                    createElement('div', null, createElement(PageHead, head), content),
                ),
            ),
        ),
    );

const body = (paragraph: ReactNode) => createElement('div', { className: 'w-full max-w-3xl', id: 'body' }, paragraph);

const LIBRARY_HEAD: PageHeadProps = {
    width: 'wide',
    eyebrow: 'Ada · 0 scores',
    title: 'Library',
    subtitle: 'Upload, organize, and share the scores you teach from.',
};

const PAGE_STATES: ReadonlyArray<[string, PageHeadProps, () => ReactNode]> = [
    [
        'Search with results',
        { width: 'wide', title: 'Find a score', subtitle: 'Search.' },
        () => body(createElement('p', { className: 'mt-6' }, 'Content')),
    ],
    [
        'Students with no roster on the plan',
        { width: 'narrow', title: 'Students' },
        () => createElement(NoRosterOnPlan, { onSeePlans: () => {} }),
    ],
    [
        'an empty Library',
        LIBRARY_HEAD,
        () =>
            createElement(EmptyLibrary, {
                uploading: false,
                quotaExhausted: false,
                uploadPct: null,
                uploadFading: false,
                onUpload: async () => {},
            }),
    ],
    ['a failed Library', LIBRARY_HEAD, () => createElement(LibraryUnavailable, { reason: 'error', onRetry: () => {} })],
    [
        'Account after checkout',
        {
            width: 'narrow',
            eyebrow: 'ada@example.org · Free plan',
            title: 'Account',
            subtitle: 'Your profile, plan, and what this device is holding.',
        },
        () => body(createElement('p', { className: 'mt-4', role: 'status' }, 'Thanks — your subscription is active.')),
    ],
];

const VIEWPORTS = [1440, 820, 390] as const;

const settleEnterAnimations = (page: Page) =>
    page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));

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

    const measure = async (head: PageHeadProps, content: ReactNode, width: number) => {
        const file = join(dir, `${Math.random().toString(36).slice(2)}.html`);
        const stylesheet = pathToFileURL(join(ASSETS, CSS!)).href;
        writeFileSync(
            file,
            `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${stylesheet}"></head><body>${pageMarkup(head, content)}</body></html>`,
        );
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
            await page.goto(pathToFileURL(file).href);
            await page.evaluate(() => document.fonts.ready);
            await settleEnterAnimations(page);
            return await page.evaluate(() => {
                const header = document.querySelector('header')!;
                const head = header.getBoundingClientRect();
                return {
                    headWidth: head.width,
                    contentGap: header.nextElementSibling!.getBoundingClientRect().top - head.bottom,
                    bodyWidth: document.getElementById('body')?.getBoundingClientRect().width,
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
        const layout = await measure(
            { width, eyebrow: 'Ada · 3 scores', title: 'Library' },
            body(createElement('p', { className: 'mt-6' }, 'Content')),
            1440,
        );
        expect(layout.headWidth).toBe(expected);
        expect(layout.bodyWidth).toBe(768);
    });

    it.each(
        PAGE_STATES.flatMap(([state, head, content]) =>
            VIEWPORTS.map((viewport) => [state, viewport, head, content] as const),
        ),
    )('starts %s 32 px under the hairline at %i px', async (_state, viewport, head, content) => {
        const layout = await measure(head, content(), viewport);
        expect(layout.contentGap).toBe(32);
    });

    it('wraps a long email in the eyebrow instead of scrolling a phone sideways', async () => {
        const layout = await measure(
            { width: 'narrow', eyebrow: `${LONG_EMAIL} · Free plan`, title: 'Account' },
            body(createElement('p', { className: 'mt-6' }, 'Content')),
            390,
        );
        expect(layout.scrollWidth).toBe(390);
    });
});
