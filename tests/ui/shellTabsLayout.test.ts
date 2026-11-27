import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TermsPage } from '@/features/legal/LegalPage';
import { LibraryShell } from '@/features/library/LibraryShell';

/**
 * The shell laid out with the production CSS in a real browser. Needs
 * `npm run build` and a Chromium:
 *
 *     npm run build && CLEFFY_UI_CHROMIUM=/usr/bin/google-chrome npx vitest run tests/ui/shellTabsLayout.test.ts
 */

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ASSETS = resolve(process.cwd(), 'dist/assets');
const CSS = existsSync(ASSETS) ? readdirSync(ASSETS).find((name) => /^index-.*\.css$/.test(name)) : undefined;

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

const ROWS = 40;

const rows = () =>
    createElement(
        'ul',
        null,
        Array.from({ length: ROWS }, (_, index) =>
            createElement(
                'li',
                { key: index, className: 'library-list-item border-b border-line py-3' },
                createElement('a', { href: `#row-${index}`, className: 'row-link font-medium' }, `Score ${index + 1}`),
            ),
        ),
    );

const stickyFooterPage = () =>
    createElement(
        'div',
        null,
        createElement('div', { style: { height: '2000px' } }, 'Editions'),
        createElement(
            'div',
            { className: 'imslp-action-footer' },
            createElement('a', { href: '#learn' }, 'Learn more'),
        ),
    );

const shellMarkup = (path: string, page: () => unknown) =>
    renderToStaticMarkup(
        createElement(
            MemoryRouter,
            { initialEntries: [path] },
            createElement(
                Routes,
                null,
                createElement(
                    Route,
                    { element: createElement(LibraryShell) },
                    createElement(Route, { path, element: page() as never }),
                ),
            ),
        ),
    );

const termsMarkup = () =>
    renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/terms'] }, createElement(TermsPage)));

type Setup = { width: number; height?: number; rootFont?: string; safeBottom?: string; touch?: boolean };

describe.skipIf(!CHROMIUM || !CSS)('Shell tab bar layout', () => {
    let browser: Browser;
    let dir: string;

    beforeAll(async () => {
        browser = await chromium.launch({ executablePath: CHROMIUM });
        dir = mkdtempSync(join(tmpdir(), 'shell-tabs-'));
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const withPage = async <T>(markup: string, setup: Setup, run: (page: Page) => Promise<T>) => {
        const file = join(dir, `${Math.random().toString(36).slice(2)}.html`);
        const stylesheet = pathToFileURL(join(ASSETS, CSS!)).href;
        const rootStyle = [
            setup.rootFont ? `font-size:${setup.rootFont}` : '',
            setup.safeBottom ? `--safe-bottom:${setup.safeBottom}` : '',
        ].join(';');
        writeFileSync(
            file,
            `<!doctype html><html style="${rootStyle}"><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${stylesheet}"><style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><div id="root">${markup}</div></body></html>`,
        );
        const page = await browser.newPage({
            viewport: { width: setup.width, height: setup.height ?? 844 },
            hasTouch: setup.touch ?? false,
        });
        try {
            await page.goto(pathToFileURL(file).href);
            await page.evaluate(() => document.fonts.ready);
            return await run(page);
        } finally {
            await page.close();
        }
    };

    const tabsTop = (page: Page) =>
        page.evaluate(() => document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect().top);

    it.each([
        [390, undefined],
        [390, '34px'],
        [320, '34px'],
    ] as const)(
        'scrolls every row focused from the keyboard clear of the tab bar at %i px, safe area %s',
        async (width, safeBottom) => {
            const covered = await withPage(shellMarkup('/library', rows), { width, safeBottom }, async (page) => {
                const hidden: string[] = [];
                await page.focus('nav[aria-label="Main"] a:last-child');
                for (let index = 0; index < ROWS + 8; index += 1) {
                    await page.keyboard.press('Tab');
                    const focused = await page.evaluate(() => {
                        const element = document.activeElement as HTMLElement;
                        if (!element.classList.contains('row-link')) return null;
                        const rect = element.getBoundingClientRect();
                        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                        const nav = document.querySelector('nav[aria-label="Main"]')!;
                        return {
                            label: element.textContent!,
                            visible: hit === element || element.contains(hit),
                            clear: rect.bottom <= nav.getBoundingClientRect().top,
                        };
                    });
                    if (focused && !(focused.visible && focused.clear)) hidden.push(focused.label);
                }
                return hidden;
            });
            expect(covered).toEqual([]);
        },
    );

    it('leaves the scroll alone when Tab focuses a link already in view on a page without the tab bar', async () => {
        const scroll = await withPage(termsMarkup(), { width: 390, height: 600 }, async (page) => {
            const contents = 'nav[aria-label="Contents"] a';
            const before = await page.evaluate((selector) => {
                const links = [...document.querySelectorAll<HTMLElement>(selector)];
                window.scrollBy(0, links.at(-1)!.getBoundingClientRect().bottom - (window.innerHeight - 20));
                links.at(-2)!.focus({ preventScroll: true });
                return window.scrollY;
            }, contents);
            await page.keyboard.press('Tab');
            return page.evaluate(
                ({ selector, before }) => ({
                    before,
                    after: window.scrollY,
                    focused: document.activeElement === [...document.querySelectorAll(selector)].at(-1),
                }),
                { selector: contents, before },
            );
        });
        expect(scroll.before).toBeGreaterThan(0);
        expect(scroll.focused).toBe(true);
        expect(scroll.after).toBe(scroll.before);
    });

    it.each([
        [390, '12px'],
        [390, '9px'],
        [320, '12px'],
        [320, '9px'],
    ] as const)('keeps the last row above the tab bar at %i px with a %s default font', async (width, rootFont) => {
        const gap = await withPage(
            shellMarkup('/library', rows),
            { width, rootFont, safeBottom: '34px' },
            async (page) => {
                await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
                const top = await tabsTop(page);
                return page.evaluate(
                    (navTop) => navTop - document.querySelector('li:last-child')!.getBoundingClientRect().bottom,
                    top,
                );
            },
        );
        expect(gap).toBeGreaterThanOrEqual(0);
    });

    it.each([
        [390, '16px'],
        [390, '12px'],
        [320, '9px'],
    ] as const)(
        'parks the edition picker footer on the tab bar at %i px with a %s default font',
        async (width, rootFont) => {
            const layout = await withPage(
                shellMarkup('/search', stickyFooterPage),
                { width, rootFont, safeBottom: '34px' },
                async (page) => {
                    const top = await tabsTop(page);
                    return page.evaluate((navTop) => {
                        const footer = document.querySelector('.imslp-action-footer')!.getBoundingClientRect();
                        const link = [...document.querySelectorAll('a')].find((a) => a.textContent === 'Learn more')!;
                        const rect = link.getBoundingClientRect();
                        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                        return { overlap: footer.bottom - navTop, linkVisible: hit === link || link.contains(hit) };
                    }, top);
                },
            );
            expect(layout.overlap).toBe(0);
            expect(layout.linkVisible).toBe(true);
        },
    );

    it('sizes the tab bar to 61 px plus the safe area whatever the default font', async () => {
        const heights = await Promise.all(
            ['16px', '12px', '9px'].map((rootFont) =>
                withPage(shellMarkup('/library', rows), { width: 390, rootFont, safeBottom: '34px' }, (page) =>
                    page.evaluate(
                        () => document.querySelector('nav[aria-label="Main"]')!.getBoundingClientRect().height,
                    ),
                ),
            ),
        );
        expect(heights).toEqual([95, 95, 95]);
    });

    it.each([
        [390, '16px'],
        [390, '12px'],
        [320, '9px'],
    ] as const)(
        'keeps the phone upload button 44 by 44 px at %i px with a %s default font',
        async (width, rootFont) => {
            const size = await withPage(shellMarkup('/library', rows), { width, rootFont }, (page) =>
                page.evaluate(() => {
                    const rect = document.querySelector('label.shell-upload')!.getBoundingClientRect();
                    return { width: rect.width, height: rect.height };
                }),
            );
            expect(size).toEqual({ width: 44, height: 44 });
        },
    );

    it.each([
        [320, '16px'],
        [320, '12px'],
        [320, '9px'],
        [390, '16px'],
        [390, '12px'],
        [390, '9px'],
    ] as const)(
        "lands a touch 43 px from the upload button's left edge on Upload score at %i px with a %s default font",
        async (width, rootFont) => {
            const hit = await withPage(
                shellMarkup('/library', rows),
                { width, rootFont, touch: true },
                async (page) => {
                    const point = await page.evaluate(() => {
                        const rect = document.querySelector('label.shell-upload')!.getBoundingClientRect();
                        return { x: rect.left + 43, y: rect.top + rect.height / 2 };
                    });
                    await page.evaluate(() => {
                        document.addEventListener(
                            'touchstart',
                            (event) => {
                                const target = event.target as Element;
                                const label = target.closest('label.shell-upload');
                                document.body.dataset.touched = label
                                    ? label.querySelector('input')!.getAttribute('aria-label')!
                                    : (target.closest('[aria-label]')?.getAttribute('aria-label') ?? target.tagName);
                            },
                            { once: true },
                        );
                    });
                    await page.touchscreen.tap(point.x, point.y);
                    return page.evaluate(() => document.body.dataset.touched);
                },
            );
            expect(hit).toBe('Upload score');
        },
    );

    it.each([640, 768, 1280])(
        'sets every top-bar tab at %i px in the 15 px type and line height it had before the phone shell',
        async (width) => {
            const tabs = await withPage(shellMarkup('/library', rows), { width }, (page) =>
                page.evaluate(() =>
                    [...document.querySelectorAll('nav[aria-label="Main"] a')].map((link) => {
                        const style = getComputedStyle(link);
                        return {
                            current: link.getAttribute('aria-current') === 'page',
                            fontSize: style.fontSize,
                            lineHeight: Number.parseFloat(style.lineHeight).toFixed(3),
                            fontWeight: style.fontWeight,
                        };
                    }),
                ),
            );
            expect(tabs).toEqual([
                { current: true, fontSize: '15px', lineHeight: '21.429', fontWeight: '600' },
                { current: false, fontSize: '15px', lineHeight: '21.429', fontWeight: '500' },
                { current: false, fontSize: '15px', lineHeight: '21.429', fontWeight: '500' },
            ]);
        },
    );
});
