import type { PageSize, ViewState } from '@/types/models';

/** Vertical gap between pages, in base (scale-1) units. */
export const PAGE_GAP = 16;

/** Minimum / maximum committed zoom. */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;

/**
 * iOS Safari silently blanks canvases beyond per-canvas / total memory budgets.
 * Cap every backing bitmap's longest side; large scans stay sharp enough and
 * the app stays alive. (Plan §risks — top crash risk, baked in from M1.)
 */
export const MAX_BITMAP_SIDE = 4096;

/** Position of a page within the document column, in base (scale-1) units. */
export interface PageLayout {
    top: number;
    left: number;
    width: number;
    height: number;
}

export interface DocumentLayout {
    layouts: PageLayout[];
    /** Total content size in base units. */
    contentWidth: number;
    contentHeight: number;
}

/** Lay pages out in a vertical, horizontally-centered column. */
export const computeDocumentLayout = (pages: readonly PageSize[]): DocumentLayout => {
    const contentWidth = pages.reduce((max, p) => Math.max(max, p.width), 0);
    const layouts: PageLayout[] = [];
    let y = PAGE_GAP;
    for (const page of pages) {
        layouts.push({
            top: y,
            left: (contentWidth - page.width) / 2,
            width: page.width,
            height: page.height,
        });
        y += page.height + PAGE_GAP;
    }
    return { layouts, contentWidth, contentHeight: y };
};

/**
 * Pages intersecting the viewport, extended by `overscan` pages on each side.
 * Returns an inclusive [start, end] index range ([0, -1] when there are no pages).
 */
export const visiblePageRange = (
    view: ViewState,
    viewportHeight: number,
    layouts: readonly PageLayout[],
    overscan = 1,
): { start: number; end: number } => {
    if (layouts.length === 0) {
        return { start: 0, end: -1 };
    }
    const y0 = view.scrollY / view.scale;
    const y1 = (view.scrollY + viewportHeight) / view.scale;

    let start = layouts.length - 1;
    let end = 0;
    for (let i = 0; i < layouts.length; i++) {
        const layout = layouts[i];
        if (!layout) {
            continue;
        }
        if (layout.top + layout.height >= y0) {
            start = Math.min(start, i);
        }
        if (layout.top <= y1) {
            end = Math.max(end, i);
        }
    }
    if (start > end) {
        // Viewport is past the last page (over-scrolled); clamp to nearest page.
        return { start: Math.max(0, layouts.length - 1 - overscan), end: layouts.length - 1 };
    }
    return {
        start: Math.max(0, start - overscan),
        end: Math.min(layouts.length - 1, end + overscan),
    };
};

/** Clamp scroll offsets so content cannot be dragged fully out of view. */
export const clampScroll = (
    view: ViewState,
    layout: DocumentLayout,
    viewportWidth: number,
    viewportHeight: number,
): ViewState => {
    const contentW = layout.contentWidth * view.scale;
    const contentH = layout.contentHeight * view.scale;
    const maxX = Math.max(0, contentW - viewportWidth);
    const maxY = Math.max(0, contentH - viewportHeight);
    return {
        scale: view.scale,
        // When content is narrower than the viewport, center it (negative scroll).
        scrollX:
            contentW <= viewportWidth ? -(viewportWidth - contentW) / 2 : Math.min(maxX, Math.max(0, view.scrollX)),
        scrollY: Math.min(maxY, Math.max(0, view.scrollY)),
    };
};

/**
 * Zoom so the content point under the viewport anchor (px, py) stays put.
 * Returns the new view (unclamped — pass through clampScroll).
 */
export const zoomAt = (view: ViewState, newScale: number, px: number, py: number): ViewState => {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
    const ratio = scale / view.scale;
    return {
        scale,
        scrollX: (view.scrollX + px) * ratio - px,
        scrollY: (view.scrollY + py) * ratio - py,
    };
};

/** Scale that fits the widest page to the viewport width (with a small margin). */
export const fitPageWidthScale = (layout: DocumentLayout, viewportWidth: number): number => {
    if (layout.contentWidth <= 0) {
        return 1;
    }
    const scale = (viewportWidth - PAGE_GAP * 2) / layout.contentWidth;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
};
