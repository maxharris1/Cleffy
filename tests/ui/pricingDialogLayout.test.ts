import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser } from 'playwright';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PricingDialog, type PricingDialogProps } from '@/features/billing/PricingDialog';

/**
 * The Plans dialog laid out with the production CSS in a real browser. Needs
 * `npm run build` and a Chromium:
 *
 *     npm run build && CLEFFY_UI_CHROMIUM=/usr/bin/google-chrome npx vitest run tests/ui/pricingDialogLayout.test.ts
 */

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ASSETS = resolve(process.cwd(), 'dist/assets');
const CSS = existsSync(ASSETS) ? readdirSync(ASSETS).find((name) => /^index-.*\.css$/.test(name)) : undefined;

vi.mock('@/ui/Dialog', () => ({
    Dialog: ({ children }: { children: ReactNode }) =>
        createElement(
            'div',
            { className: 'fixed inset-0 flex justify-center p-4' },
            createElement(
                'div',
                { className: 'dialog-paper w-full max-w-[1120px] overflow-x-hidden bg-paper p-7', role: 'dialog' },
                children,
            ),
        ),
}));

const PRICES = {
    VITE_STRIPE_PRICE_PERSONAL_MONTHLY: 'price_personal_monthly',
    VITE_STRIPE_PRICE_PERSONAL_ANNUAL: 'price_personal_annual',
    VITE_STRIPE_PRICE_TEACHER_MONTHLY: 'price_teacher_monthly',
    VITE_STRIPE_PRICE_TEACHER_ANNUAL: 'price_teacher_annual',
    VITE_STRIPE_PRICE_ACADEMY_MONTHLY: 'price_academy_monthly',
    VITE_STRIPE_PRICE_ACADEMY_ANNUAL: 'price_academy_annual',
    VITE_STRIPE_PRICE_FOUNDING_ANNUAL: 'price_founding_annual',
    VITE_STRIPE_FOUNDING_OFFER: 'true',
};

const STATES: ReadonlyArray<[string, Partial<PricingDialogProps>]> = [
    ['a free teacher offered Founding', { currentTier: 'free' }],
    ['a subscriber switching plans', { currentTier: 'personal', subscription: { endsAt: null, cancelling: false } }],
    ['a cancelling subscriber', { currentTier: 'teacher', subscription: { endsAt: null, cancelling: true } }],
];

const VIEWPORTS = [320, 390, 820, 1440] as const;

const markupFor = (props: Partial<PricingDialogProps>) => {
    for (const [name, value] of Object.entries(PRICES)) {
        vi.stubEnv(name, value);
    }
    try {
        return renderToStaticMarkup(createElement(PricingDialog, { currentTier: 'free', onClose: () => {}, ...props }));
    } finally {
        vi.unstubAllEnvs();
    }
};

describe.skipIf(!CHROMIUM || !CSS)('Plans dialog layout', () => {
    let browser: Browser;
    let dir: string;

    beforeAll(async () => {
        browser = await chromium.launch({ executablePath: CHROMIUM });
        dir = mkdtempSync(join(tmpdir(), 'plans-dialog-'));
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        rmSync(dir, { recursive: true, force: true });
    });

    /** How many lines the heading takes, and each plan card's buttons: label, how far its text runs past the button's own box, and focus ring. */
    const measureActions = async (markup: string, width: number) => {
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
            return await page.evaluate(() => {
                const heading = document.querySelector('h2')!;
                const headingLines = Math.round(
                    heading.getBoundingClientRect().height / parseFloat(getComputedStyle(heading).lineHeight),
                );
                const actions = [...document.querySelectorAll<HTMLButtonElement>('section button')].map((button) => {
                    const box = button.getBoundingClientRect();
                    const range = document.createRange();
                    range.selectNodeContents(button);
                    const text = range.getBoundingClientRect();
                    const root = getComputedStyle(document.documentElement);
                    return {
                        label: button.textContent,
                        ring:
                            getComputedStyle(button).getPropertyValue('--focus-ring').trim() ||
                            root.getPropertyValue('--color-accent').trim(),
                        card: getComputedStyle(button.closest('section')!).backgroundColor,
                        overflow: Math.max(
                            0,
                            box.left - text.left,
                            text.right - box.right,
                            button.scrollWidth - button.clientWidth,
                        ),
                    };
                });
                return { actions, headingLines };
            });
        } finally {
            await page.close();
        }
    };

    it.each(STATES.flatMap(([state, props]) => VIEWPORTS.map((width) => [state, width, props] as const)))(
        'keeps every plan action label inside its button for %s at %i px',
        async (_state, width, props) => {
            const { actions } = await measureActions(markupFor(props), width);
            expect(actions.length).toBeGreaterThan(0);
            for (const { label, overflow } of actions) {
                expect(overflow, `${label} at ${width}px`).toBe(0);
            }
        },
    );

    it('rings Resume subscription on the ink card in the ink rule, not the accent', async () => {
        const { actions } = await measureActions(
            markupFor({ currentTier: 'teacher', subscription: { endsAt: null, cancelling: true } }),
            390,
        );
        const resume = actions.find(({ label }) => label === 'Resume subscription');
        expect(resume).toMatchObject({ ring: '#818cf8', card: 'rgb(28, 25, 23)' });
    });

    it.each([1024, 1440])('sets the heading on one line at %i px', async (width) => {
        const { headingLines } = await measureActions(markupFor({ currentTier: 'free' }), width);
        expect(headingLines).toBe(1);
    });

    it('lays out the Founding action at 320 px', async () => {
        const { actions } = await measureActions(markupFor({ currentTier: 'free' }), 320);
        expect(actions.map(({ label }) => label)).toContain('Become a Founding Teacher');
    });
});
