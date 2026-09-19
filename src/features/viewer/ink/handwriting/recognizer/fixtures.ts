import type { Glyph, StrokeGroup } from '@/features/viewer/ink/handwriting/grouper';
import type { GlyphStrokes, Point } from '@/features/viewer/ink/handwriting/recognizer/pointCloud';
import { ASPECT } from '@/features/viewer/ink/handwriting/testStrokes';

/**
 * Handwriting fixtures for the recognizer tests. Deliberately NOT built from
 * the template helpers: different parametrisations, a slant, a wobble and a
 * deterministic jitter, so a pass means the matcher generalises a little
 * rather than echoing its own templates.
 */

/** Tiny deterministic PRNG so fixtures never flake. */
const rng = (seed: number) => {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0xffffffff;
    };
};

const shear = (pts: Point[], slant: number): Point[] => pts.map(([x, y]): Point => [x + slant * (1 - y), y]);

const jitter = (pts: Point[], amount: number, seed: number): Point[] => {
    const next = rng(seed);
    return pts.map(([x, y]): Point => [x + (next() - 0.5) * amount, y + (next() - 0.5) * amount]);
};

const sample = (fn: (t: number) => Point, steps = 24): Point[] =>
    Array.from({ length: steps + 1 }, (_, i) => fn(i / steps));

const rad = (d: number): number => (d * Math.PI) / 180;

/** Sloppy hands, in an arbitrary y-down frame roughly 1 unit tall. */
export const HANDS: Record<string, GlyphStrokes> = {
    // A slightly slanted `1` with a wobble.
    one: [
        jitter(
            shear(
                sample((t): Point => [0.5, t]),
                0.08,
            ),
            0.02,
            1,
        ),
    ],
    // `2`: open top loop, straight diagonal, flat base.
    two: [
        jitter(
            [
                ...sample((t): Point => {
                    const a = rad(205 + 165 * t);
                    return [0.38 + 0.3 * Math.cos(a), 0.3 + 0.3 * Math.sin(a)];
                }, 12),
                [0.1, 0.98],
                [0.72, 0.98],
            ],
            0.02,
            2,
        ),
    ],
    // `3`: two bellies of different size.
    three: [
        jitter(
            [
                ...sample((t): Point => {
                    const a = rad(210 + 240 * t);
                    return [0.36 + 0.24 * Math.cos(a), 0.24 + 0.24 * Math.sin(a)];
                }, 12),
                ...sample((t): Point => {
                    const a = rad(275 + 235 * t);
                    return [0.34 + 0.28 * Math.cos(a), 0.72 + 0.28 * Math.sin(a)];
                }, 12),
            ],
            0.02,
            3,
        ),
    ],
    // Two-stroke open `4`, crossbar first.
    four: [
        jitter(
            [
                [0.55, 0.02],
                [0.1, 0.58],
                [0.75, 0.58],
            ],
            0.02,
            4,
        ),
        jitter(
            shear(
                sample((t): Point => [0.55, 0.05 + 0.95 * t], 8),
                -0.03,
            ),
            0.02,
            5,
        ),
    ],
    // `5` with a squarer top.
    five: [
        jitter(
            [
                [0.7, 0.02],
                [0.18, 0.04],
                [0.14, 0.44],
                ...sample((t): Point => {
                    const a = rad(255 + 250 * t);
                    return [0.38 + 0.3 * Math.cos(a), 0.7 + 0.3 * Math.sin(a)];
                }, 14),
            ],
            0.02,
            6,
        ),
    ],
    // `0`: a tilted egg.
    zero: [
        jitter(
            shear(
                sample((t): Point => {
                    const a = rad(360 * t);
                    return [0.32 + 0.28 * Math.cos(a), 0.5 + 0.48 * Math.sin(a)];
                }),
                0.05,
            ),
            0.02,
            7,
        ),
    ],
    // Dynamic `p`: stem then a round bowl.
    p: [
        jitter(
            shear(
                sample((t): Point => [0.14, 0.3 + 0.7 * t], 8),
                0.06,
            ),
            0.015,
            8,
        ),
        jitter(
            sample((t): Point => {
                const a = rad(180 + 360 * t);
                return [0.38 + 0.23 * Math.cos(a), 0.52 + 0.23 * Math.sin(a)];
            }, 16),
            0.015,
            9,
        ),
    ],
    // Dynamic `f`: long italic sweep with a crossbar.
    f: [
        jitter(
            sample((t): Point => [0.08 + 0.55 * t * t, 1 - t * (1.02 - 0.04 * t)], 16).concat([[0.7, 0.04]]),
            0.02,
            10,
        ),
        jitter(
            [
                [0.14, 0.44],
                [0.58, 0.42],
            ],
            0.015,
            11,
        ),
    ],
    // `m`: two rounded humps on a short stem, wider than tall.
    m: [
        jitter(
            [
                [0.04, 0.5],
                [0.05, 0.1],
                ...sample((t): Point => {
                    const a = rad(180 + 180 * t);
                    return [0.2 + 0.15 * Math.cos(a), 0.14 + 0.14 * Math.sin(a)];
                }, 8),
                [0.35, 0.5],
                [0.35, 0.14],
                ...sample((t): Point => {
                    const a = rad(180 + 180 * t);
                    return [0.5 + 0.15 * Math.cos(a), 0.14 + 0.14 * Math.sin(a)];
                }, 8),
                [0.66, 0.5],
            ],
            0.015,
            12,
        ),
    ],
    // Accent: a chevron.
    accent: [
        jitter(
            [
                [0.02, 0.02],
                [0.98, 0.4],
                [0.0, 0.8],
            ],
            0.02,
            13,
        ),
    ],
    // Fermata: an arch and a dot.
    fermata: [
        jitter(
            sample((t): Point => {
                const a = rad(180 + 180 * t);
                return [0.5 + 0.5 * Math.cos(a), 0.6 + 0.55 * Math.sin(a)];
            }, 14),
            0.015,
            14,
        ),
        [
            [0.49, 0.44],
            [0.51, 0.5],
        ],
    ],

    // ---- must NOT convert ------------------------------------------------
    // Crescendo hairpin — mirror of the accent, never an accent.
    hairpin: [
        jitter(
            [
                [0.98, 0.02],
                [0.02, 0.4],
                [1.0, 0.8],
            ],
            0.02,
            20,
        ),
    ],
    // An `x` — not in the set.
    cross: [
        jitter(
            [
                [0, 0],
                [0.7, 0.9],
            ],
            0.02,
            21,
        ),
        jitter(
            [
                [0.7, 0],
                [0, 0.9],
            ],
            0.02,
            22,
        ),
    ],
    // A flat horizontal tick (tenuto / underline).
    dash: [
        jitter(
            [
                [0, 0.5],
                [1, 0.52],
            ],
            0.02,
            23,
        ),
    ],
    // A spiral scribble.
    spiral: [
        sample((t): Point => {
            const a = rad(720 * t);
            const r = 0.1 + 0.4 * t;
            return [0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a)];
        }, 40),
    ],
};

/**
 * Turn hand glyphs into a StrokeGroup at a letter-sized scale on the page,
 * left to right with a small gap, the way the grouper would have emitted it.
 */
export const groupFromHands = (
    hands: GlyphStrokes[],
    options: { heightW?: number; gapW?: number; x?: number; y?: number } = {},
): StrokeGroup => {
    const heightW = options.heightW ?? 0.012;
    const gapW = options.gapW ?? heightW * 0.25;
    let x = options.x ?? 0.3;
    const y = options.y ?? 0.5;
    const glyphs: Glyph[] = [];
    let id = 0;
    for (const hand of hands) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const stroke of hand) {
            for (const [px, py] of stroke) {
                minX = Math.min(minX, px);
                minY = Math.min(minY, py);
                maxX = Math.max(maxX, px);
                maxY = Math.max(maxY, py);
            }
        }
        const scale = heightW / Math.max(maxY - minY, 1e-6);
        const w = (maxX - minX) * scale;
        const strokes = hand.map((stroke) => {
            const pts: number[] = [];
            for (const [px, py] of stroke) {
                pts.push(x + (px - minX) * scale, (y + (py - minY) * scale) / ASPECT, 0.5);
            }
            return { id: `g${id++}`, page: 0, color: '#1f2937', pts, w: 0.001, at: 0 };
        });
        glyphs.push({ strokes, box: { x0: x, y0: y, x1: x + w, y1: y + heightW } });
        x += w + gapW;
    }
    const box = glyphs
        .map((g) => g.box)
        .reduce((a, b) => ({
            x0: Math.min(a.x0, b.x0),
            y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1),
            y1: Math.max(a.y1, b.y1),
        }));
    return { page: 0, color: '#1f2937', aspect: ASPECT, glyphs, kind: glyphs.length >= 2 ? 'line' : 'glyph', box };
};
