import { beforeEach, describe, expect, it } from 'vitest';

import {
    CAP_RATIO_FALLBACK,
    fallbackInkTextMetrics,
    MAX_TEXT_SIZE,
    measureInkText,
    MIN_TEXT_SIZE,
    resetFontMetricsCache,
    resetInkTextMetricsCache,
    textPayloadForInk,
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

describe('textPayloadForInk (word metrics)', () => {
    const ASPECT = 1.3;
    /** Word-ish metrics: 0.9 em tall (ascender + descender), 2.5 em wide. */
    const WORD = { heightRatio: 0.9, topInset: 0.16, widthRatio: 2.5 };

    beforeEach(() => resetInkTextMetricsCache());

    it('sizes a word so its visual height matches the ink height, top on top', () => {
        // Ink box 0.018 tall in page-width units → 0.018 / 1.3 in normalized y.
        const bbox = { x: 0.3, y: 0.5, w: 0.1, h: 0.018 / ASPECT };
        const payload = textPayloadForInk(bbox, 'use', ASPECT, WORD);
        expect(payload.size).toBeCloseTo(0.02, 5);
        expect(payload.x).toBe(0.3);
        expect(payload.y).toBeCloseTo(0.5 - (0.16 * 0.02) / ASPECT, 6);
        expect(payload.hw).toBeUndefined();
    });

    it('with fitWidth, never lets a line run past the ink’s right edge', () => {
        // Height alone would say size 0.02, but the ink is only 0.03 wide.
        const bbox = { x: 0.3, y: 0.5, w: 0.03, h: 0.018 / ASPECT };
        const payload = textPayloadForInk(bbox, 'use', ASPECT, WORD, { fitWidth: true, hw: 1 });
        expect(payload.size).toBeCloseTo(0.03 / 2.5, 6);
        expect(payload.hw).toBe(1);
    });

    it('does NOT width-fit a single glyph — a thin 1 must keep its height', () => {
        const ONE = { heightRatio: 0.7, topInset: 0.16, widthRatio: 0.55 };
        const bbox = { x: 0.3, y: 0.5, w: 0.002, h: 0.014 / ASPECT };
        const payload = textPayloadForInk(bbox, '1', ASPECT, ONE);
        expect(payload.size).toBeCloseTo(0.02, 5);
    });

    it('clamps into the app size range', () => {
        const huge = textPayloadForInk({ x: 0, y: 0, w: 0.9, h: 0.5 }, 'X', ASPECT, WORD);
        expect(huge.size).toBe(MAX_TEXT_SIZE);
        const tiny = textPayloadForInk({ x: 0, y: 0, w: 0.001, h: 0.0005 }, '.', ASPECT, WORD);
        expect(tiny.size).toBe(MIN_TEXT_SIZE);
    });

    it('falls back to deterministic word metrics where the canvas has no glyph boxes (jsdom)', () => {
        const measured = measureInkText('use wrist');
        expect(measured).toEqual(fallbackInkTextMetrics('use wrist'));
        // Descenders and ascenders widen the fallback box; a plain x-height word is shorter.
        expect(fallbackInkTextMetrics('gyp').heightRatio).toBeGreaterThan(fallbackInkTextMetrics('use').heightRatio);
        expect(fallbackInkTextMetrics('tall').heightRatio).toBeGreaterThan(fallbackInkTextMetrics('use').heightRatio);
        expect(fallbackInkTextMetrics('use').topInset).toBeGreaterThan(fallbackInkTextMetrics('tall').topInset);
    });
});
