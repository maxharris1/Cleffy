import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser } from 'playwright';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SignInArt } from '@/features/marketing/SignInArt';
import { SplitBrandShell } from '@/ui/BrandShell';
import { Button } from '@/ui/Button';

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ASSETS = resolve(process.cwd(), 'dist/assets');
const CSS = existsSync(ASSETS) ? readdirSync(ASSETS).find((name) => /^index-.*\.css$/.test(name)) : undefined;

const PHONE = 390;
const GUTTER = 24;
const HEADLINE = 'Ada invited you to MendelssohnViolinConcerto as an editor';

const shellMarkup = (title: string, subtitle: string | undefined, child: ReactNode) =>
    renderToStaticMarkup(
        createElement(
            MemoryRouter,
            { initialEntries: ['/invite'] },
            createElement(SplitBrandShell, { art: createElement(SignInArt), title, subtitle }, child),
        ),
    );

const INVITE_STEPS: ReadonlyArray<[string, () => string]> = [
    ['the invite', () => shellMarkup(HEADLINE, undefined, createElement(Button, { className: 'w-full' }, 'Continue'))],
    ['the password step', () => shellMarkup('Choose a password', HEADLINE, createElement('div', null))],
];

describe.skipIf(!CHROMIUM || !CSS)('SplitBrandShell layout', () => {
    let browser: Browser;
    let dir: string;

    beforeAll(async () => {
        browser = await chromium.launch({ executablePath: CHROMIUM });
        dir = mkdtempSync(join(tmpdir(), 'split-shell-'));
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const measure = async (markup: string, width: number) => {
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
            await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
            return await page.evaluate(() => ({
                scrollWidth: document.documentElement.scrollWidth,
                headingRight: document.querySelector('h1')!.getBoundingClientRect().right,
            }));
        } finally {
            await page.close();
        }
    };

    it.each(INVITE_STEPS)('keeps %s inside its gutters at 390 px', async (_step, markup) => {
        const layout = await measure(markup(), PHONE);
        expect(layout.scrollWidth).toBe(PHONE);
        expect(layout.headingRight).toBeLessThanOrEqual(PHONE - GUTTER);
    });
});
