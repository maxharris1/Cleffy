import { describe, expect, it } from 'vitest';

import { getSvgPathFromStroke, strokeInputPoints } from '@/features/viewer/ink/strokeRenderer';
import { decimateStroke, strokeBbox, viewportToPagePoint } from '@/features/viewer/geometry';

describe('getSvgPathFromStroke', () => {
    it('produces a closed smooth path', () => {
        const path = getSvgPathFromStroke([
            [0, 0],
            [10, 0],
            [10, 10],
            [0, 10],
        ]);
        expect(path.startsWith('M')).toBe(true);
        expect(path.endsWith('Z')).toBe(true);
        expect(path).toContain('Q');
    });

    it('returns empty for degenerate outlines', () => {
        expect(getSvgPathFromStroke([[0, 0]])).toBe('');
    });
});

describe('strokeInputPoints', () => {
    it('scales normalized triplets to page pixels', () => {
        const pts = strokeInputPoints({ pts: [0.5, 0.25, 0.8], w: 0.005 }, 1000, 2000);
        expect(pts).toEqual([[500, 500, 0.8]]);
    });
});

describe('decimateStroke', () => {
    it('drops points closer than the threshold but keeps endpoints', () => {
        const pts = [0, 0, 0.5, 0.001, 0, 0.5, 0.002, 0, 0.5, 0.5, 0, 0.9];
        const out = decimateStroke(pts, 0.01);
        expect(out.slice(0, 3)).toEqual([0, 0, 0.5]);
        expect(out.slice(-3)).toEqual([0.5, 0, 0.9]);
        expect(out.length).toBeLessThan(pts.length);
    });

    it('keeps short strokes untouched', () => {
        const pts = [0, 0, 0.5, 1, 1, 0.5];
        expect(decimateStroke(pts, 0.1)).toEqual(pts);
    });
});

describe('strokeBbox', () => {
    it('computes min/max over triplets', () => {
        expect(strokeBbox([0.1, 0.9, 0.5, 0.4, 0.2, 0.5])).toEqual([0.1, 0.2, 0.4, 0.9]);
    });
});

describe('viewportToPagePoint', () => {
    const layouts = [
        { top: 16, left: 0, width: 600, height: 800 },
        { top: 832, left: 100, width: 400, height: 700 },
    ];

    it('maps a viewport point into normalized page coords', () => {
        const view = { scale: 2, scrollX: 100, scrollY: 50 };
        // Content point (300, 416) = page 0 center-x, halfway down.
        const p = viewportToPagePoint(view, layouts, 300 * 2 - 100, 416 * 2 - 50);
        expect(p?.pageIndex).toBe(0);
        expect(p?.nx).toBeCloseTo(0.5);
        expect(p?.ny).toBeCloseTo(0.5);
    });

    it('returns null in the gap between pages', () => {
        const view = { scale: 1, scrollX: 0, scrollY: 0 };
        expect(viewportToPagePoint(view, layouts, 300, 820)).toBeNull();
    });

    it('respects page horizontal offsets', () => {
        const view = { scale: 1, scrollX: 0, scrollY: 0 };
        const p = viewportToPagePoint(view, layouts, 300, 1182);
        expect(p?.pageIndex).toBe(1);
        expect(p?.nx).toBeCloseTo(0.5);
    });
});
