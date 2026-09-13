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

/** One page per row, or two facing pages (a spread) per row. */
export type PageColumns = 1 | 2;

/**
 * Lay pages out in rows of `columns` pages, each page horizontally centered in
 * its column. One column is the classic vertical stack; two columns pair
 * pages 1|2, 3|4, … the way an open book does, an odd last page sitting alone
 * on the left. Rows are as tall as their tallest page, so pages in the same
 * row always share a `top` — the row is what page turning steps through.
 *
 * `coverPage` (two columns only) says the PDF opens on a title page: page 1
 * sits alone in the RIGHT column and the spreads after it pair 2|3, 4|5, …,
 * which is how printed music is engraved — page turns fall between systems
 * rather than mid-spread.
 */
export const computeDocumentLayout = (
    pages: readonly PageSize[],
    columns: PageColumns = 1,
    coverPage = false,
): DocumentLayout => {
    const columnWidth = pages.reduce((max, p) => Math.max(max, p.width), 0);
    const contentWidth = columns === 1 ? columnWidth : columnWidth * 2 + PAGE_GAP;
    const layouts: PageLayout[] = [];
    let y = PAGE_GAP;
    // The cover row holds one page and starts in the right column; every row
    // after it is a full-width spread starting on the left.
    let firstColumn = columns === 2 && coverPage ? 1 : 0;
    let i = 0;
    while (i < pages.length) {
        const row = pages.slice(i, i + columns - firstColumn);
        row.forEach((page, col) => {
            layouts.push({
                top: y,
                left: (firstColumn + col) * (columnWidth + PAGE_GAP) + (columnWidth - page.width) / 2,
                width: page.width,
                height: page.height,
            });
        });
        y += row.reduce((max, p) => Math.max(max, p.height), 0) + PAGE_GAP;
        i += row.length;
        firstColumn = 0;
    }
    return { layouts, contentWidth, contentHeight: y };
};

/**
 * The view after turning one row of pages forward or back from `pageIndex`:
 * the adjacent row's top edge sits at the top of the viewport (with the usual
 * page gap as margin), scale and horizontal position untouched. Rows are the
 * pages sharing a `top`, so in a two-column layout a turn moves a whole
 * spread. Returns null at either end of the document.
 */
export const pageTurnView = (
    view: ViewState,
    layout: DocumentLayout,
    pageIndex: number,
    direction: -1 | 1,
    viewportWidth: number,
    viewportHeight: number,
): { view: ViewState; pageIndex: number } | null => {
    const { layouts } = layout;
    const current = layouts[pageIndex];
    if (!current) {
        return null;
    }
    let target = -1;
    if (direction === 1) {
        target = layouts.findIndex((l) => l.top > current.top);
    } else {
        // First page of the nearest row above the current one.
        for (let i = pageIndex - 1; i >= 0; i--) {
            const l = layouts[i];
            if (!l || l.top >= current.top) {
                continue;
            }
            target = i;
            while (target > 0 && layouts[target - 1]?.top === l.top) {
                target--;
            }
            break;
        }
    }
    const targetLayout = target >= 0 ? layouts[target] : undefined;
    if (!targetLayout) {
        return null;
    }
    return {
        pageIndex: target,
        view: clampScroll(
            { scale: view.scale, scrollX: view.scrollX, scrollY: (targetLayout.top - PAGE_GAP) * view.scale },
            layout,
            viewportWidth,
            viewportHeight,
        ),
    };
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

/**
 * Page whose vertical span contains (or is nearest to) the viewport center.
 * Used for "share this page" actions.
 */
export const focusedPageIndex = (view: ViewState, viewportHeight: number, layouts: readonly PageLayout[]): number => {
    if (layouts.length === 0) {
        return 0;
    }
    const centerY = (view.scrollY + viewportHeight / 2) / view.scale;
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < layouts.length; i++) {
        const layout = layouts[i];
        if (!layout) {
            continue;
        }
        const mid = layout.top + layout.height / 2;
        const dist = Math.abs(mid - centerY);
        if (dist < bestDist) {
            bestDist = dist;
            best = i;
        }
    }
    return best;
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

/** Map a normalized point on a page to viewport-local CSS coords (inverse of viewportToPagePoint). */
export const pagePointToViewport = (
    view: ViewState,
    layout: PageLayout,
    nx: number,
    ny: number,
): { x: number; y: number } => ({
    x: (layout.left + nx * layout.width) * view.scale - view.scrollX,
    y: (layout.top + ny * layout.height) * view.scale - view.scrollY,
});

/**
 * A view scrolled so the given page point sits at (anchorFracX, anchorFracY)
 * of the viewport — e.g. 0.15 pins it near the top, for playback auto-follow.
 * Scale is preserved. Unclamped: pass the result through clampScroll.
 */
export const scrollForPagePoint = (
    view: ViewState,
    layout: PageLayout,
    nx: number,
    ny: number,
    viewportWidth: number,
    viewportHeight: number,
    anchorFracX = 0.5,
    anchorFracY = 0.15,
): ViewState => ({
    scale: view.scale,
    scrollX: (layout.left + nx * layout.width) * view.scale - viewportWidth * anchorFracX,
    scrollY: (layout.top + ny * layout.height) * view.scale - viewportHeight * anchorFracY,
});

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
 * Ceiling on the backing store of every mounted page canvas put together.
 * iOS Safari kills the tab ("A problem repeatedly occurred") somewhere in the
 * low hundreds of MB of canvas memory; MAX_BITMAP_SIDE only bounds one canvas,
 * and a two-page spread on a phone after a rotation was measured at 600 MB.
 */
export const MAX_TOTAL_BITMAP_BYTES = 160 * 1024 * 1024;

/** Ink is fat anti-aliased strokes — it never needs engraving resolution. */
export const INK_MAX_DPR = 2;

/** Rows kept mounted beyond the visible ones, above and below. */
export const OVERSCAN_ROWS = 1;

/** Bytes for one page's three canvases (PDF raster + committed ink + live ink). */
const pageBitmapBytes = (page: PageLayout, scale: number, dpr: number): number => {
    const pdf = bitmapDims(page, scale, dpr);
    const ink = bitmapDims(page, scale, Math.min(dpr, INK_MAX_DPR));
    return (pdf.width * pdf.height + 2 * ink.width * ink.height) * 4;
};

/**
 * Multiplier (≤ 1) to apply to the device pixel ratio so that every page that
 * can be mounted at this zoom fits inside MAX_TOTAL_BITMAP_BYTES. Estimated
 * from geometry alone — how many rows and columns of the largest page cover
 * the viewport plus overscan — so it is stable while scrolling and only moves
 * with zoom, orientation or layout. Quantized to sixteenths so a few pixels
 * of viewport change cannot trigger a re-raster. Pages past the budget render
 * softer (CSS-upscaled) instead of taking the tab down — at the zooms where
 * this bites, a soft page still beats a relaunched app.
 */
export const bitmapBudgetFactor = (
    layout: DocumentLayout,
    columns: PageColumns,
    scale: number,
    dpr: number,
    viewportWidth: number,
    viewportHeight: number,
    budgetBytes = MAX_TOTAL_BITMAP_BYTES,
): number => {
    const pageCount = layout.layouts.length;
    if (pageCount === 0 || scale <= 0 || dpr <= 0) {
        return 1;
    }
    const maxPage: PageLayout = {
        top: 0,
        left: 0,
        width: layout.layouts.reduce((max, l) => Math.max(max, l.width), 0),
        height: layout.layouts.reduce((max, l) => Math.max(max, l.height), 0),
    };
    const rowStride = (maxPage.height + PAGE_GAP) * scale;
    const colStride = (maxPage.width + PAGE_GAP) * scale;
    // A viewport straddles one more row/column than it covers outright.
    const rows = Math.ceil(viewportHeight / rowStride) + 1 + 2 * OVERSCAN_ROWS;
    const cols = Math.min(columns, Math.ceil(viewportWidth / colStride) + 1);
    const pages = Math.min(pageCount, rows * cols);
    // Largest sixteenth that fits. Searched rather than solved: the ink
    // canvases stop shrinking once under INK_MAX_DPR and the per-side cap
    // bends the curve, so bytes are not a clean function of the factor.
    for (let sixteenths = 16; sixteenths > 1; sixteenths--) {
        const factor = sixteenths / 16;
        if (pages * pageBitmapBytes(maxPage, scale, dpr * factor) <= budgetBytes) {
            return factor;
        }
    }
    return 1 / 16;
};

/**
 * Pages to mount: the rows intersecting the viewport, extended by
 * `overscanRows` whole rows each side (a two-column row is never half
 * mounted), minus pages that are entirely off-screen sideways once the
 * content is wider than the viewport. The horizontal test keeps half a
 * viewport of margin so a pan does not reveal a blank page. Over-scrolled
 * past the end, the last rows stay mounted.
 */
export const mountedPageIndices = (
    view: ViewState,
    layout: DocumentLayout,
    viewportWidth: number,
    viewportHeight: number,
    overscanRows = OVERSCAN_ROWS,
): number[] => {
    const { layouts } = layout;
    if (layouts.length === 0) {
        return [];
    }
    // Row boundaries: the first page index of each row, and each page's row.
    const rowStarts: number[] = [];
    const rowOf: number[] = [];
    let lastTop = Number.NaN;
    layouts.forEach((l, i) => {
        if (l.top !== lastTop) {
            rowStarts.push(i);
            lastTop = l.top;
        }
        rowOf.push(rowStarts.length - 1);
    });
    const rowCount = rowStarts.length;

    const y0 = view.scrollY / view.scale;
    const y1 = (view.scrollY + viewportHeight) / view.scale;
    let firstRow = rowCount;
    let lastRow = -1;
    layouts.forEach((l, i) => {
        if (l.top + l.height >= y0 && l.top <= y1) {
            const row = rowOf[i] ?? 0;
            firstRow = Math.min(firstRow, row);
            lastRow = Math.max(lastRow, row);
        }
    });
    if (firstRow > lastRow) {
        // Past the last page (over-scrolled): keep the tail mounted.
        lastRow = rowCount - 1;
        firstRow = rowCount - 1;
    }
    firstRow = Math.max(0, firstRow - overscanRows);
    lastRow = Math.min(rowCount - 1, lastRow + overscanRows);

    const cullSideways = layout.contentWidth * view.scale > viewportWidth;
    const margin = viewportWidth / 2 / view.scale;
    const x0 = view.scrollX / view.scale - margin;
    const x1 = (view.scrollX + viewportWidth) / view.scale + margin;

    const out: number[] = [];
    const end = lastRow + 1 < rowCount ? (rowStarts[lastRow + 1] ?? layouts.length) : layouts.length;
    for (let i = rowStarts[firstRow] ?? 0; i < end; i++) {
        const l = layouts[i];
        if (!l) {
            continue;
        }
        if (cullSideways && (l.left + l.width < x0 || l.left > x1)) {
            continue;
        }
        out.push(i);
    }
    return out;
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
