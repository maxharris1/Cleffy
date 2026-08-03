import { normToPdfPoint, rotatedViewportDims, type PageRotation } from '@/features/export/pdfMapping';

/**
 * Where a cleanup patch lands in PDF user space. Patch pixels are in
 * ROTATED-viewport orientation (as displayed); pdf-lib's drawImage rotates
 * CCW around the anchor, so for every rotation the anchor is the patch's
 * DISPLAY-space bottom-left corner mapped through normToPdfPoint, with
 * rotate = the page rotation. (Same anchor-in-display-space strategy as
 * exportWorker's drawText; verified against the pdfMapping fixtures.)
 */
export interface PatchPlacement {
    x: number;
    y: number;
    width: number;
    height: number;
    rotateDeg: PageRotation;
}

export const computePatchPlacement = (
    rot: PageRotation,
    pw: number,
    ph: number,
    bboxNorm: { x: number; y: number; w: number; h: number },
): PatchPlacement => {
    const { vw, vh } = rotatedViewportDims(rot, pw, ph);
    const [x, y] = normToPdfPoint(rot, pw, ph, bboxNorm.x, bboxNorm.y + bboxNorm.h);
    return {
        x,
        y,
        width: bboxNorm.w * vw,
        height: bboxNorm.h * vh,
        rotateDeg: rot,
    };
};
