import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser } from 'playwright';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
    ChildrenPrivacyPage,
    CopyrightPolicyPage,
    PrivacyPage,
    RefundPolicyPage,
    TermsPage,
} from '@/features/legal/LegalPage';
import { ReportContentPage } from '@/features/moderation/ReportContentPage';

/**
 * The legal and report headers laid out with the production CSS in a real
 * Chromium with touch, so the coarse-pointer hit areas apply. Needs
 * `npm run build` and a Chromium:
 *
 *     npm run build && CLEFFY_UI_CHROMIUM=/usr/bin/google-chrome npx vitest run tests/ui/documentHeaderLayout.test.ts
 */

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ASSETS = resolve(process.cwd(), 'dist/assets');
const CSS = existsSync(ASSETS) ? readdirSync(ASSETS).find((name) => /^index-.*\.css$/.test(name)) : undefined;

const PAGES: ReadonlyArray<[string, string, ComponentType]> = [
    ['report form', '/report', ReportContentPage],
    ['illegal-content report form', '/report?kind=illegal', ReportContentPage],
    ['privacy policy', '/privacy', PrivacyPage],
    ['children’s privacy notice', '/children-privacy', ChildrenPrivacyPage],
    ['terms', '/terms', TermsPage],
    ['refund policy', '/refunds', RefundPolicyPage],
    ['copyright policy', '/copyright', CopyrightPolicyPage],
];

const WIDTHS = [320, 390] as const;

type Target = { name: string; left: number; top: number; right: number; bottom: number };

describe.skipIf(!CHROMIUM || !CSS)('DocumentHeader touch targets', () => {
    let browser: Browser;
    let dir: string;

    beforeAll(async () => {
        browser = await chromium.launch({ executablePath: CHROMIUM });
        dir = mkdtempSync(join(tmpdir(), 'cleffy-document-header-'));
    });

    afterAll(async () => {
        await browser?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const headerTargets = async (path: string, page: ComponentType, width: number): Promise<Target[]> => {
        const markup = renderToStaticMarkup(
            createElement(MemoryRouter, { initialEntries: [path] }, createElement(page)),
        );
        const file = join(dir, `${Math.random().toString(36).slice(2)}.html`);
        writeFileSync(
            file,
            `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${pathToFileURL(join(ASSETS, CSS!)).href}"></head><body><div id="root">${markup}</div></body></html>`,
        );
        const tab = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true });
        try {
            await tab.goto(pathToFileURL(file).href);
            await tab.evaluate(() => document.fonts.ready);
            expect(await tab.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
            return await tab.evaluate(() =>
                [...document.querySelectorAll<HTMLElement>('header a')].map((link) => {
                    const box = link.getBoundingClientRect();
                    const after = getComputedStyle(link, '::after');
                    const px = (value: string) => (value.endsWith('px') ? Number.parseFloat(value) : 0);
                    const hit =
                        after.position === 'absolute'
                            ? {
                                  left: box.left + px(after.left),
                                  top: box.top + px(after.top),
                                  right: box.right - px(after.right),
                                  bottom: box.bottom - px(after.bottom),
                              }
                            : { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
                    return {
                        name: link.getAttribute('href') === '/' ? 'home' : (link.textContent ?? ''),
                        left: Math.min(box.left, hit.left),
                        top: Math.min(box.top, hit.top),
                        right: Math.max(box.right, hit.right),
                        bottom: Math.max(box.bottom, hit.bottom),
                    };
                }),
            );
        } finally {
            await tab.close();
        }
    };

    it.each(PAGES.flatMap(([name, path, page]) => WIDTHS.map((width) => [name, width, path, page] as const)))(
        'keeps the home target clear of every other header target on the %s at %i px',
        async (_name, width, path, page) => {
            const targets = await headerTargets(path, page, width);
            const home = targets.find((target) => target.name === 'home')!;
            expect(home.bottom - home.top).toBeGreaterThanOrEqual(44);
            const overlaps = targets
                .filter((target) => target !== home)
                .map((target) => ({
                    name: target.name,
                    width: Math.min(home.right, target.right) - Math.max(home.left, target.left),
                    height: Math.min(home.bottom, target.bottom) - Math.max(home.top, target.top),
                }))
                .filter((overlap) => overlap.width > 0 && overlap.height > 0);
            expect(overlaps).toEqual([]);
        },
    );
});
