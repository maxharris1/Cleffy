import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser } from 'playwright';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ScoreRow } from '@/features/library/LibraryPage';
import { LocalOpenControl } from '@/features/library/LocalOpenControl';
import type { ScoreActions } from '@/features/library/scoreRow';
import type { DocumentRow } from '@/types/database';

/**
 * The Library's restyled controls on a phone with a coarse pointer: every
 * point of a 44x44 square centred on each control must hit that control, so
 * the target is big enough and no neighbour covers any of it. Needs
 * `npm run build` and a Chromium:
 *
 *     npm run build && CLEFFY_UI_CHROMIUM=/usr/bin/google-chrome npx vitest run tests/ui/libraryTouchTargets.test.ts
 */

const CHROMIUM = process.env.CLEFFY_UI_CHROMIUM ?? '';
const ASSETS = resolve(process.cwd(), 'dist/assets');
const CSS = existsSync(ASSETS) ? readdirSync(ASSETS).find((name) => /^index-.*\.css$/.test(name)) : undefined;

const MIN_TARGET = 44;

const doc: DocumentRow = {
    id: 'doc-1',
    owner_id: 'owner-1',
    title: 'Clair de lune',
    storage_path: 'owner-1/doc-1.pdf',
    page_count: 6,
    content_rev: 0,
    thumb_rev: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    archived_at: null,
};

const noop = () => {};
const actions: ScoreActions = {
    toggleFavorite: noop,
    rename: noop,
    share: noop,
    remove: noop,
    leave: noop,
    editTags: noop,
    filterTag: noop,
};

const row = (isOwner: boolean) =>
    createElement(
        'ul',
        null,
        createElement(ScoreRow, {
            doc,
            index: 0,
            stripComposer: false,
            assignedTags: [],
            isFavorite: false,
            isOwner,
            actions,
        }),
    );

const ROW_TARGETS = ['[aria-label="Add to favorites"]', '[aria-label="Add tags"]', '[aria-label="Score actions"]'];

const CASES: Array<[name: string, element: ReactElement, selectors: string[]]> = [
    [
        'local-open page link',
        createElement(LocalOpenControl, { label: 'Open locally without uploading', page: true }),
        ['label'],
    ],
    [
        'empty-state local-open link',
        createElement(LocalOpenControl, { label: 'Or open a PDF locally without uploading', page: true }),
        ['label'],
    ],
    ['owner list row', row(true), ROW_TARGETS],
    ['shared list row', row(false), ROW_TARGETS],
];

describe.skipIf(!CHROMIUM || !CSS)('Library touch targets at 390 px with a coarse pointer', () => {
    let browser: Browser | undefined;
    let dir: string | undefined;

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'library-touch-targets-'));
        browser = await chromium.launch({ executablePath: CHROMIUM });
    }, 60_000);

    afterAll(async () => {
        await browser?.close();
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    const measure = async (element: ReactElement, selectors: string[]) => {
        const markup = renderToStaticMarkup(createElement(MemoryRouter, null, element));
        const file = join(dir!, `${Math.random().toString(36).slice(2)}.html`);
        const stylesheet = pathToFileURL(join(ASSETS, CSS!)).href;
        // The page gutter keeps each 44px square inside the viewport, where elementFromPoint can see it.
        writeFileSync(
            file,
            `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${stylesheet}"></head><body><div style="padding:48px 24px">${markup}</div></body></html>`,
        );
        const page = await browser!.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        try {
            await page.goto(pathToFileURL(file).href);
            await page.evaluate(() => document.fonts.ready);
            return await page.evaluate(
                ({ selectors, size }) => {
                    const describe = (node: Element | null) =>
                        node
                            ? `${node.tagName.toLowerCase()}${node.getAttribute('aria-label') ? `[${node.getAttribute('aria-label')}]` : ''}`
                            : 'nothing';
                    const steps = 12;
                    const targets = selectors.map((selector) => {
                        const target = document.querySelector(selector)!;
                        const { left, top, width, height } = target.getBoundingClientRect();
                        const cx = left + width / 2;
                        const cy = top + height / 2;
                        const misses: string[] = [];
                        for (let i = 0; i < steps; i++) {
                            for (let j = 0; j < steps; j++) {
                                const x = cx - size / 2 + ((i + 0.5) * size) / steps;
                                const y = cy - size / 2 + ((j + 0.5) * size) / steps;
                                const hit = document.elementFromPoint(x, y);
                                if (!hit || !target.contains(hit)) {
                                    misses.push(`(${(x - cx).toFixed(1)}, ${(y - cy).toFixed(1)}) -> ${describe(hit)}`);
                                }
                            }
                        }
                        return { selector, width, height, misses };
                    });
                    return { coarse: matchMedia('(pointer: coarse)').matches, targets };
                },
                { selectors, size: MIN_TARGET },
            );
        } finally {
            await page.close();
        }
    };

    it.each(CASES)('gives every target in the %s a 44x44 hit area of its own', async (_name, element, selectors) => {
        const { coarse, targets } = await measure(element, selectors);

        expect(coarse).toBe(true);
        for (const target of targets) {
            expect(target.width, target.selector).toBeGreaterThan(0);
            expect(target.height, target.selector).toBeGreaterThan(0);
            expect(target.misses, `${target.selector} is ${target.width}x${target.height}`).toEqual([]);
        }
    });
});
