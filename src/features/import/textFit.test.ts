import { beforeEach, describe, expect, it } from 'vitest';

import {
    CAP_RATIO_FALLBACK,
    MAX_TEXT_SIZE,
    MIN_TEXT_SIZE,
    resetFontMetricsCache,
    textPayloadFromBbox,
    TOP_INSET_FALLBACK,
} from '@/features/import/textFit';

const METRICS = { capRatio: CAP_RATIO_FALLBACK, topInset: TOP_INSET_FALLBACK };

describe('textPayloadFromBbox', () => {
    beforeEach(() => resetFontMetricsCache());

    it('sizes the font so the rendered digit height matches the ink height', () => {
        const payload = textPayloadFromBbox({ x: 100, y: 50, w: 10, h: 14 }, 14, '3', 2000, 2600, METRICS);
        // fontPx = 14 / 0.7 = 20 → size = 20/2000.
        expect(payload.size).toBeCloseTo(0.01, 5);
        expect(payload.text).toBe('3');
        expect(payload.x).toBeCloseTo(0.05, 5);
        // Anchor sits topInset·fontPx above the ink top: (50 − 0.16·20) / 2600.
        expect(payload.y).toBeCloseTo(46.8 / 2600, 5);
    });

    it('uses the provided glyph height (median of a run), not the union bbox height', () => {
        const payload = textPayloadFromBbox({ x: 0, y: 100, w: 80, h: 30 }, 14, '34323', 2000, 2600, METRICS);
        expect(payload.size).toBeCloseTo(20 / 2000, 5);
    });

    it('clamps size into the app range', () => {
        const tiny = textPayloadFromBbox({ x: 0, y: 0, w: 2, h: 2 }, 2, '.', 2000, 2600, METRICS);
        expect(tiny.size).toBe(MIN_TEXT_SIZE);
        const huge = textPayloadFromBbox({ x: 0, y: 0, w: 900, h: 900 }, 900, 'X', 2000, 2600, METRICS);
        expect(huge.size).toBe(MAX_TEXT_SIZE);
    });

    it('clamps the anchor into the page for glyphs at the very top', () => {
        const payload = textPayloadFromBbox({ x: 5, y: 1, w: 10, h: 14 }, 14, '5', 2000, 2600, METRICS);
        expect(payload.y).toBeGreaterThanOrEqual(0);
    });
});
