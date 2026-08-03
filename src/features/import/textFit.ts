import type { TextPayload } from '@/types/models';

/**
 * Size/anchor calibration for converting a detected glyph bbox into a native
 * text annotation that visually matches the handwriting's position and scale.
 *
 * Renderer contract (strokeRenderer.drawAnnotation): fontPx = size × pageWpx,
 * textBaseline 'top' (anchor at the em-box top), system-ui. The digit's
 * visual top sits topInset·fontPx below that anchor, and its visual height is
 * capRatio·fontPx — both measured once per session from a probe canvas.
 */

/** Clamps around the UI default text size 0.018 (PdfViewport.DEFAULT_TEXT_SIZE). */
export const MIN_TEXT_SIZE = 0.008;
export const MAX_TEXT_SIZE = 0.06;

/** Deterministic fallbacks for environments without TextMetrics box fields (jsdom). */
export const CAP_RATIO_FALLBACK = 0.7;
export const TOP_INSET_FALLBACK = 0.16;

export interface FontMetricRatios {
    /** Digit visual height / font size. */
    capRatio: number;
    /** Gap from the 'top'-baseline anchor down to the digit's visual top, / font size. */
    topInset: number;
}

let cached: FontMetricRatios | null = null;

/** Measure the system-ui digit metrics once (probe canvas; falls back deterministically). */
export const calibrateSystemFontMetrics = (): FontMetricRatios => {
    if (cached) {
        return cached;
    }
    let ratios: FontMetricRatios = { capRatio: CAP_RATIO_FALLBACK, topInset: TOP_INSET_FALLBACK };
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            const probePx = 100;
            ctx.font = `${probePx}px system-ui, -apple-system, sans-serif`;
            ctx.textBaseline = 'alphabetic';
            const m = ctx.measureText('0123456789');
            const cap = m.actualBoundingBoxAscent;
            const emTop = m.fontBoundingBoxAscent;
            if (Number.isFinite(cap) && cap > 0 && Number.isFinite(emTop) && emTop >= cap) {
                ratios = { capRatio: cap / probePx, topInset: (emTop - cap) / probePx };
            }
        }
        canvas.width = 0;
        canvas.height = 0;
    } catch {
        // Keep fallbacks.
    }
    cached = ratios;
    return ratios;
};

/** Test hook. */
export const resetFontMetricsCache = (): void => {
    cached = null;
};

/**
 * Build a TextPayload whose rendered glyphs match a detected ink bbox:
 * left edge on the ink's left edge, visual top on the ink's top edge,
 * visual height ≈ `glyphHeightPx` (usually the bbox height; for multi-glyph
 * runs pass the median member height so one tall glyph doesn't inflate all).
 */
export const textPayloadFromBbox = (
    bbox: { x: number; y: number; w: number; h: number },
    glyphHeightPx: number,
    text: string,
    rasterWidth: number,
    rasterHeight: number,
    metrics: FontMetricRatios = calibrateSystemFontMetrics(),
): TextPayload => {
    const fontPx = glyphHeightPx / Math.max(metrics.capRatio, 0.1);
    const size = Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, fontPx / rasterWidth));
    const anchorYpx = bbox.y - metrics.topInset * size * rasterWidth;
    return {
        x: Math.min(1, Math.max(0, bbox.x / rasterWidth)),
        y: Math.min(1, Math.max(0, anchorYpx / rasterHeight)),
        text,
        size,
    };
};
