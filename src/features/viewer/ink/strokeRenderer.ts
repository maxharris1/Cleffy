import { getStroke } from 'perfect-freehand';

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
 * Vendored from the perfect-freehand README — the library does not export it.
 * Shared verbatim by the canvas renderer (via Path2D) and the PDF export
 * worker so screen ink and exported ink are geometrically identical.
 */
export const getSvgPathFromStroke = (points: number[][]): string => {
    const len = points.length;
    if (len < 4) {
        return '';
    }
    let a = points[0] as number[];
    let b = points[1] as number[];
    const c = points[2] as number[];

    let result = `M${(a[0] ?? 0).toFixed(2)},${(a[1] ?? 0).toFixed(2)} Q${(b[0] ?? 0).toFixed(2)},${(b[1] ?? 0).toFixed(
        2,
    )} ${(((b[0] ?? 0) + (c[0] ?? 0)) / 2).toFixed(2)},${(((b[1] ?? 0) + (c[1] ?? 0)) / 2).toFixed(2)} T`;

    for (let i = 2, max = len - 1; i < max; i++) {
        a = points[i] as number[];
        b = points[i + 1] as number[];
        result += `${(((a[0] ?? 0) + (b[0] ?? 0)) / 2).toFixed(2)},${(((a[1] ?? 0) + (b[1] ?? 0)) / 2).toFixed(2)} `;
    }
    result += 'Z';
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

/** Simple bounded cache of stroke paths keyed by annotation version + raster width. */
export class StrokePathCache {
    private cache = new Map<string, Path2D>();

    get(annotation: Annotation, pageWpx: number, pageHpx: number): Path2D | null {
        if (isTextPayload(annotation.payload)) {
            return null;
        }
        const key = `${annotation.id}:${annotation.updatedAt}:${Math.round(pageWpx)}`;
        let path = this.cache.get(key);
        if (!path) {
            path = buildStrokePath(annotation.payload, pageWpx, pageHpx);
            if (this.cache.size > 400) {
                this.cache.clear();
            }
            this.cache.set(key, path);
        }
        return path;
    }
}

/** Draw one annotation onto a page-sized canvas context (bitmap px coords). */
export const drawAnnotation = (
    ctx: CanvasRenderingContext2D,
    annotation: Annotation,
    pageWpx: number,
    pageHpx: number,
    cache?: StrokePathCache,
): void => {
    if (isTextPayload(annotation.payload)) {
        const { x, y, text, size } = annotation.payload;
        const fontPx = Math.max(6, size * pageWpx);
        ctx.save();
        ctx.fillStyle = annotation.color;
        ctx.font = `${fontPx}px system-ui, -apple-system, sans-serif`;
        ctx.textBaseline = 'top';
        const lines = text.split('\n');
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
