import { describe, expect, it } from 'vitest';

import {
    hexToRgb01,
    normalizeRotation,
    normToPdfPoint,
    rotatedViewportDims,
    sanitizeWinAnsi,
    viewportToPdfPoint,
    type PageRotation,
} from '@/features/export/pdfMapping';

const PW = 600;
const PH = 800;

/** pdf.js PageViewport forward transforms at scale 1 (PDF y-up → display y-down). */
const forward = (rot: PageRotation, x: number, y: number): [number, number] => {
    switch (rot) {
        case 0:
            return [x, PH - y];
        case 90:
            return [y, x];
        case 180:
            return [PW - x, y];
        case 270:
            return [PH - y, PW - x];
    }
};

describe('viewportToPdfPoint', () => {
    const samples: Array<[number, number]> = [
        [0, 0],
        [PW, PH],
        [150, 700],
        [420.5, 33.25],
    ];

    for (const rot of [0, 90, 180, 270] as const) {
        it(`inverts the pdf.js viewport transform for /Rotate ${rot}`, () => {
            for (const [x, y] of samples) {
                const [vx, vy] = forward(rot, x, y);
                const [backX, backY] = viewportToPdfPoint(rot, PW, PH, vx, vy);
                expect(backX).toBeCloseTo(x, 6);
                expect(backY).toBeCloseTo(y, 6);
            }
        });
    }

    it('maps viewport corners into page bounds for rotated pages', () => {
        const { vw, vh } = rotatedViewportDims(90, PW, PH);
        expect(vw).toBe(PH);
        expect(vh).toBe(PW);
        const [x, y] = normToPdfPoint(90, PW, PH, 1, 1);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(PW);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(PH);
    });
});

describe('normalizeRotation', () => {
    it('handles negative and >360 angles', () => {
        expect(normalizeRotation(-90)).toBe(270);
        expect(normalizeRotation(450)).toBe(90);
        expect(normalizeRotation(0)).toBe(0);
        expect(normalizeRotation(45)).toBe(0); // non-quadrant angles degrade to 0
    });
});

describe('sanitizeWinAnsi', () => {
    it('keeps latin text and newlines, replaces the rest', () => {
        expect(sanitizeWinAnsi('forte, très fört!\np')).toBe('forte, très fört!\np');
        expect(sanitizeWinAnsi('音楽 forte')).toBe('?? forte');
    });
});

describe('hexToRgb01', () => {
    it('parses hex colors', () => {
        expect(hexToRgb01('#ff0000')).toEqual([1, 0, 0]);
        expect(hexToRgb01('4f46e5')[2]).toBeCloseTo(229 / 255);
        expect(hexToRgb01('garbage')).toEqual([0, 0, 0]);
    });
});
