import { forEachRlePixel } from '@/features/import/segmentation';
import type { DetectionRaster, RleMask } from '@/features/import/importTypes';

/**
 * Cleanup-patch math: covering detected ink with the LOCAL paper color so the
 * "cleaned" page is invisible on yellowed scans where pure white would show.
 * Sampling happens during the scan (while the raster is in memory); patch
 * pixel buffers are built later, at accept time, from masks + sampled colors.
 */

/** Dilation around the mask so anti-aliased ink fringe is covered too. */
export const WHITEOUT_DILATE_PX = 2;
/** Width of the ring (beyond the dilation) sampled for the local paper color. */
export const PATCH_BG_RING_PX = 8;
/** Ring pixels darker than this value are printed notation, not paper — excluded. */
export const BG_MIN_VALUE = 0.75;

const toHex = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, '0');

/**
 * Median RGB of paper pixels in a ring around the mask bbox, excluding ink
 * (chromatic) and print (dark) pixels. Falls back to white when the ring is
 * fully covered by print.
 */
export const sampleBackgroundColor = (raster: DetectionRaster, mask: RleMask): string => {
    const { data, width, height } = raster;
    const pad = WHITEOUT_DILATE_PX + PATCH_BG_RING_PX;
    const x0 = Math.max(0, mask.x - pad);
    const y0 = Math.max(0, mask.y - pad);
    const x1 = Math.min(width - 1, mask.x + mask.w - 1 + pad);
    const y1 = Math.min(height - 1, mask.y + mask.h - 1 + pad);
    const innerX0 = mask.x - WHITEOUT_DILATE_PX;
    const innerY0 = mask.y - WHITEOUT_DILATE_PX;
    const innerX1 = mask.x + mask.w - 1 + WHITEOUT_DILATE_PX;
    const innerY1 = mask.y + mask.h - 1 + WHITEOUT_DILATE_PX;

    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            if (x >= innerX0 && x <= innerX1 && y >= innerY0 && y <= innerY1) {
                continue; // inside the dilated bbox — could be ink
            }
            const p = (y * width + x) * 4;
            const r = data[p] ?? 0;
            const g = data[p + 1] ?? 0;
            const b = data[p + 2] ?? 0;
            const mx = Math.max(r, g, b);
            const mn = Math.min(r, g, b);
            if (mx / 255 < BG_MIN_VALUE) {
                continue; // printed notation
            }
            if (mx - mn >= 40) {
                continue; // neighboring colored ink
            }
            rs.push(r);
            gs.push(g);
            bs.push(b);
        }
    }
    if (rs.length === 0) {
        return '#ffffff';
    }
    const median = (arr: number[]): number => {
        arr.sort((a, b) => a - b);
        return arr[Math.floor(arr.length / 2)] ?? 255;
    };
    return `#${toHex(median(rs))}${toHex(median(gs))}${toHex(median(bs))}`;
};

export interface WhiteoutPatch {
    pageIndex: number;
    /** Patch placement in normalized page coordinates (rotated viewport space). */
    bboxNorm: { x: number; y: number; w: number; h: number };
    /** RGBA pixels, patch-local (concrete ArrayBuffer so ImageData accepts it). */
    rgba: Uint8ClampedArray<ArrayBuffer>;
    width: number;
    height: number;
}

/**
 * Build one alpha-masked patch: paper color where the (dilated) mask is,
 * transparent elsewhere, with a half-alpha 1px edge so the patch boundary
 * never reads as a hard line on textured scans.
 */
export const buildWhiteoutPatch = (
    mask: RleMask,
    bgColorHex: string,
    pageIndex: number,
    rasterWidth: number,
    rasterHeight: number,
): WhiteoutPatch => {
    const d = WHITEOUT_DILATE_PX;
    const x0 = Math.max(0, mask.x - d);
    const y0 = Math.max(0, mask.y - d);
    const x1 = Math.min(rasterWidth - 1, mask.x + mask.w - 1 + d);
    const y1 = Math.min(rasterHeight - 1, mask.y + mask.h - 1 + d);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;

    // Dilate the mask by d (Chebyshev) into a patch-local grid.
    const grid = new Uint8Array(w * h);
    forEachRlePixel(mask, (px, py) => {
        for (let dy = -d; dy <= d; dy++) {
            for (let dx = -d; dx <= d; dx++) {
                const gx = px + dx - x0;
                const gy = py + dy - y0;
                if (gx >= 0 && gy >= 0 && gx < w && gy < h) {
                    grid[gy * w + gx] = 1;
                }
            }
        }
    });

    const m = /^#?([0-9a-f]{6})$/i.exec(bgColorHex);
    const v = m ? parseInt(m[1] ?? 'ffffff', 16) : 0xffffff;
    const r = (v >> 16) & 0xff;
    const g = (v >> 8) & 0xff;
    const b = v & 0xff;

    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < grid.length; i++) {
        if ((grid[i] ?? 0) === 0) {
            continue;
        }
        // Edge pixels (any empty 4-neighbor) get half alpha for a soft rim.
        const x = i % w;
        const y = (i - x) / w;
        const interior =
            x > 0 &&
            y > 0 &&
            x < w - 1 &&
            y < h - 1 &&
            (grid[i - 1] ?? 0) === 1 &&
            (grid[i + 1] ?? 0) === 1 &&
            (grid[i - w] ?? 0) === 1 &&
            (grid[i + w] ?? 0) === 1;
        const p = i * 4;
        rgba[p] = r;
        rgba[p + 1] = g;
        rgba[p + 2] = b;
        rgba[p + 3] = interior ? 255 : 128;
    }

    return {
        pageIndex,
        bboxNorm: { x: x0 / rasterWidth, y: y0 / rasterHeight, w: w / rasterWidth, h: h / rasterHeight },
        rgba,
        width: w,
        height: h,
    };
};
