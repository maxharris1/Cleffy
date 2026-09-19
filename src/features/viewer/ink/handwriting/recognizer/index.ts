import type { Glyph, StrokeGroup } from '@/features/viewer/ink/handwriting/grouper';
import {
    cloudDistance,
    toCloud,
    type GlyphStrokes,
    type Point,
} from '@/features/viewer/ink/handwriting/recognizer/pointCloud';
import { TEMPLATES, type GlyphClass } from '@/features/viewer/ink/handwriting/recognizer/templates';
import type { Recognition, Recognizer } from '@/features/viewer/ink/handwriting/types';

/**
 * On-device, closed-set reader for the writer's grouped ink. No network, no
 * metering, never called mid-stroke.
 *
 * - One isolated glyph: a fingering digit 0–5, a lone dynamic letter (`p`,
 *   `f`), an accent or a fermata. Anything else abstains.
 * - One writing line: every glyph must read as a letter AND the word must
 *   be in the dynamics/teaching lexicon (`mf`, `sfz`, `cresc.`, `tr`, …).
 *   Free text is not this reader's job — it abstains so the ink stays (a
 *   metered transcription may pick it up later; see the controller).
 *
 * Precision over recall: a match must be close AND clearly better than the
 * runner-up class. Undo is the correction UI for the rare miss.
 */

/**
 * Greedy cloud distance (weighted mean per point, unit box) at or under which
 * a match counts. Calibrated on the fixtures: same-class hands score
 * ≈0.006–0.018, the nearest wrong class ≈0.02–0.07, expressive scribble ≥0.04.
 */
export const ACCEPT_DISTANCE = 0.03;
/** The runner-up class must trail by at least this much. */
export const CLASS_MARGIN = 0.01;
/** A stroke whose bbox is under this fraction of the glyph's size is a dot. */
const DOT_FRACTION = 0.18;
/** A `1` is a near-vertical line: width / height under this. */
const ONE_MAX_ASPECT = 0.42;

/** Dynamics and teaching tokens the closed set may produce from a writing line. */
export const SYMBOL_LEXICON: ReadonlySet<string> = new Set([
    'p',
    'f',
    'pp',
    'ff',
    'mp',
    'mf',
    'fp',
    'pf',
    'sf',
    'sfz',
    'cresc.',
    'dim.',
    'tr',
]);

/** Text stored for the two marks that are not letters (SMuFL text-font codepoints). */
export const ACCENT_TEXT = '\uE4A0';
export const FERMATA_TEXT = '\uE4C0';

export interface GlyphMatch {
    cls: GlyphClass;
    distance: number;
    margin: number;
}

interface Prepared {
    cls: GlyphClass;
    cloud: Point[];
    strokeCount: number;
    dots: number;
}

const bboxOf = (strokes: GlyphStrokes): { w: number; h: number } => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const stroke of strokes) {
        for (const [x, y] of stroke) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }
    return minX === Infinity ? { w: 0, h: 0 } : { w: maxX - minX, h: maxY - minY };
};

/** Strokes small enough to be i-dots / fermata dots, relative to the whole glyph. */
const countDots = (strokes: GlyphStrokes): number => {
    const whole = bboxOf(strokes);
    const size = Math.max(whole.w, whole.h);
    if (size === 0) {
        return 0;
    }
    return strokes.filter((s) => {
        const b = bboxOf([s]);
        return Math.max(b.w, b.h) < DOT_FRACTION * size;
    }).length;
};

const PREPARED: readonly Prepared[] = TEMPLATES.map((template) => ({
    cls: template.cls,
    cloud: toCloud(template.strokes),
    strokeCount: template.strokes.length,
    dots: countDots(template.strokes),
}));

/** Read one glyph against the template set (null = no confident class). */
export const classifyGlyph = (strokes: GlyphStrokes): GlyphMatch | null => {
    const cleaned = strokes.filter((s) => s.length > 0);
    if (cleaned.length === 0) {
        return null;
    }
    const cloud = toCloud(cleaned);
    const strokeCount = cleaned.length;
    const dots = countDots(cleaned);
    const { w, h } = bboxOf(cleaned);

    const bestPerClass = new Map<GlyphClass, number>();
    for (const template of PREPARED) {
        if (template.dots !== dots || Math.abs(template.strokeCount - strokeCount) > 1) {
            continue;
        }
        if (template.cls === '1' && h > 0 && w / h > ONE_MAX_ASPECT) {
            continue;
        }
        const d = cloudDistance(cloud, template.cloud);
        const prev = bestPerClass.get(template.cls);
        if (prev === undefined || d < prev) {
            bestPerClass.set(template.cls, d);
        }
    }
    const ranked = [...bestPerClass.entries()].sort((a, b) => a[1] - b[1]);
    const best = ranked[0];
    if (!best || best[1] > ACCEPT_DISTANCE) {
        return null;
    }
    const runnerUp = ranked[1]?.[1] ?? Infinity;
    const margin = runnerUp - best[1];
    if (margin < CLASS_MARGIN) {
        return null;
    }
    return { cls: best[0], distance: best[1], margin };
};

/** Group glyph → per-stroke polylines in page-width units (y scaled by the aspect). */
export const glyphStrokes = (glyph: Glyph, aspect: number): GlyphStrokes =>
    glyph.strokes.map((stroke) => {
        const out: Point[] = [];
        for (let i = 0; i < stroke.pts.length - 2; i += 3) {
            out.push([stroke.pts[i] ?? 0, (stroke.pts[i + 1] ?? 0) * aspect]);
        }
        return out;
    });

const isDigit = (cls: GlyphClass): boolean => cls >= '0' && cls <= '5';

const loneGlyph = (match: GlyphMatch): Recognition | null => {
    switch (match.cls) {
        case '0':
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
            return { text: match.cls, kind: 'digit' };
        case 'p':
        case 'f':
            return { text: match.cls, kind: 'symbol' };
        case 'accent':
            return { text: ACCENT_TEXT, kind: 'symbol' };
        case 'fermata':
            return { text: FERMATA_TEXT, kind: 'symbol' };
        case 'm':
        case 's':
        case 'z':
        case 'r':
        case 'c':
        case 'e':
        case 'd':
        case 'i':
        case 't':
            // A lone letter is not a dynamic.
            return null;
        default: {
            const exhaustive: never = match.cls;
            return exhaustive;
        }
    }
};

/** Median glyph height of a line, for spotting the `.` of `cresc.`. */
const medianHeight = (group: StrokeGroup): number => {
    const heights = group.glyphs.map((g) => g.box.y1 - g.box.y0).sort((a, b) => a - b);
    const mid = Math.floor(heights.length / 2);
    return heights.length % 2 === 1 ? (heights[mid] ?? 0) : ((heights[mid - 1] ?? 0) + (heights[mid] ?? 0)) / 2;
};

/** Closed-set on-device recognizer over a flushed group. */
export const recognizeOnDevice: Recognizer = (group: StrokeGroup): Recognition | null => {
    if (group.kind === 'glyph') {
        const glyph = group.glyphs[0];
        if (!glyph) {
            return null;
        }
        const match = classifyGlyph(glyphStrokes(glyph, group.aspect));
        return match ? loneGlyph(match) : null;
    }

    const lineH = medianHeight(group);
    let word = '';
    for (const glyph of group.glyphs) {
        const gh = glyph.box.y1 - glyph.box.y0;
        const gw = glyph.box.x1 - glyph.box.x0;
        if (gh < 0.25 * lineH && gw < 0.25 * lineH) {
            word += '.';
            continue;
        }
        const match = classifyGlyph(glyphStrokes(glyph, group.aspect));
        if (!match || match.cls === 'accent' || match.cls === 'fermata' || isDigit(match.cls)) {
            return null;
        }
        word += match.cls;
    }
    return SYMBOL_LEXICON.has(word) ? { text: word, kind: 'symbol' } : null;
};
