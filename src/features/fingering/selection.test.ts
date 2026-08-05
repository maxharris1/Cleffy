import { describe, expect, it } from 'vitest';

import { inflateRect, rectFromPoints, rectsIntersect } from '@/features/fingering/selection';

describe('rectFromPoints', () => {
    it('normalizes any drag orientation', () => {
        expect(rectFromPoints(0.4, 0.5, 0.1, 0.2)).toEqual({ x: 0.1, y: 0.2, w: 0.30000000000000004, h: 0.3 });
        const r = rectFromPoints(0.1, 0.2, 0.4, 0.5);
        expect(r.x).toBeCloseTo(0.1);
        expect(r.w).toBeCloseTo(0.3);
    });
});

describe('rectsIntersect', () => {
    it('detects overlap, touch, and miss', () => {
        const a = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
        expect(rectsIntersect(a, { x: 0.2, y: 0.2, w: 0.2, h: 0.2 })).toBe(true);
        expect(rectsIntersect(a, { x: 0.3, y: 0.1, w: 0.1, h: 0.1 })).toBe(true); // edge touch
        expect(rectsIntersect(a, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })).toBe(false);
    });
});

describe('inflateRect', () => {
    it('inflates and clamps to the page', () => {
        const r = inflateRect({ x: 0.02, y: 0.5, w: 0.1, h: 0.1 }, 0.05, 0.02);
        expect(r.x).toBe(0);
        expect(r.y).toBeCloseTo(0.48);
        expect(r.x + r.w).toBeCloseTo(0.17);
        const edge = inflateRect({ x: 0.9, y: 0.9, w: 0.09, h: 0.09 }, 0.05, 0.05);
        expect(edge.x + edge.w).toBeLessThanOrEqual(1);
        expect(edge.y + edge.h).toBeLessThanOrEqual(1);
    });
});
