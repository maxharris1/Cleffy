import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AccountPage } from '@/features/account/AccountPage';
import type * as SessionModule from '@/features/auth/session';
import type { LibraryOutletContext } from '@/features/library/LibraryShell';

/**
 * The Account page laid out with the production CSS in a real browser, inside
 * the shell's content column, against the inline layout of `Flow-Account`.
 * Needs `npm run build` and a Chromium:
 *
 *     npm run build && CLEFFY_UI_CHROMIUM=/usr/bin/google-chrome npx vitest run tests/ui/accountLayout.test.ts
 */

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ASSETS = resolve(process.cwd(), 'dist/assets');
const CSS = existsSync(ASSETS) ? readdirSync(ASSETS).find((name) => /^index-.*\.css$/.test(name)) : undefined;

vi.mock('@/features/auth/session', async (importOriginal) => ({
    ...(await importOriginal<typeof SessionModule>()),
    useSession: () => ({
        session: {
            user: {
                id: 'teacher-1',
                email: 'davis@example.org',
                created_at: '2026-01-14T10:00:00Z',
                user_metadata: { display_name: 'Ms. Davis' },
            },
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

const OUTLET: LibraryOutletContext = {
    canManageStudents: true,
    userId: 'teacher-1',
    userLabel: 'Ms. Davis',
    uploadPct: null,
    uploading: false,
    onUpload: async () => {},
    onImportImslp: async () => ({ ok: true }),
    clearUploadError: () => {},
    uploadLimit: null,
    tier: 'free',
    openPricing: () => {},
};

const accountMarkup = () =>
    renderToStaticMarkup(
        createElement(
            MemoryRouter,
            { initialEntries: ['/account'] },
            createElement(
                'div',
                { className: 'mx-auto w-full max-w-[100rem] px-4 sm:px-6 lg:px-10 py-8 lg:py-10' },
                createElement(
                    'div',
                    { className: 'library-shell min-w-0' },
                    createElement(
                        Routes,
                        null,
                        createElement(
                            Route,
                            { element: createElement(Outlet, { context: OUTLET }) },
                            createElement(Route, { path: '/account', element: createElement(AccountPage) }),
                        ),
                    ),
                ),
            ),
        ),
    );

const box = (rect: DOMRect) => ({
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
});

describe.skipIf(!CHROMIUM || !CSS)('Account layout', () => {
    let browser: Browser;
    let dir: string;

    beforeAll(async () => {
        browser = await chromium.launch({ executablePath: CHROMIUM });
        dir = mkdtempSync(join(tmpdir(), 'account-layout-'));
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const measure = async (width: number) => {
        const file = join(dir, `${width}.html`);
        const stylesheet = pathToFileURL(join(ASSETS, CSS!)).href;
        writeFileSync(
            file,
            `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${stylesheet}"></head><body>${accountMarkup()}</body></html>`,
        );
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
            await page.goto(pathToFileURL(file).href);
            await page.evaluate(() => document.fonts.ready);
            const raw = await page.evaluate(() => {
                const rect = (el: Element) => el.getBoundingClientRect().toJSON() as DOMRect;
                const section = document.querySelector('section')!;
                const [label, content] = Array.from(section.children);
                const avatar = Array.from(section.querySelectorAll<HTMLElement>('[aria-hidden="true"]')).find(
                    (el) => el.getBoundingClientRect().width === 60,
                )!;
                const avatarStyle = getComputedStyle(avatar);
                return {
                    head: rect(document.querySelector('.page-head')!),
                    label: rect(label!),
                    content: rect(content!),
                    avatarBackground: avatarStyle.backgroundColor,
                    avatarText: avatarStyle.color,
                    scrollWidth: document.documentElement.scrollWidth,
                };
            });
            return { ...raw, head: box(raw.head), label: box(raw.label), content: box(raw.content) };
        } finally {
            await page.close();
        }
    };

    it('keeps the 1440 px desktop columns: head and body at x=170, 220 px label beside a 720 px column', async () => {
        const layout = await measure(1440);
        expect(layout.head.left).toBe(170);
        expect(layout.head.width).toBe(1100);
        expect(layout.label.left).toBe(170);
        expect(layout.label.width).toBe(220);
        expect(layout.content.left).toBe(430);
        expect(layout.content.width).toBe(720);
    });

    it('uses 40 px gutters at 750 px and stacks the 670 px content column below its label', async () => {
        const layout = await measure(750);
        expect(layout.head.left).toBe(40);
        expect(layout.label.left).toBe(40);
        expect(layout.content.left).toBe(40);
        expect(layout.content.width).toBe(670);
        expect(layout.content.top).toBeGreaterThanOrEqual(layout.label.bottom);
        expect(layout.scrollWidth).toBe(750);
    });

    it('stacks the sections on a 390 px phone without scrolling sideways', async () => {
        const layout = await measure(390);
        expect(layout.content.left).toBe(layout.label.left);
        expect(layout.content.top).toBeGreaterThanOrEqual(layout.label.bottom);
        expect(layout.scrollWidth).toBe(390);
    });

    it('draws the Profile avatar in the reference palette, white on #dc2626', async () => {
        const layout = await measure(1440);
        expect(layout.avatarBackground).toBe('rgb(220, 38, 38)');
        expect(layout.avatarText).toBe('rgb(255, 255, 255)');
    });
});
