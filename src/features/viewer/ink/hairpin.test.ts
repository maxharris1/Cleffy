import { describe, expect, it } from 'vitest';

import { hairpinAnchorAt, hairpinPointsPx, hairpinSpreadFor, hitTestHairpin } from '@/features/viewer/ink/hairpin';
import type { HairpinPayload } from '@/types/models';

const PAGE_W = 1000;
const PAGE_H = 1400;

const wedge = (open: 'start' | 'end'): HairpinPayload => ({
    type: 'hairpin',
    x1: 0.2,
    y1: 0.5,
    x2: 0.6,
    y2: 0.5,
    spread: 0.02,
    open,
});

describe('hairpin', () => {
    it('maps pen size to mouth spread', () => {
        expect(hairpinSpreadFor('thin')).toBeLessThan(hairpinSpreadFor('medium'));
        expect(hairpinSpreadFor('medium')).toBeLessThan(hairpinSpreadFor('thick'));
    });

    it('puts the mouth on the dragged end for a crescendo', () => {
        const points = hairpinPointsPx(wedge('end'), PAGE_W, PAGE_H);
        expect(points.tip).toEqual({ x: 200, y: 700 });
        expect(points.mouth.x).toBeCloseTo(600);
        expect(points.mouthA.y).not.toBeCloseTo(points.mouthB.y);
    });

    it('puts the mouth on the start anchor for a diminuendo', () => {
        const points = hairpinPointsPx(wedge('start'), PAGE_W, PAGE_H);
        expect(points.tip).toEqual({ x: 600, y: 700 });
        expect(points.mouth.x).toBeCloseTo(200);
    });

    it('hits an arm and misses the empty page', () => {
        const payload = wedge('end');
        // The arms leave the centre line as the mouth opens, so pick near the tip.
        expect(hitTestHairpin(payload, 0.25, 0.5, 8, PAGE_W, PAGE_H)).toBe(true);
        expect(hitTestHairpin(payload, 0.4, 0.2, 8, PAGE_W, PAGE_H)).toBe(false);
    });

    it('names the nearer anchor inside the handle radius', () => {
        const payload = wedge('end');
        expect(hairpinAnchorAt(payload, 0.2, 0.5, 12, PAGE_W, PAGE_H)).toBe('start');
        expect(hairpinAnchorAt(payload, 0.6, 0.5, 12, PAGE_W, PAGE_H)).toBe('end');
        expect(hairpinAnchorAt(payload, 0.4, 0.5, 12, PAGE_W, PAGE_H)).toBeNull();
    });
});
