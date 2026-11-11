import { pointSegmentDistanceSq, strokeBbox, type Bbox } from '@/features/viewer/geometry';
import { textBoundsNorm } from '@/features/viewer/ink/musicFont';
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
        // The glyphs' own box, so a small accent is not picked from an em away.
        const [minX, minY, maxX, maxY] = textBoundsNorm(annotation.payload, pageHpx / pageWpx);
        return (
            px >= minX * pageWpx - radiusPx &&
            px <= maxX * pageWpx + radiusPx &&
            py >= minY * pageHpx - radiusPx &&
            py <= maxY * pageHpx + radiusPx
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

/**
 * Approximate normalized bounding box of an annotation. `aspect` is the page's
 * width/height ratio — scalar sizes (stroke w, text size) are normalized
 * against page WIDTH, so projecting them onto the y axis multiplies by it.
 * Text extents are the measured glyph bounds, as in hitTestAnnotation.
 */
export const annotationBboxNorm = (annotation: Annotation, aspect: number): Bbox => {
    if (isTextPayload(annotation.payload)) {
        // textBoundsNorm takes height / width.
        return textBoundsNorm(annotation.payload, 1 / aspect);
    }
    const [minX, minY, maxX, maxY] = strokeBbox(annotation.payload.pts);
    const rx = annotation.payload.w / 2;
    const ry = rx * aspect;
    return [minX - rx, minY - ry, maxX + rx, maxY + ry];
};

/** Annotations whose bbox intersects the normalized rect (touching counts). */
export const annotationsInRect = (
    annotations: Iterable<Annotation>,
    rect: { x: number; y: number; w: number; h: number },
    aspect: number,
): Annotation[] => {
    const hits: Annotation[] = [];
    for (const annotation of annotations) {
        const [minX, minY, maxX, maxY] = annotationBboxNorm(annotation, aspect);
        if (minX <= rect.x + rect.w && maxX >= rect.x && minY <= rect.y + rect.h && maxY >= rect.y) {
            hits.push(annotation);
        }
    }
    return hits;
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
