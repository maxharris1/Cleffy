import { describe, expect, it } from 'vitest';

import { hexToRgb, oklabDeltaE, rgbToOklab, snapToPalette } from '@/features/import/colorSnap';

describe('snapToPalette', () => {
    it('snaps teacher-pen blue onto the palette blue', () => {
        expect(snapToPalette('#2b4fc1')).toBe('#2563eb');
    });

    it('keeps exact palette colors', () => {
        expect(snapToPalette('#dc2626')).toBe('#dc2626');
        expect(snapToPalette('#DC2626')).toBe('#dc2626');
    });

    it('snaps a slightly-off red to palette red, not orange', () => {
        expect(snapToPalette('#c53030')).toBe('#dc2626');
    });

    it('keeps colors that are far from every swatch', () => {
        expect(snapToPalette('#f5f0e1')).toBe('#f5f0e1'); // beige paper tone
    });

    it('is well-behaved on malformed input', () => {
        expect(typeof snapToPalette('nonsense')).toBe('string');
    });
});

describe('oklab math', () => {
    it('white and black land at the L extremes', () => {
        expect(rgbToOklab(255, 255, 255).L).toBeCloseTo(1, 2);
        expect(rgbToOklab(0, 0, 0).L).toBeCloseTo(0, 2);
    });

    it('identical colors have zero deltaE', () => {
        const lab = rgbToOklab(...hexToRgb('#2563eb'));
        expect(oklabDeltaE(lab, lab)).toBe(0);
    });
});
