import { describe, expect, it } from 'vitest';

import { segmentPage } from '@/features/import/segmentation';
import { buildWhiteoutPatch, sampleBackgroundColor, WHITEOUT_DILATE_PX } from '@/features/import/whiteout';
import { INK_BLUE, makeRaster, paintRect } from '@/test/rasterFixtures';

describe('sampleBackgroundColor', () => {
    it('samples the local paper color, not white, on a beige scan', () => {
        const raster = makeRaster(200, 200, [244, 238, 220]);
        paintRect(raster, 80, 80, 10, 14, INK_BLUE);
        const { clusters } = segmentPage(raster, 0);
        const mask = clusters[0]?.mask;
        expect(mask).toBeDefined();
        if (mask) {
            expect(sampleBackgroundColor(raster, mask)).toBe('#f4eedc');
        }
    });

    it('ignores printed notation (dark pixels) in the ring', () => {
        const raster = makeRaster(200, 200);
        paintRect(raster, 80, 80, 10, 14, INK_BLUE);
        // Staff lines through the ring: dark, must not poison the median.
        paintRect(raster, 60, 78, 60, 2, [20, 20, 20]);
        paintRect(raster, 60, 98, 60, 2, [20, 20, 20]);
        const { clusters } = segmentPage(raster, 0);
        const mask = clusters[0]?.mask;
        if (mask) {
            expect(sampleBackgroundColor(raster, mask)).toBe('#ffffff');
        }
    });
});

describe('buildWhiteoutPatch', () => {
    it('covers the dilated mask with the paper color and leaves the rest transparent', () => {
        const raster = makeRaster(200, 200);
        paintRect(raster, 80, 80, 10, 14, INK_BLUE);
        const { clusters } = segmentPage(raster, 0);
        const cluster = clusters[0];
        expect(cluster).toBeDefined();
        if (!cluster) {
            return;
        }
        const patch = buildWhiteoutPatch(cluster.mask, '#f4eedc', 0, 200, 200);
        expect(patch.width).toBe(10 + 2 * WHITEOUT_DILATE_PX);
        expect(patch.height).toBe(14 + 2 * WHITEOUT_DILATE_PX);
        expect(patch.bboxNorm.x).toBeCloseTo((80 - WHITEOUT_DILATE_PX) / 200, 5);
        expect(patch.bboxNorm.y).toBeCloseTo((80 - WHITEOUT_DILATE_PX) / 200, 5);

        // Center pixel: opaque paper color.
        const cx = Math.floor(patch.width / 2);
        const cy = Math.floor(patch.height / 2);
        const center = (cy * patch.width + cx) * 4;
        expect(patch.rgba[center]).toBe(0xf4);
        expect(patch.rgba[center + 3]).toBe(255);

        // Corner pixel (outside the dilated rectangle's rounded coverage is
        // still inside for a rect mask): edge alpha is softened, corners of a
        // rect ARE covered — assert edge alpha is 128 on the boundary row.
        expect(patch.rgba[3]).toBe(128);
    });

    it('every masked source pixel is covered by the patch (with dilation margin)', () => {
        const raster = makeRaster(120, 120);
        paintRect(raster, 30, 40, 8, 3, INK_BLUE);
        paintRect(raster, 34, 43, 3, 8, INK_BLUE); // L-shape, merged into one cluster
        const { clusters } = segmentPage(raster, 0);
        const cluster = clusters[0];
        if (!cluster) {
            throw new Error('expected a cluster');
        }
        const patch = buildWhiteoutPatch(cluster.mask, '#ffffff', 0, 120, 120);
        const patchX = Math.round(patch.bboxNorm.x * 120);
        const patchY = Math.round(patch.bboxNorm.y * 120);
        // Sample the ink pixels: each must be opaque in patch-local coords.
        for (const [sx, sy] of [
            [30, 40],
            [37, 42],
            [36, 50],
        ] as const) {
            const px = sx - patchX;
            const py = sy - patchY;
            const alpha = patch.rgba[(py * patch.width + px) * 4 + 3] ?? 0;
            expect(alpha).toBe(255);
        }
    });
});
