import type { GlyphStrokes, Point } from '@/features/viewer/ink/handwriting/recognizer/pointCloud';

/**
 * Hand-authored glyph templates for the closed on-device set. Coordinates
 * are in an arbitrary frame with y DOWN; only the SHAPE (with its aspect
 * ratio) matters since every cloud is scaled uniformly and centred.
 *
 * Classes: digits 0–5 (fingerings), the letters that spell the dynamics and
 * teaching abbreviations (`p f m s z r c e d i t`), plus two marks that are
 * not letters (`accent`, `fermata`). Words are assembled from letters by the
 * recognizer and checked against a lexicon; the letters never convert alone.
 */

export type GlyphClass =
    | '0'
    | '1'
    | '2'
    | '3'
    | '4'
    | '5'
    | 'p'
    | 'f'
    | 'm'
    | 's'
    | 'z'
    | 'r'
    | 'c'
    | 'e'
    | 'd'
    | 'i'
    | 't'
    | 'accent'
    | 'fermata';

export interface Template {
    cls: GlyphClass;
    strokes: GlyphStrokes;
}

const deg = (a: number): number => (a * Math.PI) / 180;

/** Polyline through the given corners. */
const line = (...pts: Point[]): Point[] => pts;

/**
 * Arc of a circle, angles in degrees measured clockwise from +x (y down), so
 * 0° is right, 90° is bottom, 180° is left, 270° (= -90°) is top.
 */
const arc = (cx: number, cy: number, r: number, fromDeg: number, toDeg: number, steps = 16): Point[] => {
    const out: Point[] = [];
    for (let i = 0; i <= steps; i++) {
        const a = deg(fromDeg + ((toDeg - fromDeg) * i) / steps);
        out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return out;
};

/** Ellipse arc (rx, ry) with the same angle convention. */
const ellipse = (
    cx: number,
    cy: number,
    rx: number,
    ry: number,
    fromDeg: number,
    toDeg: number,
    steps = 24,
): Point[] => {
    const out: Point[] = [];
    for (let i = 0; i <= steps; i++) {
        const a = deg(fromDeg + ((toDeg - fromDeg) * i) / steps);
        out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
    }
    return out;
};

const join = (...parts: Point[][]): Point[] => parts.flat();

const t = (cls: GlyphClass, ...strokes: Point[][]): Template => ({ cls, strokes });

export const TEMPLATES: readonly Template[] = [
    // ---- digits ---------------------------------------------------------
    t('0', ellipse(0.3, 0.5, 0.3, 0.5, 0, 360)),
    t('0', ellipse(0.25, 0.5, 0.25, 0.5, 0, 360)),
    t('1', line([0.5, 0], [0.5, 1])),
    t('1', line([0.5, 0], [0.48, 1.0])),
    t('1', line([0.3, 0.18], [0.5, 0], [0.5, 1])),
    t('2', join(arc(0.35, 0.3, 0.3, 200, 380), line([0.6, 0.45], [0.05, 1]), line([0.05, 1], [0.7, 1]))),
    t('2', join(arc(0.35, 0.28, 0.28, 190, 370), line([0.58, 0.42], [0.08, 0.98], [0.7, 0.98]))),
    t('3', join(arc(0.35, 0.25, 0.25, 200, 450), arc(0.35, 0.75, 0.25, 270, 520))),
    t('3', join(arc(0.32, 0.26, 0.26, 210, 440), arc(0.32, 0.74, 0.26, 280, 510))),
    t('4', line([0.5, 0], [0.05, 0.62], [0.72, 0.62]), line([0.52, 0.02], [0.52, 1])),
    t('4', line([0.48, 0.02], [0.08, 0.6], [0.7, 0.6]), line([0.5, 0.3], [0.5, 1])),
    t('4', line([0.5, 0], [0.05, 0.62], [0.72, 0.62], [0.5, 0], [0.5, 1])),
    t('5', join(line([0.68, 0], [0.15, 0], [0.1, 0.45]), arc(0.36, 0.72, 0.29, 250, 510))),
    t('5', join(line([0.65, 0.02], [0.18, 0.02], [0.12, 0.42]), arc(0.34, 0.7, 0.3, 245, 505))),

    // ---- dynamics / teaching letters (italic-ish hands) ------------------
    // p: descender stem with a bowl at x-height.
    t('p', line([0.12, 0.3], [0.12, 1]), arc(0.36, 0.5, 0.24, 180, 540)),
    t('p', line([0.1, 0.28], [0.1, 1]), join(line([0.1, 0.35], [0.2, 0.28]), arc(0.34, 0.5, 0.24, 240, 540))),
    // One-stroke mouse `p`: down the stem then around the bowl without lifting.
    t('p', join(line([0.12, 0.0], [0.12, 1.0]), arc(0.36, 0.48, 0.24, 180, 540))),
    t('p', join(line([0.16, 0.02], [0.16, 1.0]), ellipse(0.38, 0.48, 0.2, 0.18, 200, 560))),
    // Smaller bowl, still one stroke — mouse users often under-draw the loop.
    t('p', join(line([0.16, 0.0], [0.16, 1.0]), ellipse(0.32, 0.48, 0.16, 0.16, 190, 550))),
    // f: tall curved stem crossing the x-height, hooked top, tail below.
    t(
        'f',
        line([0.05, 1], [0.2, 0.75], [0.3, 0.4], [0.4, 0.12], [0.55, 0], [0.68, 0.06]),
        line([0.12, 0.42], [0.55, 0.42]),
    ),
    t(
        'f',
        join(arc(0.55, 0.2, 0.2, 270, 180), line([0.35, 0.2], [0.35, 0.9]), arc(0.2, 0.9, 0.15, 0, 90)),
        line([0.15, 0.4], [0.55, 0.4]),
    ),
    // m: three arches (wide, x-height).
    t(
        'm',
        join(
            line([0.05, 0.45], [0.05, 0.12]),
            arc(0.2, 0.12, 0.15, 180, 360),
            line([0.35, 0.12], [0.35, 0.45], [0.35, 0.12]),
            arc(0.5, 0.12, 0.15, 180, 360),
            line([0.65, 0.12], [0.65, 0.45]),
        ),
    ),
    t(
        'm',
        join(
            line([0.02, 0.5], [0.05, 0.1]),
            arc(0.19, 0.12, 0.14, 180, 360),
            line([0.33, 0.12], [0.33, 0.48], [0.33, 0.12]),
            arc(0.47, 0.12, 0.14, 180, 360),
            line([0.61, 0.12], [0.63, 0.5]),
        ),
    ),
    // s: two opposing half arcs.
    t('s', join(arc(0.3, 0.25, 0.22, 330, 100), arc(0.3, 0.75, 0.25, 260, 500))),
    t('s', join(arc(0.28, 0.24, 0.2, 340, 110), arc(0.32, 0.72, 0.26, 250, 505))),
    // z: zigzag.
    t('z', line([0.05, 0.05], [0.6, 0.05], [0.05, 0.6], [0.6, 0.6])),
    t('z', line([0.02, 0.02], [0.62, 0.05], [0.0, 0.58], [0.64, 0.6])),
    // r: stem with a shoulder.
    t('r', line([0.08, 0.02], [0.08, 0.55]), join(line([0.08, 0.2], [0.14, 0.08]), arc(0.3, 0.2, 0.16, 190, 330))),
    t('r', join(line([0.08, 0.55], [0.08, 0.02], [0.1, 0.16]), arc(0.28, 0.2, 0.17, 190, 340))),
    // c: open arc.
    t('c', arc(0.3, 0.3, 0.3, 40, 320)),
    t('c', arc(0.28, 0.3, 0.28, 50, 310)),
    // e: bar then loop.
    t('e', join(line([0.05, 0.3], [0.58, 0.3]), arc(0.3, 0.3, 0.28, 0, -290))),
    t('e', join(line([0.06, 0.28], [0.56, 0.28]), arc(0.3, 0.3, 0.27, 0, -280))),
    // d: bowl with an ascender stem.
    t('d', arc(0.3, 0.7, 0.28, 0, 360), line([0.58, 0], [0.58, 0.98])),
    t('d', join(arc(0.3, 0.7, 0.28, 10, 350), line([0.58, 0.55], [0.6, 0]), line([0.6, 0], [0.58, 0.98]))),
    // i: short stem with a dot above.
    t('i', line([0.1, 0.35], [0.1, 1]), line([0.1, 0.05], [0.11, 0.09])),
    t('i', line([0.1, 0.32], [0.12, 1]), line([0.09, 0.02], [0.1, 0.08])),
    // t: stem with a crossbar (and a small foot).
    t('t', line([0.3, 0], [0.3, 0.95], [0.5, 1]), line([0.05, 0.35], [0.6, 0.35])),
    t('t', line([0.3, 0.02], [0.3, 1]), line([0.08, 0.35], [0.58, 0.35])),

    // ---- marks ----------------------------------------------------------
    // accent: a chevron pointing right.
    t('accent', line([0, 0], [1, 0.4], [0, 0.8])),
    t('accent', line([0, 0.05], [1, 0.42], [0.02, 0.78])),
    // fermata: an arch with a dot beneath its centre.
    t('fermata', arc(0.5, 0.6, 0.5, 180, 360), line([0.5, 0.42], [0.5, 0.5])),
    t('fermata', ellipse(0.5, 0.62, 0.5, 0.55, 180, 360), line([0.5, 0.4], [0.5, 0.5])),
];
