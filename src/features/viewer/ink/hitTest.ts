import { pointSegmentDistanceSq, strokeBbox } from '@/features/viewer/geometry';
import { isTextPayload, type Annotation } from '@/types/models';

/**
 * Does the point (nx, ny in normalized page coords) hit this annotation?
 * radiusPx is the pick radius in page PIXELS; pageWpx/pageHpx convert between
 * spaces (normalized x and y have different denominators).
 */
export const hitTestAnnotation = (
    annotation: Annotation,
    nx: number,
    ny: number,
    radiusPx: number,
    pageWpx: number,
    pageHpx: number,
): boolean => {
    const px = nx * pageWpx;
    const py = ny * pageHpx;

    if (isTextPayload(annotation.payload)) {
        const { x, y, text, size } = annotation.payload;
        const fontPx = size * pageWpx;
        const lines = text.split('\n');
        const widthPx = Math.max(...lines.map((l) => l.length), 1) * fontPx * 0.6;
        const heightPx = lines.length * fontPx * 1.25;
        return (
            px >= x * pageWpx - radiusPx &&
            px <= x * pageWpx + widthPx + radiusPx &&
            py >= y * pageHpx - radiusPx &&
            py <= y * pageHpx + heightPx + radiusPx
        );
    }

    const { pts, w } = annotation.payload;
    const hitDist = (w * pageWpx) / 2 + radiusPx;

    // Bbox prefilter (normalized space, converted to px).
    const [minX, minY, maxX, maxY] = strokeBbox(pts);
    if (
        px < minX * pageWpx - hitDist ||
        px > maxX * pageWpx + hitDist ||
        py < minY * pageHpx - hitDist ||
        py > maxY * pageHpx + hitDist
    ) {
        return false;
    }

    const hitDistSq = hitDist * hitDist;
    if (pts.length === 3) {
        const dx = px - (pts[0] ?? 0) * pageWpx;
        const dy = py - (pts[1] ?? 0) * pageHpx;
        return dx * dx + dy * dy <= hitDistSq;
    }
    for (let i = 0; i < pts.length - 5; i += 3) {
        const x1 = (pts[i] ?? 0) * pageWpx;
        const y1 = (pts[i + 1] ?? 0) * pageHpx;
        const x2 = (pts[i + 3] ?? 0) * pageWpx;
        const y2 = (pts[i + 4] ?? 0) * pageHpx;
        if (pointSegmentDistanceSq(px, py, x1, y1, x2, y2) <= hitDistSq) {
            return true;
        }
    }
    return false;
};

/** All annotations on a page hit by the point, topmost (newest) first. */
export const hitTestPage = (
    annotations: Iterable<Annotation>,
    nx: number,
    ny: number,
    radiusPx: number,
    pageWpx: number,
    pageHpx: number,
): Annotation[] => {
    const hits: Annotation[] = [];
    for (const annotation of annotations) {
        if (hitTestAnnotation(annotation, nx, ny, radiusPx, pageWpx, pageHpx)) {
            hits.push(annotation);
        }
    }
    return hits.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
};
