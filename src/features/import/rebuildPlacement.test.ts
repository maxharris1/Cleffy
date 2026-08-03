import { describe, expect, it } from 'vitest';

import { rotatedViewportDims, type PageRotation } from '@/features/export/pdfMapping';
import { computePatchPlacement } from '@/features/import/rebuildPlacement';

/**
 * Verify by reconstruction: rotate the image rect around its anchor by
 * rotateDeg (what pdf-lib does), then map every PDF-space corner back to
 * display space and compare with the intended display rect.
 */
const pdfToDisplay = (rot: PageRotation, pw: number, ph: number, x: number, y: number): [number, number] => {
    switch (rot) {
        case 0:
            return [x, ph - y];
        case 90:
            return [y, x];
        case 180:
            return [pw - x, y];
        case 270:
            return [ph - y, pw - x];
    }
};

const PW = 600; // unrotated PDF page width
const PH = 800;

describe('computePatchPlacement', () => {
    const bboxNorm = { x: 0.25, y: 0.125, w: 0.1, h: 0.05 };

    for (const rot of [0, 90, 180, 270] as const) {
        it(`places the patch so its display footprint matches (rot ${rot})`, () => {
            const { vw, vh } = rotatedViewportDims(rot, PW, PH);
            const placement = computePatchPlacement(rot, PW, PH, bboxNorm);
            expect(placement.rotateDeg).toBe(rot);
            expect(placement.width).toBeCloseTo(bboxNorm.w * vw, 6);
            expect(placement.height).toBeCloseTo(bboxNorm.h * vh, 6);

            // Corners of the drawn image in PDF space: anchor + rotated axes.
            const rad = (rot * Math.PI) / 180;
            const rightX = Math.cos(rad) * placement.width;
            const rightY = Math.sin(rad) * placement.width;
            const upX = -Math.sin(rad) * placement.height;
            const upY = Math.cos(rad) * placement.height;
            const corners: [number, number][] = [
                [placement.x, placement.y],
                [placement.x + rightX, placement.y + rightY],
                [placement.x + rightX + upX, placement.y + rightY + upY],
                [placement.x + upX, placement.y + upY],
            ];

            const displayCorners = corners.map(([x, y]) => pdfToDisplay(rot, PW, PH, x, y));
            const xs = displayCorners.map(([x]) => x);
            const ys = displayCorners.map(([, y]) => y);
            expect(Math.min(...xs)).toBeCloseTo(bboxNorm.x * vw, 4);
            expect(Math.max(...xs)).toBeCloseTo((bboxNorm.x + bboxNorm.w) * vw, 4);
            expect(Math.min(...ys)).toBeCloseTo(bboxNorm.y * vh, 4);
            expect(Math.max(...ys)).toBeCloseTo((bboxNorm.y + bboxNorm.h) * vh, 4);
        });
    }
});
