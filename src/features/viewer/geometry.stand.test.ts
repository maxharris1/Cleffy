import { describe, expect, it } from 'vitest';

import {
    clampScroll,
    computeDocumentLayout,
    fitPageWidthScale,
    focusedPageIndex,
    PAGE_GAP,
    pageFitView,
    pageTopView,
} from '@/features/viewer/geometry';

const pages = [
    { width: 600, height: 800 },
    { width: 600, height: 800 },
    { width: 400, height: 700 },
];

describe('pageFitView (stand mode)', () => {
    const layout = computeDocumentLayout(pages, 1);

    it('fits the whole page, height-bound on a landscape screen, centred both ways', () => {
        const view = pageFitView(layout, 1, 1200, 600)!;
        expect(view.scale).toBeCloseTo((600 - PAGE_GAP * 2) / 800);
        const page = layout.layouts[1]!;
        // The page's centre lands on the viewport's.
        expect((page.left + page.width / 2) * view.scale - view.scrollX).toBeCloseTo(600);
        expect((page.top + page.height / 2) * view.scale - view.scrollY).toBeCloseTo(300);
    });

    it('fits the width on a tall phone, still centred', () => {
        const view = pageFitView(layout, 0, 390, 844)!;
        expect(view.scale).toBeCloseTo((390 - PAGE_GAP * 2) / 600);
        const page = layout.layouts[0]!;
        expect((page.top + page.height / 2) * view.scale - view.scrollY).toBeCloseTo(422);
        expect((page.left + page.width / 2) * view.scale - view.scrollX).toBeCloseTo(195);
    });

    it('centres a narrower page in its column', () => {
        const view = pageFitView(layout, 2, 1000, 1000)!;
        const page = layout.layouts[2]!;
        expect((page.left + page.width / 2) * view.scale - view.scrollX).toBeCloseTo(500);
    });

    it('has nothing to show for a page that is not there', () => {
        expect(pageFitView(layout, 3, 800, 600)).toBeNull();
        expect(pageFitView(layout, -1, 800, 600)).toBeNull();
    });
});

describe('pageTopView (leaving stand mode)', () => {
    const layout = computeDocumentLayout(pages, 1);

    it('puts the page at the top at the zoom it had, relative to fit-width', () => {
        const view = pageTopView(layout, 1, 1, 800, 600);
        expect(view.scale).toBeCloseTo(fitPageWidthScale(layout, 800));
        expect(view.scrollY).toBeCloseTo((layout.layouts[1]!.top - PAGE_GAP) * view.scale);
        expect(focusedPageIndex(view, 600, layout.layouts)).toBe(1);

        const zoomed = pageTopView(layout, 1, 2, 800, 600);
        expect(zoomed.scale).toBeCloseTo(fitPageWidthScale(layout, 800) * 2);
    });

    it('keeps the page clear of a toolbar docked at the top', () => {
        const view = pageTopView(layout, 1, 1, 800, 600, { top: 60, bottom: 0 });
        expect(view.scrollY).toBeCloseTo((layout.layouts[1]!.top - PAGE_GAP) * view.scale - 60);
    });

    it('stays inside the scroll bounds at the last page', () => {
        const view = pageTopView(layout, 2, 1, 800, 600);
        expect(view).toEqual(clampScroll(view, layout, 800, 600));
    });
});
