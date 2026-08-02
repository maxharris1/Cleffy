import { forEachRlePixel } from '@/features/import/segmentation';
import { decimateStroke } from '@/features/viewer/geometry';
import type { RleMask } from '@/features/import/importTypes';
import type { StrokePayload } from '@/types/models';

/**
 * Turn a detected ink mask into native stroke payloads: Zhang–Suen thinning
 * to a 1-px skeleton, then endpoint-to-endpoint path tracing. A bracket
 * becomes 2–3 strokes, a circled note one closed-ish stroke — all committed
 * in one undo batch by the caller, so one undo removes the whole mark.
 */

export const THIN_MAX_PASSES = 60;
/** Skeleton paths shorter than this many pixels are dropped (noise nubs). */
export const MIN_PATH_PX = 6;
/** Decimation step in normalized-x units (~4 px on a 2048 raster). */
export const VECTOR_DECIMATE_NORM = 0.002;
/** StrokePayload.w clamps: [thin/2, thick×2] of the app's stroke widths. */
export const MIN_STROKE_W = 0.00125;
export const MAX_STROKE_W = 0.02;

/** Bbox-local binary grid of a mask. */
const gridFromMask = (mask: RleMask): Uint8Array => {
    const grid = new Uint8Array(mask.w * mask.h);
    forEachRlePixel(mask, (x, y) => {
        grid[(y - mask.y) * mask.w + (x - mask.x)] = 1;
    });
    return grid;
};

/**
 * Zhang–Suen thinning, classic two-subiteration form.
 * Mutates and returns the grid.
 */
export const thinGrid = (grid: Uint8Array, w: number, h: number): Uint8Array => {
    const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : (grid[y * w + x] ?? 0));
    const toRemove: number[] = [];
    for (let pass = 0; pass < THIN_MAX_PASSES; pass++) {
        let changed = false;
        for (let step = 0; step < 2; step++) {
            toRemove.length = 0;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    if (at(x, y) === 0) {
                        continue;
                    }
                    // Neighbors clockwise from north: p2..p9.
                    const p2 = at(x, y - 1);
                    const p3 = at(x + 1, y - 1);
                    const p4 = at(x + 1, y);
                    const p5 = at(x + 1, y + 1);
                    const p6 = at(x, y + 1);
                    const p7 = at(x - 1, y + 1);
                    const p8 = at(x - 1, y);
                    const p9 = at(x - 1, y - 1);
                    const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
                    if (b < 2 || b > 6) {
                        continue;
                    }
                    const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
                    let a = 0;
                    for (let i = 0; i < 8; i++) {
                        if ((seq[i] ?? 0) === 0 && (seq[i + 1] ?? 0) === 1) {
                            a++;
                        }
                    }
                    if (a !== 1) {
                        continue;
                    }
                    const c1 = step === 0 ? p2 * p4 * p6 : p2 * p4 * p8;
                    const c2 = step === 0 ? p4 * p6 * p8 : p2 * p6 * p8;
                    if (c1 === 0 && c2 === 0) {
                        toRemove.push(y * w + x);
                    }
                }
            }
            for (const idx of toRemove) {
                grid[idx] = 0;
            }
            if (toRemove.length > 0) {
                changed = true;
            }
        }
        if (!changed) {
            break;
        }
    }
    return grid;
};

const NEIGHBOR_OFFSETS: readonly [number, number][] = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
];

/** Bbox-local pixel paths traced along a 1-px skeleton. */
export const traceSkeletonPaths = (grid: Uint8Array, w: number, h: number): [number, number][][] => {
    const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : (grid[y * w + x] ?? 0));
    const degree = (x: number, y: number): number => {
        let d = 0;
        for (const [dx, dy] of NEIGHBOR_OFFSETS) {
            d += at(x + dx, y + dy);
        }
        return d;
    };

    const visited = new Uint8Array(w * h);
    const paths: [number, number][][] = [];

    const walk = (sx: number, sy: number): [number, number][] => {
        const path: [number, number][] = [];
        let x = sx;
        let y = sy;
        for (;;) {
            visited[y * w + x] = 1;
            path.push([x, y]);
            let nx = -1;
            let ny = -1;
            for (const [dx, dy] of NEIGHBOR_OFFSETS) {
                const cx = x + dx;
                const cy = y + dy;
                if (at(cx, cy) === 1 && (visited[cy * w + cx] ?? 0) === 0) {
                    nx = cx;
                    ny = cy;
                    break;
                }
            }
            if (nx < 0) {
                // Dead end: if a visited junction neighbors us, step onto it once
                // so branches meet instead of leaving a 1-px gap.
                for (const [dx, dy] of NEIGHBOR_OFFSETS) {
                    const cx = x + dx;
                    const cy = y + dy;
                    const prev = path[path.length - 2];
                    if (prev && cx === prev[0] && cy === prev[1]) {
                        continue;
                    }
                    if (at(cx, cy) === 1 && degree(cx, cy) >= 3) {
                        path.push([cx, cy]);
                        break;
                    }
                }
                return path;
            }
            x = nx;
            y = ny;
        }
    };

    // Endpoints first: open curves trace end-to-end.
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (at(x, y) === 1 && (visited[y * w + x] ?? 0) === 0 && degree(x, y) === 1) {
                paths.push(walk(x, y));
            }
        }
    }
    // Whatever remains is cycles (circles) or junction cores.
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (at(x, y) === 1 && (visited[y * w + x] ?? 0) === 0) {
                const path = walk(x, y);
                // Close loops visually: a cycle's walk ends adjacent to its start.
                const last = path[path.length - 1];
                const first = path[0];
                if (
                    path.length > 3 &&
                    first &&
                    last &&
                    Math.abs(first[0] - last[0]) <= 1 &&
                    Math.abs(first[1] - last[1]) <= 1
                ) {
                    path.push([first[0], first[1]]);
                }
                paths.push(path);
            }
        }
    }
    return paths;
};

/**
 * Full pipeline: mask → skeleton → traced paths → normalized, decimated
 * StrokePayloads. `thicknessPx` refines to area/skeletonLength when the
 * skeleton is long enough; falls back to the caller's perimeter estimate.
 */
export const vectorizeMask = (
    mask: RleMask,
    area: number,
    thicknessEstimatePx: number,
    rasterWidth: number,
    rasterHeight: number,
): StrokePayload[] => {
    const grid = thinGrid(gridFromMask(mask), mask.w, mask.h);
    const paths = traceSkeletonPaths(grid, mask.w, mask.h).filter((p) => p.length >= MIN_PATH_PX);

    let skeletonLength = 0;
    for (const path of paths) {
        skeletonLength += path.length;
    }
    const thicknessPx =
        skeletonLength >= MIN_PATH_PX ? Math.max(1, area / skeletonLength) : Math.max(1, thicknessEstimatePx);
    const w = Math.min(MAX_STROKE_W, Math.max(MIN_STROKE_W, thicknessPx / rasterWidth));

    if (paths.length === 0) {
        // Dot-like blob: too small to skeletonize into a path, still real ink
        // (staccato dot, stray tick). Emit a short stroke across the bbox.
        const cy = mask.y + mask.h / 2;
        const dotW = Math.min(MAX_STROKE_W, Math.max(MIN_STROKE_W, Math.min(mask.w, mask.h) / rasterWidth));
        return [
            {
                pts: [
                    mask.x / rasterWidth,
                    cy / rasterHeight,
                    0.5,
                    (mask.x + mask.w) / rasterWidth,
                    cy / rasterHeight,
                    0.5,
                ],
                w: dotW,
            },
        ];
    }

    return paths.map((path) => {
        const pts: number[] = [];
        for (const [px, py] of path) {
            pts.push((mask.x + px + 0.5) / rasterWidth, (mask.y + py + 0.5) / rasterHeight, 0.5);
        }
        return { pts: decimateStroke(pts, VECTOR_DECIMATE_NORM), w };
    });
};
