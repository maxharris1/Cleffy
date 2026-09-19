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
/**
 * Music-text glyphs such as an accent occupy only ~0.2 em, so matching a
 * letter-sized mark needs a font size well past the text clamp.
 */
export const MAX_MUSIC_TEXT_SIZE = 0.16;

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

// ---------------------------------------------------------------------------
// Word metrics (handwriting → print). The digit calibration above measures a
// cap height and nothing else; a converted word ("use wrist", "cresc.") has
// ascenders, descenders and a width that must land on the handwriting's
// footprint, and a music-font dynamic (mf) has metrics of its own. These
// measure the ACTUAL string in the ACTUAL font.

/** CSS font shorthand minus the size, e.g. `italic system-ui` or `"Bravura Text"`. */
export type FontSpec = { family: string; style?: 'normal' | 'italic' };

export const SYSTEM_FONT_FAMILY = 'system-ui, -apple-system, sans-serif';

export interface InkTextMetrics {
    /** Visual (inked) height of the string / font size. */
    heightRatio: number;
    /** Gap from the 'top'-baseline anchor down to the string's visual top / font size. */
    topInset: number;
    /** Visual width of the string / font size. */
    widthRatio: number;
}

/** Deterministic fallbacks for environments without TextMetrics box fields (jsdom). */
const FALLBACK_X_HEIGHT = 0.5;
const FALLBACK_ASCENDER = CAP_RATIO_FALLBACK;
const FALLBACK_DESCENDER = 0.2;
const FALLBACK_ADVANCE = 0.55;

const hasTall = (text: string): boolean => /[A-Z0-9bdfhklt!?()[\]{}|/\\]/.test(text);
const hasDescender = (text: string): boolean => /[gjpqyQ,;()[\]{}|/\\]/.test(text);

/** Font-agnostic guess used when the canvas cannot report glyph boxes. */
export const fallbackInkTextMetrics = (text: string): InkTextMetrics => {
    const top = hasTall(text) ? TOP_INSET_FALLBACK : TOP_INSET_FALLBACK + (FALLBACK_ASCENDER - FALLBACK_X_HEIGHT);
    const bottom = TOP_INSET_FALLBACK + FALLBACK_ASCENDER + (hasDescender(text) ? FALLBACK_DESCENDER : 0);
    return {
        heightRatio: bottom - top,
        topInset: top,
        widthRatio: Math.max(1, text.length) * FALLBACK_ADVANCE,
    };
};

const metricsCache = new Map<string, InkTextMetrics>();

/** Measure one string in one font (probe canvas, cached; deterministic fallback). */
export const measureInkText = (text: string, font: FontSpec = { family: SYSTEM_FONT_FAMILY }): InkTextMetrics => {
    const key = `${font.style ?? 'normal'}|${font.family}|${text}`;
    const hit = metricsCache.get(key);
    if (hit) {
        return hit;
    }
    let metrics = fallbackInkTextMetrics(text);
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            const probePx = 100;
            ctx.font = `${font.style ?? 'normal'} ${probePx}px ${font.family}`;
            // Measure against the SAME baseline the renderer draws with: the
            // glyph box then comes back relative to the 'top' anchor itself
            // (ascent is negative when the ink starts below it), with no
            // assumption about how the browser derives 'top' from the font's
            // ascent — Bravura's 1.13 em ascent would otherwise mislead.
            ctx.textBaseline = 'top';
            const m = ctx.measureText(text);
            const ascent = m.actualBoundingBoxAscent;
            const descent = m.actualBoundingBoxDescent;
            const width = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
            if (
                Number.isFinite(ascent) &&
                Number.isFinite(descent) &&
                Number.isFinite(width) &&
                ascent + descent > 0 &&
                width > 0
            ) {
                metrics = {
                    heightRatio: (ascent + descent) / probePx,
                    topInset: -ascent / probePx,
                    widthRatio: width / probePx,
                };
            }
        }
        canvas.width = 0;
        canvas.height = 0;
    } catch {
        // Keep fallbacks.
    }
    if (metricsCache.size > 500) {
        metricsCache.clear();
    }
    metricsCache.set(key, metrics);
    return metrics;
};

/** Drop cached measurements — all of them, or only those taken in one font family (e.g. once it has loaded). */
export const resetInkTextMetricsCache = (family?: string): void => {
    if (family === undefined) {
        metricsCache.clear();
        return;
    }
    for (const key of [...metricsCache.keys()]) {
        if (key.split('|')[1] === family) {
            metricsCache.delete(key);
        }
    }
};

/**
 * Build a TextPayload that sits on a handwriting bbox given in NORMALIZED page
 * coords (x, w against page width; y, h against page height — `aspect` is
 * pageHeight / pageWidth). The print's visual top lands on the ink's top edge
 * and its visual height matches the ink height; with `fitWidth` (multi-glyph
 * lines) the size is also capped so the print never runs past the ink's right
 * edge — a single `1` must NOT be width-fitted or it would shrink to a speck.
 */
export const textPayloadForInk = (
    bbox: { x: number; y: number; w: number; h: number },
    text: string,
    aspect: number,
    metrics: InkTextMetrics,
    options: { fitWidth?: boolean; hw?: 1; maxSize?: number } = {},
): TextPayload => {
    const inkHeightW = bbox.h * aspect;
    let size = inkHeightW / Math.max(metrics.heightRatio, 0.1);
    if (options.fitWidth && metrics.widthRatio > 0) {
        size = Math.min(size, bbox.w / metrics.widthRatio);
    }
    size = Math.min(options.maxSize ?? MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, size));
    const anchorY = bbox.y - (metrics.topInset * size) / aspect;
    const payload: TextPayload = {
        x: Math.min(1, Math.max(0, bbox.x)),
        y: Math.min(1, Math.max(0, anchorY)),
        text,
        size,
    };
    if (options.hw === 1) {
        payload.hw = 1;
    }
    return payload;
};
