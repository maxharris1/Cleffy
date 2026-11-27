import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AccountPage } from '@/features/account/AccountPage';
import type * as SessionModule from '@/features/auth/session';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';
import { EmptyLibrary, LibraryUnavailable } from '@/features/library/LibraryPage';
import { SearchPage } from '@/features/library/SearchPage';
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

vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<typeof SessionModule>()),
    useSession: () => ({
        session: {
            user: { id: 'teacher-1', email: 'ada@example.org', created_at: '2026-01-14T10:00:00Z', user_metadata: {} },
        },
        loading: false,
        lastEvent: null,
    }),
}));

vi.mock('@/features/billing/useEntitlements', () => ({
    useEntitlements: () => ({
        entitlements: {
            user_id: 'teacher-1',
            tier: 'free',
            status: null,
            source: 'none',
            current_period_end: null,
            limits: { cloud_scores: 3, omr_runs: 3, vision_reads: 5, smart_imports: 2, pdf_exports: 1, students: 3 },
        },
        loading: false,
        refresh: async () => {},
    }),
}));

const LONG_EMAIL = 'theconservatoryofmusicandperformingartsdepartment@example.org';

const shellMarkup = (page: ReactNode, path = '/') =>
    renderToStaticMarkup(
        createElement(
            MemoryRouter,
            { initialEntries: [path] },
            createElement(
                'div',
                { className: 'mx-auto w-full max-w-[100rem] px-4 sm:px-6 lg:px-10 py-8 lg:py-10' },
                createElement('div', { className: 'library-shell min-w-0' }, page),
            ),
        ),
    );

const pageMarkup = (head: PageHeadProps, content: ReactNode) =>
    shellMarkup(createElement('div', null, createElement(PageHead, head), content));

const OUTLET: LibraryOutletContext = {
    canManageStudents: true,
    userId: 'teacher-1',
    userLabel: 'Ada',
    uploadPct: null,
    uploading: false,
    onUpload: async () => {},
    onImportImslp: async () => ({ ok: true }),
    clearUploadError: () => {},
    uploadLimit: null,
    tier: 'free',
    openPricing: () => {},
};

const routeMarkup = (path: string, page: ReactNode, search = '') =>
    shellMarkup(
        createElement(
            Routes,
            null,
            createElement(
                Route,
                { element: createElement(Outlet, { context: OUTLET }) },
                createElement(Route, { path, element: page }),
            ),
        ),
        `${path}${search}`,
    );

/** Whole routes rendered as they ship, measured to the first thing a reader sees under the head. */
const ROUTES: ReadonlyArray<[string, () => string, string]> = [
    ['Account', () => routeMarkup('/account', createElement(AccountPage)), 'section'],
    [
        'Account after checkout',
        () => routeMarkup('/account', createElement(AccountPage), '?checkout=success'),
        '[role="status"]',
    ],
    ['Search with no quota notice', () => routeMarkup('/search', createElement(SearchPage)), 'input[type="search"]'],
];

const body = (paragraph: ReactNode) => createElement('div', { className: 'w-full max-w-3xl', id: 'body' }, paragraph);

const LIBRARY_HEAD: PageHeadProps = {
    width: 'wide',
    eyebrow: 'Ada · 0 scores',
    title: 'Library',
    subtitle: 'Upload, organize, and share the scores you teach from.',
};

const PAGE_STATES: ReadonlyArray<[string, PageHeadProps, () => ReactNode]> = [
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

    const measureMarkup = async (markup: string, width: number, firstContent?: string) => {
        const file = join(dir, `${Math.random().toString(36).slice(2)}.html`);
        const stylesheet = pathToFileURL(join(ASSETS, CSS!)).href;
        writeFileSync(
            file,
            `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${stylesheet}"></head><body>${markup}</body></html>`,
        );
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
            await page.goto(pathToFileURL(file).href);
            await page.evaluate(() => document.fonts.ready);
            await settleEnterAnimations(page);
            return await page.evaluate((selector) => {
                const header = document.querySelector<HTMLElement>('.page-head')!;
                const content = selector ? document.querySelector(selector)! : header.nextElementSibling!;
                const gap = () => content.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
                const layout = {
                    headWidth: header.getBoundingClientRect().width,
                    contentGap: gap(),
                    bodyWidth: document.getElementById('body')?.getBoundingClientRect().width,
                    scrollWidth: document.documentElement.scrollWidth,
                };
                header.style.marginBottom = '0px';
                return { ...layout, gapWithoutHeadMargin: gap() };
            }, firstContent);
        } finally {
            await page.close();
        }
    };

    const measure = (head: PageHeadProps, content: ReactNode, width: number) =>
        measureMarkup(pageMarkup(head, content), width);

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
    )(
        'starts %s 32 px under the hairline at %i px, all of it from the head',
        async (_state, viewport, head, content) => {
            const layout = await measure(head, content(), viewport);
            expect(layout.contentGap).toBe(32);
            expect(layout.gapWithoutHeadMargin).toBe(0);
        },
    );

    it.each(
        ROUTES.flatMap(([route, markup, firstContent]) =>
            VIEWPORTS.map((viewport) => [route, viewport, markup, firstContent] as const),
        ),
    )(
        'starts %s 32 px under the hairline at %i px, all of it from the head',
        async (_route, viewport, markup, firstContent) => {
            const layout = await measureMarkup(markup(), viewport, firstContent);
            expect(layout.contentGap).toBe(32);
            expect(layout.gapWithoutHeadMargin).toBe(0);
        },
    );

    it('wraps a long email in the eyebrow instead of scrolling a phone sideways', async () => {
        const layout = await measure(
            { width: 'narrow', eyebrow: `${LONG_EMAIL} · Free plan`, title: 'Account' },
            body(createElement('p', { className: 'mt-6' }, 'Content')),
            390,
        );
        expect(layout.scrollWidth).toBe(390);
    });
});
