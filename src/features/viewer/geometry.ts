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

/** A point on a specific page in normalized (0–1) page coordinates. */
export interface PagePoint {
    pageIndex: number;
    nx: number;
    ny: number;
}

/**
 * Map viewport-local CSS coords to the page under them (normalized).
 * Returns null in the gaps/margins outside any page.
 */
export const viewportToPagePoint = (
    view: ViewState,
    layouts: readonly PageLayout[],
    x: number,
    y: number,
): PagePoint | null => {
    const cx = (view.scrollX + x) / view.scale;
    const cy = (view.scrollY + y) / view.scale;
    for (let i = 0; i < layouts.length; i++) {
        const l = layouts[i];
        if (!l) {
            continue;
        }
        if (cx >= l.left && cx <= l.left + l.width && cy >= l.top && cy <= l.top + l.height) {
            return { pageIndex: i, nx: (cx - l.left) / l.width, ny: (cy - l.top) / l.height };
        }
    }
    return null;
};

/**
 * Map viewport-local CSS coords onto a KNOWN page, clamped to its bounds —
 * used while a stroke is in flight so it stays on its anchor page.
 */
export const viewportToPageClamped = (view: ViewState, layout: PageLayout, x: number, y: number): PagePoint | null => {
    const cx = (view.scrollX + x) / view.scale;
    const cy = (view.scrollY + y) / view.scale;
    return {
        pageIndex: -1, // caller knows the page
        nx: Math.min(1, Math.max(0, (cx - layout.left) / layout.width)),
        ny: Math.min(1, Math.max(0, (cy - layout.top) / layout.height)),
    };
};

/** Backing-bitmap dimensions for a page canvas: css size × dpr, capped for iOS. */
export const bitmapDims = (
    layout: PageLayout,
    scale: number,
    dpr: number,
): { width: number; height: number; pxPerBase: number } => {
    const cssW = layout.width * scale;
    const cssH = layout.height * scale;
    const cap = MAX_BITMAP_SIDE / Math.max(cssW * dpr, cssH * dpr);
    const factor = dpr * Math.min(1, cap);
    return { width: Math.floor(cssW * factor), height: Math.floor(cssH * factor), pxPerBase: scale * factor };
};

/**
 * Min-distance decimation of a flat [x,y,p,…] stroke (normalized units).
 * Always keeps the first and last points.
 */
export const decimateStroke = (pts: readonly number[], minDist: number): number[] => {
    if (pts.length <= 6) {
        return [...pts];
    }
    const out: number[] = [pts[0] ?? 0, pts[1] ?? 0, pts[2] ?? 0];
    let lastX = out[0] ?? 0;
    let lastY = out[1] ?? 0;
    for (let i = 3; i < pts.length - 3; i += 3) {
        const x = pts[i] ?? 0;
        const y = pts[i + 1] ?? 0;
        if (Math.hypot(x - lastX, y - lastY) >= minDist) {
            out.push(x, y, pts[i + 2] ?? 0.5);
            lastX = x;
            lastY = y;
        }
    }
    out.push(pts[pts.length - 3] ?? 0, pts[pts.length - 2] ?? 0, pts[pts.length - 1] ?? 0.5);
    return out;
};

export type Bbox = [minX: number, minY: number, maxX: number, maxY: number];

/** Bounding box of a flat [x,y,p,…] stroke in normalized units. */
export const strokeBbox = (pts: readonly number[]): Bbox => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pts.length - 2; i += 3) {
        const x = pts[i] ?? 0;
        const y = pts[i + 1] ?? 0;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    if (minX === Infinity) {
        return [0, 0, 0, 0];
    }
    return [minX, minY, maxX, maxY];
};

/** Squared distance from point (px,py) to segment (x1,y1)-(x2,y2). */
export const pointSegmentDistanceSq = (
    px: number,
    py: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
): number => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
        t = Math.min(1, Math.max(0, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    }
    const cx = x1 + t * dx;
    const cy = y1 + t * dy;
    return (px - cx) * (px - cx) + (py - cy) * (py - cy);
};
