import { describe, expect, it } from 'vitest';

import { computeDocumentLayout, PAGE_GAP, pageFitView, pageRow } from '@/features/viewer/geometry';
import { standPageAfter } from '@/features/viewer/stand/standMode';

const page = { width: 600, height: 800 };
const five = [page, page, page, page, page];
const plain = computeDocumentLayout(five, 2, false);
const cover = computeDocumentLayout(five, 2, true);
const single = computeDocumentLayout(five, 1, false);

describe('pageRow', () => {
    it('is the page alone in one column', () => {
        expect(pageRow(single.layouts, 3)).toEqual({ first: 3, last: 3 });
    });

    it('is the whole spread from either half in two columns', () => {
        expect(pageRow(plain.layouts, 0)).toEqual({ first: 0, last: 1 });
        expect(pageRow(plain.layouts, 1)).toEqual({ first: 0, last: 1 });
        expect(pageRow(plain.layouts, 4)).toEqual({ first: 4, last: 4 });
    });

    it('pairs 1 | 2-3 | 4-5 behind a cover', () => {
        expect(pageRow(cover.layouts, 0)).toEqual({ first: 0, last: 0 });
        expect(pageRow(cover.layouts, 2)).toEqual({ first: 1, last: 2 });
        expect(pageRow(cover.layouts, 3)).toEqual({ first: 3, last: 4 });
    });

    it('is empty past the end', () => {
        expect(pageRow(single.layouts, 9)).toEqual({ first: 0, last: -1 });
    });
});

describe('standPageAfter with two pages side by side', () => {
    it('turns a whole spread at a time', () => {
        expect(standPageAfter(plain.layouts, 0, 1)).toBe(2);
        expect(standPageAfter(plain.layouts, 2, 1)).toBe(4);
        expect(standPageAfter(plain.layouts, 4, -1)).toBe(2);
        expect(standPageAfter(plain.layouts, 2, -1)).toBe(0);
    });

    it('turns from the right half of a spread as from its left', () => {
        expect(standPageAfter(plain.layouts, 3, 1)).toBe(4);
        expect(standPageAfter(plain.layouts, 3, -1)).toBe(0);
        expect(standPageAfter(cover.layouts, 2, 1)).toBe(3);
        expect(standPageAfter(cover.layouts, 2, -1)).toBe(0);
    });

    it('steps cover, 2-3, 4-5 and back, never wrapping', () => {
        expect(standPageAfter(cover.layouts, 0, -1)).toBeNull();
        expect(standPageAfter(cover.layouts, 0, 1)).toBe(1);
        expect(standPageAfter(cover.layouts, 1, 1)).toBe(3);
        expect(standPageAfter(cover.layouts, 3, 1)).toBeNull();
        expect(standPageAfter(cover.layouts, 4, 1)).toBeNull();
        expect(standPageAfter(cover.layouts, 3, -1)).toBe(1);
        expect(standPageAfter(cover.layouts, 1, -1)).toBe(0);
    });
});

describe('pageFitView with two pages side by side', () => {
    /** Where a layout point lands on screen. */
    const onScreen = (view: { scale: number; scrollX: number; scrollY: number }, x: number, y: number) => ({
        x: x * view.scale - view.scrollX,
        y: y * view.scale - view.scrollY,
    });

    it('fits the whole spread and centres it both ways', () => {
        const view = pageFitView(plain, 2, 1366, 1024, 2)!;
        expect(view.scale).toBeCloseTo((1366 - PAGE_GAP * 2) / plain.contentWidth);
        const row = plain.layouts[2]!;
        expect(onScreen(view, plain.contentWidth / 2, row.top + row.height / 2).x).toBeCloseTo(683);
        expect(onScreen(view, plain.contentWidth / 2, row.top + row.height / 2).y).toBeCloseTo(512);
        // Both pages wholly on screen.
        for (const p of [plain.layouts[2]!, plain.layouts[3]!]) {
            expect(onScreen(view, p.left, p.top).x).toBeGreaterThanOrEqual(0);
            expect(onScreen(view, p.left + p.width, p.top + p.height).x).toBeLessThanOrEqual(1366);
            expect(onScreen(view, p.left, p.top).y).toBeGreaterThanOrEqual(0);
            expect(onScreen(view, p.left, p.top + p.height).y).toBeLessThanOrEqual(1024);
        }
    });

    it('lands the same spread from either half', () => {
        expect(pageFitView(plain, 3, 1366, 1024, 2)).toEqual(pageFitView(plain, 2, 1366, 1024, 2));
    });

    it('keeps one zoom for every row, a cover on the right and a last page alone on the left', () => {
        const coverView = pageFitView(cover, 0, 1366, 1024, 2)!;
        const spreadView = pageFitView(cover, 1, 1366, 1024, 2)!;
        expect(coverView.scale).toBeCloseTo(spreadView.scale);
        const coverPage = cover.layouts[0]!;
        expect(onScreen(coverView, coverPage.left, coverPage.top).x).toBeGreaterThan(683);

        const lastView = pageFitView(plain, 4, 1366, 1024, 2)!;
        const last = plain.layouts[4]!;
        expect(lastView.scale).toBeCloseTo(spreadView.scale);
        expect(onScreen(lastView, last.left + last.width, last.top).x).toBeLessThan(683);
    });

    it('fits a single page as before in one column', () => {
        const view = pageFitView(single, 1, 1366, 1024)!;
        expect(view.scale).toBeCloseTo((1024 - PAGE_GAP * 2) / page.height);
    });
});
