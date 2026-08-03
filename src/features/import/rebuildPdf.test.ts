import { describe, expect, it } from 'vitest';

import { REBUILD_MAX_GROWTH, mergePagePatches } from '@/features/import/rebuildPdf';
import type { WhiteoutPatch } from '@/features/import/whiteout';

/** Solid 2×2 patch of one color at a normalized position on a 100×200 raster. */
const solidPatch = (pxX: number, pxY: number, rgb: [number, number, number], alpha = 255): WhiteoutPatch => {
    const rgba = new Uint8ClampedArray(2 * 2 * 4) as Uint8ClampedArray<ArrayBuffer>;
    for (let p = 0; p < 4; p++) {
        rgba[p * 4] = rgb[0];
        rgba[p * 4 + 1] = rgb[1];
        rgba[p * 4 + 2] = rgb[2];
        rgba[p * 4 + 3] = alpha;
    }
    return {
        pageIndex: 0,
        bboxNorm: { x: pxX / 100, y: pxY / 200, w: 2 / 100, h: 2 / 200 },
        rgba,
        width: 2,
        height: 2,
    };
};

describe('mergePagePatches', () => {
    it('composites disjoint patches into one patch with the union bbox', () => {
        const merged = mergePagePatches([solidPatch(10, 20, [200, 190, 180]), solidPatch(20, 30, [100, 90, 80])], 100, 200);
        expect(merged.width).toBe(12); // 10..22
        expect(merged.height).toBe(12); // 20..32
        expect(merged.bboxNorm).toEqual({ x: 0.1, y: 0.1, w: 0.12, h: 0.06 });
        // Top-left pixel = first patch color; a gap pixel stays transparent.
        expect([merged.rgba[0], merged.rgba[1], merged.rgba[2], merged.rgba[3]]).toEqual([200, 190, 180, 255]);
        const gap = (5 * merged.width + 5) * 4;
        expect(merged.rgba[gap + 3]).toBe(0);
        // Bottom-right region carries the second patch color.
        const br = ((30 - 20) * merged.width + (20 - 10)) * 4;
        expect([merged.rgba[br], merged.rgba[br + 1], merged.rgba[br + 2]]).toEqual([100, 90, 80]);
    });

    it('solid pixels win over half-alpha rim pixels in overlaps', () => {
        const rim = solidPatch(10, 20, [1, 2, 3], 128);
        const solid = solidPatch(10, 20, [200, 190, 180], 255);
        // Rim drawn LAST must not overwrite the solid pixel underneath.
        const merged = mergePagePatches([solid, rim], 100, 200);
        expect([merged.rgba[0], merged.rgba[1], merged.rgba[2], merged.rgba[3]]).toEqual([200, 190, 180, 255]);
    });

    it('single patch passes through unchanged', () => {
        const patch = solidPatch(40, 60, [250, 240, 230]);
        const merged = mergePagePatches([patch], 100, 200);
        expect(merged.bboxNorm).toEqual(patch.bboxNorm);
        expect(merged.rgba).toEqual(patch.rgba);
    });
});

describe('REBUILD_MAX_GROWTH', () => {
    it('scales the allowance with the number of cleaned pages', () => {
        const base = REBUILD_MAX_GROWTH(1_000_000, 0);
        expect(REBUILD_MAX_GROWTH(1_000_000, 30) - base).toBe(30 * 150 * 1024);
    });
});
