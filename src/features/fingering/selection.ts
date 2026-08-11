import type { NormRect } from '@/features/fingering/model';

/** Drags under this many CSS px per side are ignored (accidental slivers). */
export const MIN_SELECTION_CSS = 8;

/** Normalized rect from two drag corners (any orientation). */
export const rectFromPoints = (x0: number, y0: number, x1: number, y1: number): NormRect => ({
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    w: Math.abs(x1 - x0),
    h: Math.abs(y1 - y0),
});

/** Do two normalized rects overlap (touching edges count)? */
export const rectsIntersect = (a: NormRect, b: NormRect): boolean =>
    a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;

/** Inflate a rect by margins (normalized units per axis), clamped to the page. */
export const inflateRect = (rect: NormRect, mx: number, my: number): NormRect => {
    const x = Math.max(0, rect.x - mx);
    const y = Math.max(0, rect.y - my);
    return {
        x,
        y,
        w: Math.min(1, rect.x + rect.w + mx) - x,
        h: Math.min(1, rect.y + rect.h + my) - y,
    };
};
