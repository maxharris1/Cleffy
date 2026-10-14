import { getStroke } from 'perfect-freehand';

import { canvasFont, SYSTEM_FONT_FAMILY } from '@/features/import/textFit';
import { ensureMusicFontLoaded, isMusicFontReady, textDrawSpec, textNoteLines } from '@/features/viewer/ink/musicFont';
import { isTextPayload, type Annotation, type StrokePayload } from '@/types/models';

/** Ink alpha/composite for the highlighter so it reads over dark scans. */
export const HIGHLIGHT_ALPHA = 0.35;

export const FREEHAND_OPTIONS = {
    thinning: 0.55,
    smoothing: 0.5,
    streamline: 0.4,
} as const;

/**
 * Outline polygon → smooth SVG path string (quadratic midpoint curves).
 * Adapted from the perfect-freehand README — the library does not export it.
 * Emits EXPLICIT `Q` segments only (no `T` shorthand): pdf-lib's SVG path
 * parser mangles smooth-continuation commands, and the same string feeds both
 * the canvas renderer (Path2D) and the PDF export worker, so screen ink and
 * exported ink stay geometrically identical.
 */
export const getSvgPathFromStroke = (points: number[][]): string => {
    const len = points.length;
    if (len < 4) {
        return '';
    }
    const px = (i: number): number => points[i % len]?.[0] ?? 0;
    const py = (i: number): number => points[i % len]?.[1] ?? 0;
    const mid = (i: number): [number, number] => [(px(i) + px(i + 1)) / 2, (py(i) + py(i + 1)) / 2];

    const [m0x, m0y] = mid(0);
    let result = `M${m0x.toFixed(2)},${m0y.toFixed(2)}`;
    for (let i = 1; i <= len; i++) {
        const [mx, my] = mid(i);
        result += ` Q${px(i).toFixed(2)},${py(i).toFixed(2)} ${mx.toFixed(2)},${my.toFixed(2)}`;
    }
    result += ' Z';
    return result;
};

/** Unflatten [x,y,p,…] into perfect-freehand input, scaled to page pixels. */
export const strokeInputPoints = (payload: StrokePayload, pageWpx: number, pageHpx: number): number[][] => {
    const out: number[][] = [];
    for (let i = 0; i < payload.pts.length - 2; i += 3) {
        out.push([(payload.pts[i] ?? 0) * pageWpx, (payload.pts[i + 1] ?? 0) * pageHpx, payload.pts[i + 2] ?? 0.5]);
    }
    return out;
};

/** Build the fill path for a stroke/highlight at a given page pixel size. */
export const buildStrokePath = (payload: StrokePayload, pageWpx: number, pageHpx: number): Path2D => {
    const outline = getStroke(strokeInputPoints(payload, pageWpx, pageHpx), {
        ...FREEHAND_OPTIONS,
        size: Math.max(1, payload.w * pageWpx),
        simulatePressure: payload.sp === 1,
    });
    return new Path2D(getSvgPathFromStroke(outline));
};

/**
 * Stroke paths by annotation id, valid for one version of the mark at one
 * raster size (width and height: y is scaled by the height, and a page's size
 * can change under a loaded document while its pdf is still streaming). Building a path (perfect-freehand outline, SVG string, Path2D
 * parse) is what a repaint costs, so a page repaint must find every mark here.
 * It used to be a 400-entry cache cleared whole when full: a page with more
 * marks than that rebuilt every path on every repaint, which on a 2,000-mark
 * page was a second-long freeze after each stroke. Entries are dropped by
 * `retainOnly` instead, after a full repaint, so the cache holds what the page
 * shows and nothing it no longer does.
 */
export class StrokePathCache {
    private cache = new Map<string, { key: string; path: Path2D }>();

    get(annotation: Annotation, pageWpx: number, pageHpx: number): Path2D | null {
        if (isTextPayload(annotation.payload)) {
            return null;
        }
        const key = `${annotation.updatedAt}:${Math.round(pageWpx)}x${Math.round(pageHpx)}`;
        const hit = this.cache.get(annotation.id);
        if (hit && hit.key === key) {
            return hit.path;
        }
        const path = buildStrokePath(annotation.payload, pageWpx, pageHpx);
        this.cache.set(annotation.id, { key, path });
        return path;
    }

    /** Forget every mark not in `ids`. */
    retainOnly(ids: ReadonlySet<string>): void {
        for (const id of this.cache.keys()) {
            if (!ids.has(id)) {
                this.cache.delete(id);
            }
        }
    }

    get size(): number {
        return this.cache.size;
    }
}

const samePayloadValue = (a: unknown, b: unknown): boolean => {
    if (a === b) {
        return true;
    }
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
};

/**
 * True when two versions of a mark draw identically: same id, kind, colour and
 * payload. Most store notifications change nothing on screen — the server's
 * ack stamping createdBy, the realtime echo of this device's own stroke with a
 * new seq — and the ink layer uses this to skip them.
 */
export const sameInk = (a: Annotation, b: Annotation): boolean => {
    if (a === b) {
        return true;
    }
    if (a.id !== b.id || a.kind !== b.kind || a.color !== b.color) {
        return false;
    }
    if (a.payload === b.payload) {
        return true;
    }
    const pa = a.payload as unknown as Record<string, unknown>;
    const pb = b.payload as unknown as Record<string, unknown>;
    const keys = Object.keys(pa);
    if (keys.length !== Object.keys(pb).length) {
        return false;
    }
    return keys.every((key) => samePayloadValue(pa[key], pb[key]));
};

/** Draw one annotation onto a page-sized canvas context (bitmap px coords). */
export const drawAnnotation = (
    ctx: CanvasRenderingContext2D,
    annotation: Annotation,
    pageWpx: number,
    pageHpx: number,
    cache?: StrokePathCache,
): void => {
    if (isTextPayload(annotation.payload)) {
        const { x, y, text, size, hw } = annotation.payload;
        const fontPx = Math.max(6, size * pageWpx);
        let spec = textDrawSpec(text, hw === 1, annotation.payload);
        if (spec.music && !isMusicFontReady()) {
            // Canvas never triggers a CSS font load; ask for it and draw the
            // ASCII spelling meanwhile (the ready hook repaints the page).
            void ensureMusicFontLoaded();
            spec = { family: SYSTEM_FONT_FAMILY, style: 'italic', glyphs: text, music: false };
        }
        ctx.save();
        ctx.fillStyle = annotation.color;
        ctx.font = canvasFont(spec, fontPx);
        ctx.textBaseline = 'top';
        // Wrapped at the page's right edge, as the editor wrapped it.
        const lines = textNoteLines(annotation.payload, spec);
        lines.forEach((line, i) => {
            ctx.fillText(line, x * pageWpx, y * pageHpx + i * fontPx * 1.25);
        });
        ctx.restore();
        return;
    }

    const path = cache
        ? cache.get(annotation, pageWpx, pageHpx)
        : buildStrokePath(annotation.payload, pageWpx, pageHpx);
    if (!path) {
        return;
    }
    ctx.save();
    if (annotation.kind === 'highlight') {
        ctx.globalAlpha = HIGHLIGHT_ALPHA;
        ctx.globalCompositeOperation = 'multiply';
    }
    ctx.fillStyle = annotation.color;
    ctx.fill(path);
    ctx.restore();
};
