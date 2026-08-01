/**
 * Coordinate mapping for PDF export (plan §export).
 *
 * Annotations are normalized against the ROTATED viewport (what the user saw).
 * pdf-lib draws in unrotated PDF user space (y-up). These helpers invert the
 * pdf.js viewport rotation. Convention pin (silent-mirroring trap): the SVG
 * paths handed to drawSvgPath are y-DOWN and anchored at {x: 0, y: pageHeight}
 * — do NOT pre-flip y in the path data.
 */

export type PageRotation = 0 | 90 | 180 | 270;

export const normalizeRotation = (angle: number): PageRotation => {
    const rot = ((angle % 360) + 360) % 360;
    return (rot === 90 || rot === 180 || rot === 270 ? rot : 0) as PageRotation;
};

/** Displayed (rotated) viewport dimensions for a PDF page. */
export const rotatedViewportDims = (rot: PageRotation, pw: number, ph: number): { vw: number; vh: number } => {
    return rot % 180 === 0 ? { vw: pw, vh: ph } : { vw: ph, vh: pw };
};

/**
 * Rotated-viewport point (y-down, as displayed) → PDF user space (y-up).
 * Inverse of pdf.js's PageViewport transforms at scale 1.
 */
export const viewportToPdfPoint = (
    rot: PageRotation,
    pw: number,
    ph: number,
    vx: number,
    vy: number,
): [x: number, y: number] => {
    switch (rot) {
        case 0:
            return [vx, ph - vy];
        case 90:
            return [vy, vx];
        case 180:
            return [pw - vx, vy];
        case 270:
            return [pw - vy, ph - vx];
    }
};

/** Normalized page coords → PDF user space (y-up). */
export const normToPdfPoint = (
    rot: PageRotation,
    pw: number,
    ph: number,
    nx: number,
    ny: number,
): [x: number, y: number] => {
    const { vw, vh } = rotatedViewportDims(rot, pw, ph);
    return viewportToPdfPoint(rot, pw, ph, nx * vw, ny * vh);
};

/** pdf-lib standard fonts encode WinAnsi only — replace what would throw. */
export const sanitizeWinAnsi = (text: string): string => {
    // Printable ASCII + Latin-1 supplement + newline survive; the rest become '?'.

    return text.replace(/[^\x20-\x7e\xa0-\xff\n]/g, '?');
};

/** '#rrggbb' → 0–1 rgb components (pdf-lib's expected range). */
export const hexToRgb01 = (hex: string): [r: number, g: number, b: number] => {
    const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!match || !match[1]) {
        return [0, 0, 0];
    }
    const value = parseInt(match[1], 16);
    return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
};
