import { describe, expect, it } from 'vitest';

import {
    clampScroll,
    computeDocumentLayout,
    fitPageWidthScale,
    focusedPageIndex,
    MAX_SCALE,
    MIN_SCALE,
    PAGE_GAP,
    pagePointToViewport,
    pageTurnView,
    scrollForPagePoint,
    viewportToPagePoint,
    visiblePageRange,
    zoomAt,
} from '@/features/viewer/geometry';

const pages = [
    { width: 600, height: 800 },
    { width: 600, height: 800 },
    { width: 400, height: 700 },
];

describe('computeDocumentLayout', () => {
    it('stacks pages vertically with gaps and centers narrow pages', () => {
        const { layouts, contentWidth, contentHeight } = computeDocumentLayout(pages);
        expect(contentWidth).toBe(600);
        expect(layouts[0]).toEqual({ top: PAGE_GAP, left: 0, width: 600, height: 800 });
        expect(layouts[1]?.top).toBe(PAGE_GAP + 800 + PAGE_GAP);
        expect(layouts[2]?.left).toBe(100); // (600 - 400) / 2
        expect(contentHeight).toBe(PAGE_GAP + (800 + PAGE_GAP) * 2 + 700 + PAGE_GAP);
    });

    it('handles an empty document', () => {
        const layout = computeDocumentLayout([]);
        expect(layout.layouts).toHaveLength(0);
        expect(layout.contentWidth).toBe(0);
    });

    it('pairs pages into spreads with two columns, the odd last page alone on the left', () => {
        const { layouts, contentWidth, contentHeight } = computeDocumentLayout(pages, 2);
        expect(contentWidth).toBe(600 * 2 + PAGE_GAP);
        // Row 1: pages 0 and 1 side by side, sharing a top.
        expect(layouts[0]).toEqual({ top: PAGE_GAP, left: 0, width: 600, height: 800 });
        expect(layouts[1]).toEqual({ top: PAGE_GAP, left: 600 + PAGE_GAP, width: 600, height: 800 });
        // Row 2: the narrow page 2 centered in the left column.
        expect(layouts[2]).toEqual({ top: PAGE_GAP + 800 + PAGE_GAP, left: 100, width: 400, height: 700 });
        expect(contentHeight).toBe(PAGE_GAP + 800 + PAGE_GAP + 700 + PAGE_GAP);
    });

    it('makes a two-column row as tall as its taller page', () => {
        const uneven = [
            { width: 600, height: 500 },
            { width: 600, height: 900 },
            { width: 600, height: 500 },
        ];
        const { layouts } = computeDocumentLayout(uneven, 2);
        expect(layouts[2]?.top).toBe(PAGE_GAP + 900 + PAGE_GAP);
    });

    it('holds the cover alone in the right column and pairs 2|3 after it', () => {
        // Four pages: cover alone, then (1,2), then the odd page 3 alone on the left.
        const four = [...pages, { width: 600, height: 800 }];
        const { layouts, contentWidth, contentHeight } = computeDocumentLayout(four, 2, true);
        expect(contentWidth).toBe(600 * 2 + PAGE_GAP);
        // Row 1: page 0 in the RIGHT column, nothing on the left.
        expect(layouts[0]).toEqual({ top: PAGE_GAP, left: 600 + PAGE_GAP, width: 600, height: 800 });
        // Row 2: pages 1 and 2 as a spread, sharing a top. Page 2 is narrow, so
        // it is centered in the right column.
        const row2Top = PAGE_GAP + 800 + PAGE_GAP;
        expect(layouts[1]).toEqual({ top: row2Top, left: 0, width: 600, height: 800 });
        expect(layouts[2]).toEqual({ top: row2Top, left: 600 + PAGE_GAP + 100, width: 400, height: 700 });
        // Row 3: the odd trailing page alone on the LEFT.
        expect(layouts[3]).toEqual({ top: row2Top + 800 + PAGE_GAP, left: 0, width: 600, height: 800 });
        expect(contentHeight).toBe(PAGE_GAP + (800 + PAGE_GAP) * 3);
    });

    it('ignores the cover option in a single column', () => {
        expect(computeDocumentLayout(pages, 1, true)).toEqual(computeDocumentLayout(pages, 1));
    });

    it('keeps visible range and focus row-aware in two columns', () => {
        const { layouts } = computeDocumentLayout([...pages, { width: 600, height: 800 }], 2);
        // A viewport on the first row sees both of its pages plus the overscan row.
        expect(visiblePageRange({ scale: 1, scrollX: 0, scrollY: 0 }, 400, layouts, 0)).toEqual({ start: 0, end: 1 });
        // Centered on the second row: the left page of the pair is the focus.
        const row2Top = layouts[2]?.top ?? 0;
        expect(focusedPageIndex({ scale: 1, scrollX: 0, scrollY: row2Top }, 400, layouts)).toBe(2);
    });
});

describe('pageTurnView', () => {
    const view = { scale: 2, scrollX: 40, scrollY: 0 };

    it('steps one page at a time in a single column and lands its top at the viewport top', () => {
        const layout = computeDocumentLayout(pages);
        const next = pageTurnView(view, layout, 0, 1, 800, 600);
        expect(next?.pageIndex).toBe(1);
        expect(next?.view.scale).toBe(2);
        expect(next?.view.scrollY).toBe(((layout.layouts[1]?.top ?? 0) - PAGE_GAP) * 2);
        expect(pageTurnView(view, layout, 1, -1, 800, 600)?.pageIndex).toBe(0);
    });

    it('returns null at either end of the document', () => {
        const layout = computeDocumentLayout(pages);
        expect(pageTurnView(view, layout, 0, -1, 800, 600)).toBeNull();
        expect(pageTurnView(view, layout, 2, 1, 800, 600)).toBeNull();
        expect(pageTurnView(view, layout, 99, 1, 800, 600)).toBeNull();
    });

    it('steps a whole spread in two columns, from either page of the pair', () => {
        const layout = computeDocumentLayout([...pages, { width: 600, height: 800 }], 2);
        expect(pageTurnView(view, layout, 0, 1, 800, 600)?.pageIndex).toBe(2);
        expect(pageTurnView(view, layout, 1, 1, 800, 600)?.pageIndex).toBe(2);
        expect(pageTurnView(view, layout, 3, -1, 800, 600)?.pageIndex).toBe(0);
        expect(pageTurnView(view, layout, 2, -1, 800, 600)?.pageIndex).toBe(0);
        expect(pageTurnView(view, layout, 3, 1, 800, 600)).toBeNull();
    });

    it('steps from the cover row to the 2|3 spread and back', () => {
        const layout = computeDocumentLayout([...pages, { width: 600, height: 800 }], 2, true);
        // The cover is a row of its own: forward lands on page 1, the left of the pair.
        const next = pageTurnView(view, layout, 0, 1, 800, 600);
        expect(next?.pageIndex).toBe(1);
        expect(next?.view.scrollY).toBe(((layout.layouts[1]?.top ?? 0) - PAGE_GAP) * 2);
        // Back from either page of the spread returns to the cover.
        expect(pageTurnView(view, layout, 1, -1, 800, 600)?.pageIndex).toBe(0);
        expect(pageTurnView(view, layout, 2, -1, 800, 600)?.pageIndex).toBe(0);
        // Forward from the spread reaches the trailing page; the cover has no page before it.
        expect(pageTurnView(view, layout, 2, 1, 800, 600)?.pageIndex).toBe(3);
        expect(pageTurnView(view, layout, 0, -1, 800, 600)).toBeNull();
    });

    it('clamps the target so a short last page does not over-scroll', () => {
        const layout = computeDocumentLayout(pages);
        const tall = { width: 800, height: 5000 };
        const turned = pageTurnView({ scale: 1, scrollX: 0, scrollY: 0 }, layout, 1, 1, tall.width, tall.height);
        expect(turned?.pageIndex).toBe(2);
        expect(turned?.view.scrollY).toBe(0); // content shorter than the viewport
    });
});

describe('visiblePageRange', () => {
    const { layouts } = computeDocumentLayout(pages);

    it('returns the first page plus overscan at the top', () => {
        const range = visiblePageRange({ scale: 1, scrollX: 0, scrollY: 0 }, 400, layouts);
        expect(range).toEqual({ start: 0, end: 1 });
    });

    it('accounts for zoom when locating pages', () => {
        // At 2x, scrollY 1700 corresponds to base y 850 — inside page 2 (top 832).
        const range = visiblePageRange({ scale: 2, scrollX: 0, scrollY: 1700 }, 400, layouts);
        expect(range.start).toBe(0); // page 1 + overscan
        expect(range.end).toBeGreaterThanOrEqual(1);
    });

    it('clamps to the last pages when over-scrolled', () => {
        const range = visiblePageRange({ scale: 1, scrollX: 0, scrollY: 99999 }, 400, layouts);
        expect(range.end).toBe(2);
    });

    it('handles empty layouts', () => {
        expect(visiblePageRange({ scale: 1, scrollX: 0, scrollY: 0 }, 400, [])).toEqual({ start: 0, end: -1 });
    });
});

describe('focusedPageIndex', () => {
    const { layouts } = computeDocumentLayout(pages);

    it('returns the page nearest the viewport center', () => {
        expect(focusedPageIndex({ scale: 1, scrollX: 0, scrollY: 0 }, 400, layouts)).toBe(0);
        // Scroll so viewport center sits on page 1.
        const page1Top = layouts[1]?.top ?? 0;
        expect(focusedPageIndex({ scale: 1, scrollX: 0, scrollY: page1Top }, 400, layouts)).toBe(1);
    });

    it('returns 0 for empty layouts', () => {
        expect(focusedPageIndex({ scale: 1, scrollX: 0, scrollY: 0 }, 400, [])).toBe(0);
    });
});

describe('zoomAt', () => {
    it('keeps the anchor point stationary', () => {
        const view = { scale: 1, scrollX: 100, scrollY: 200 };
        const zoomed = zoomAt(view, 2, 50, 80);
        // Content coordinate under the anchor before: (150, 280). After: must render at the same
        // viewport point: contentPoint * 2 - scroll = anchor.
        expect(150 * 2 - zoomed.scrollX).toBeCloseTo(50);
        expect(280 * 2 - zoomed.scrollY).toBeCloseTo(80);
        expect(zoomed.scale).toBe(2);
    });

    it('clamps to scale bounds', () => {
        const view = { scale: 1, scrollX: 0, scrollY: 0 };
        expect(zoomAt(view, 100, 0, 0).scale).toBe(MAX_SCALE);
        expect(zoomAt(view, 0.001, 0, 0).scale).toBe(MIN_SCALE);
    });
});

describe('clampScroll', () => {
    const layout = computeDocumentLayout(pages);

    it('clamps scroll to the content bounds', () => {
        const clamped = clampScroll({ scale: 1, scrollX: 5000, scrollY: 99999 }, layout, 400, 600);
        expect(clamped.scrollX).toBe(layout.contentWidth - 400);
        expect(clamped.scrollY).toBe(layout.contentHeight - 600);
        const zeroed = clampScroll({ scale: 1, scrollX: -50, scrollY: -50 }, layout, 400, 600);
        expect(zeroed.scrollY).toBe(0);
    });

    it('centers content narrower than the viewport', () => {
        const clamped = clampScroll({ scale: 1, scrollX: 0, scrollY: 0 }, layout, 1000, 600);
        expect(clamped.scrollX).toBe(-(1000 - layout.contentWidth) / 2);
    });
});

describe('pagePointToViewport', () => {
    const { layouts } = computeDocumentLayout(pages);

    it('inverts viewportToPagePoint', () => {
        const view = { scale: 1.7, scrollX: 120, scrollY: 940 };
        for (const [nx, ny, pageIndex] of [
            [0.25, 0.4, 0],
            [0.9, 0.05, 1],
            [0.5, 0.99, 2],
        ] as const) {
            const layout = layouts[pageIndex];
            if (!layout) {
                throw new Error('missing layout');
            }
            const { x, y } = pagePointToViewport(view, layout, nx, ny);
            const roundTrip = viewportToPagePoint(view, layouts, x, y);
            expect(roundTrip?.pageIndex).toBe(pageIndex);
            expect(roundTrip?.nx).toBeCloseTo(nx);
            expect(roundTrip?.ny).toBeCloseTo(ny);
        }
    });

    it('matches the raw formula at identity view', () => {
        const layout = layouts[0];
        if (!layout) {
            throw new Error('missing layout');
        }
        const { x, y } = pagePointToViewport({ scale: 1, scrollX: 0, scrollY: 0 }, layout, 0.5, 0.5);
        expect(x).toBe(layout.left + layout.width / 2);
        expect(y).toBe(layout.top + layout.height / 2);
    });
});

describe('scrollForPagePoint', () => {
    const layout = computeDocumentLayout(pages);

    it('places the page point at the requested viewport anchor', () => {
        const pageLayout = layout.layouts[1];
        if (!pageLayout) {
            throw new Error('missing layout');
        }
        const view = { scale: 2, scrollX: 0, scrollY: 0 };
        const scrolled = scrollForPagePoint(view, pageLayout, 0.5, 0.25, 800, 600, 0.5, 0.15);
        const { x, y } = pagePointToViewport(scrolled, pageLayout, 0.5, 0.25);
        expect(x).toBeCloseTo(800 * 0.5);
        expect(y).toBeCloseTo(600 * 0.15);
        expect(scrolled.scale).toBe(2);
    });

    it('composes with clampScroll without changing scale', () => {
        const pageLayout = layout.layouts[0];
        if (!pageLayout) {
            throw new Error('missing layout');
        }
        const view = { scale: 1, scrollX: 0, scrollY: 0 };
        // Anchoring the very top of page 0 near the viewport top over-scrolls above the content.
        const clamped = clampScroll(scrollForPagePoint(view, pageLayout, 0.5, 0, 800, 600, 0.5, 0.9), layout, 800, 600);
        expect(clamped.scrollY).toBe(0);
        expect(clamped.scale).toBe(1);
    });
});

describe('fitPageWidthScale', () => {
    it('fits the widest page with margins', () => {
        const layout = computeDocumentLayout(pages);
        const scale = fitPageWidthScale(layout, 632);
        expect(scale).toBeCloseTo(1); // (632 - 32) / 600
    });

    it('returns 1 for empty documents', () => {
        expect(fitPageWidthScale(computeDocumentLayout([]), 800)).toBe(1);
    });
});
