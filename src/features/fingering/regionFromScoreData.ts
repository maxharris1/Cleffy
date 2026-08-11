import {
    clampMidi,
    midiToName,
    type NormRect,
    type RecognizedNote,
    type RecognizedRegion,
    type Staff,
} from '@/features/fingering/model';
import { measureIndexAtTick, tickAtXInMeasure, xAtTickInMeasure } from '@/features/playback/scoreTime';
import {
    clefAt,
    HAND_LH,
    HAND_RH,
    keySigAt,
    type ScoreClef,
    type ScoreData,
    type ScoreMeasure,
} from '@/types/scoreData';

const ZERO_BBOX: NormRect = { x: 0, y: 0, w: 0, h: 0 };

/** Epsilon for contiguous measure x-coverage (normalized page coords). */
const X_GAP_EPS = 1e-4;

const LETTER_DIATONIC: Record<string, number> = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };

const rectsOverlapY = (rect: NormRect, y0: number, y1: number): boolean =>
    rect.y < y1 && rect.y + rect.h > y0;

const rectsOverlapX = (rect: NormRect, x0: number, x1: number): boolean =>
    rect.x < x1 && rect.x + rect.w > x0;

const hasGeometry = (m: ScoreMeasure): boolean => m.page >= 0 && m.sys >= 0;

const measureKey = (m: ScoreMeasure): string => `${m.n}:${m.tick}`;

/**
 * Identity of the ENGRAVED bar an entry performs. Equal to the array index for
 * a linear score; on an unrolled repeat, several entries share one.
 */
const printedIndexOf = (score: ScoreData, index: number): number => score.measures[index]?.srcIndex ?? index;

/**
 * True when the sorted-by-x0 measures cover [xLo, xHi] without gaps.
 */
const measuresCoverXSpan = (measures: readonly ScoreMeasure[], xLo: number, xHi: number): boolean => {
    if (measures.length === 0 || xHi <= xLo) {
        return false;
    }
    const sorted = [...measures].sort((a, b) => a.x0 - b.x0);
    let coveredTo = xLo;
    for (const m of sorted) {
        if (m.x1 < xLo || m.x0 > xHi) {
            continue;
        }
        if (m.x0 > coveredTo + X_GAP_EPS) {
            return false;
        }
        coveredTo = Math.max(coveredTo, m.x1);
        if (coveredTo >= xHi - X_GAP_EPS) {
            return true;
        }
    }
    return coveredTo >= xHi - X_GAP_EPS;
};

/** Diatonic staff steps of a sounding midi under a key signature (accidental ignored). */
const diatonicStep = (midi: number, keySignature: number): number => {
    const name = midiToName(midi, keySignature);
    const letter = name.charAt(0).toUpperCase();
    const octave = Number.parseInt(name.replace(/^[^0-9-]+/, ''), 10);
    const degree = LETTER_DIATONIC[letter];
    if (degree === undefined || !Number.isFinite(octave)) {
        return Math.round(midi / 2);
    }
    return octave * 7 + degree;
};

/**
 * Diatonic step of the bottom staff line for a clef (MusicXML line counted
 * from the bottom). Adjacent staff lines are a third = 2 diatonic steps apart.
 * Anchors: G4 on line 2 → bottom E4; F3 on line 4 → bottom G2; C4 on line 3 → bottom F3.
 */
const bottomStaffDiatonicStep = (clef: ScoreClef): number => {
    const anchor: Record<ScoreClef['sign'], { midi: number; line: number }> = {
        G: { midi: 67, line: 2 },
        F: { midi: 53, line: 4 },
        C: { midi: 60, line: 3 },
    };
    const { midi, line: defaultLine } = anchor[clef.sign];
    const line = clef.line ?? defaultLine;
    return diatonicStep(midi, 0) - 2 * (line - 1);
};

/**
 * Synthesize a notehead bbox from slot x + staff band + clef. Returns zero
 * bbox when staff geometry is missing (v1 ScoreData path).
 */
const synthesizeBbox = (
    score: ScoreData,
    noteT: number,
    midi: number,
    hand: 0 | 1,
    keySignature: number,
): NormRect => {
    const mi = measureIndexAtTick(score.measures, noteT);
    const measure = score.measures[mi];
    if (!measure || !hasGeometry(measure)) {
        return { ...ZERO_BBOX };
    }
    const system = score.systems[measure.sys];
    // Exact staff only — never fall back to staves[0] (would place LH on RH).
    const staffBand = system?.staves?.[hand];
    if (!staffBand || staffBand.y1 <= staffBand.y0) {
        return { ...ZERO_BBOX };
    }
    const clef = clefAt(score, noteT, hand);
    // 4 interlines between 5 lines; each diatonic step is half an interline.
    const interline = (staffBand.y1 - staffBand.y0) / 4;
    const stepH = interline / 2;
    const h = Math.max(1e-4, interline * 0.85);
    const w = Math.max(1e-4, interline * 1.2);
    const cx = xAtTickInMeasure(measure, noteT);
    const stepsFromBottom = diatonicStep(midi, keySignature) - bottomStaffDiatonicStep(clef);
    const cy = staffBand.y1 - stepsFromBottom * stepH;
    return {
        x: Math.min(1, Math.max(0, cx - w / 2)),
        y: Math.min(1, Math.max(0, cy - h / 2)),
        w,
        h,
    };
};

const clefSignToName = (sign: ScoreClef['sign']): RecognizedRegion['clefs']['upper'] => {
    switch (sign) {
        case 'G':
            return 'treble';
        case 'F':
            return 'bass';
        case 'C':
            return 'alto';
        default: {
            const _exhaustive: never = sign;
            return _exhaustive;
        }
    }
};

/**
 * Build a RecognizedRegion from ScoreData for a fingering marquee, or null when
 * coverage is empty/partial (caller falls through to vision).
 *
 * Coverage is all-or-nothing: every PRINTED bar in the span must be collected
 * with geometry, each hit system's x-span must be contiguous, and a selection
 * that overhangs a system's engraved band fails unless the next/prev score
 * measure was also collected (e.g. on the next system of a multi-system marquee).
 *
 * "Printed bar" rather than "measure" is load-bearing. A marquee is spatial, so
 * over a repeated system it collects every pass of the same engraved bar; the
 * passes are deduplicated to the earliest, and coverage is judged in printed-bar
 * space so an unrolled repeat does not read as a hole.
 */
export const regionFromScoreData = (
    docId: string,
    page: number,
    rect: NormRect,
    score: ScoreData,
): RecognizedRegion | null => {
    if (score.warnings.includes('no_geometry')) {
        return null;
    }

    const hitSysIndexes: number[] = [];
    for (let i = 0; i < score.systems.length; i++) {
        const system = score.systems[i];
        if (system && system.page === page && rectsOverlapY(rect, system.y0, system.y1)) {
            hitSysIndexes.push(i);
        }
    }
    if (hitSysIndexes.length === 0) {
        return null;
    }

    const collectedIdx: number[] = [];
    for (const sysIndex of hitSysIndexes) {
        const inSystemIdx: number[] = [];
        score.measures.forEach((m, i) => {
            if (m.sys === sysIndex && m.page === page && hasGeometry(m) && rectsOverlapX(rect, m.x0, m.x1)) {
                inSystemIdx.push(i);
            }
        });
        if (inSystemIdx.length === 0) {
            return null;
        }
        const inSystem = inSystemIdx.map((i) => score.measures[i]!);
        const sysX0 = Math.min(...inSystem.map((m) => m.x0));
        const sysX1 = Math.max(...inSystem.map((m) => m.x1));
        const xLo = Math.max(rect.x, sysX0);
        const xHi = Math.min(rect.x + rect.w, sysX1);
        if (!measuresCoverXSpan(inSystem, xLo, xHi)) {
            return null;
        }
        collectedIdx.push(...inSystemIdx);
    }

    // One entry per PRINTED bar. A marquee is spatial, so on a repeat it picks
    // up every pass of the same engraved measure; keep the earliest, since the
    // passes are identical by construction and fingering is about the page.
    const byPrinted = new Map<number, number>();
    for (const i of collectedIdx) {
        const printed = printedIndexOf(score, i);
        const prev = byPrinted.get(printed);
        if (prev === undefined || score.measures[i]!.tick < score.measures[prev]!.tick) {
            byPrinted.set(printed, i);
        }
    }
    const collected = [...byPrinted.values()].map((i) => score.measures[i]!);
    const collectedKeys = new Set(collected.map(measureKey));

    // Per-system overhang past the engraved band only fails when the
    // neighbouring score measure lacks geometry (silent hole). A neighbour on
    // the next/prev system with real geometry is fine — stacked piano layouts
    // put that measure below, not to the right.
    for (const sysIndex of hitSysIndexes) {
        const inSystem = collected.filter((m) => m.sys === sysIndex);
        const sysX0 = Math.min(...inSystem.map((m) => m.x0));
        const sysX1 = Math.max(...inSystem.map((m) => m.x1));
        const lastEnd = Math.max(...inSystem.map((m) => m.tick + m.dTicks));
        const firstStart = Math.min(...inSystem.map((m) => m.tick));
        if (rect.x + rect.w > sysX1 + X_GAP_EPS) {
            const next = score.measures.find((m) => m.tick >= lastEnd);
            if (next && !hasGeometry(next)) {
                return null;
            }
        }
        if (rect.x < sysX0 - X_GAP_EPS) {
            const prev = [...score.measures].reverse().find((m) => m.tick + m.dTicks <= firstStart);
            if (prev && !hasGeometry(prev)) {
                return null;
            }
        }
    }

    // Every PRINTED bar between the first and last collected must be present and
    // carry geometry (catches geometry-less holes and measure_geometry_mismatch
    // tails inside the span). Deliberately checked in printed-bar space rather
    // than tick space: once repeats are unrolled, the collected bars' ticks span
    // the intervening second pass, and a tick-space check would reject every
    // marquee on a repeated system — silently dropping the free OMR reading and
    // falling back to the paid vision path.
    const printedSpan = [...byPrinted.keys()].sort((a, b) => a - b);
    const printedLo = printedSpan[0]!;
    const printedHi = printedSpan[printedSpan.length - 1]!;
    const printedPresent = new Set(printedSpan);
    for (let i = 0; i < score.measures.length; i++) {
        const printed = printedIndexOf(score, i);
        if (printed < printedLo || printed > printedHi) {
            continue;
        }
        if (!printedPresent.has(printed) || !hasGeometry(score.measures[i]!)) {
            return null;
        }
    }

    let startTick = Number.POSITIVE_INFINITY;
    let endTick = Number.NEGATIVE_INFINITY;
    // Per-system: include notes whose engraved x falls inside the marquee on
    // that system (avoids half-open tick edges dropping the rightmost notehead,
    // and avoids a later system's wider x pulling earlier-system notes).
    const notesInRange: ScoreData['notes'] = [];
    const seen = new Set<string>();
    for (const sysIndex of hitSysIndexes) {
        const inSystem = collected.filter((m) => m.sys === sysIndex);
        const sorted = [...inSystem].sort((a, b) => a.x0 - b.x0);
        const left = sorted.find((m) => rect.x < m.x1 && rect.x + rect.w > m.x0);
        const right = [...sorted].reverse().find((m) => rect.x < m.x1 && rect.x + rect.w > m.x0);
        if (!left || !right) {
            return null;
        }
        const sysStart = tickAtXInMeasure(left, rect.x);
        const sysEnd = tickAtXInMeasure(right, rect.x + rect.w);
        if (!(sysStart <= sysEnd)) {
            return null;
        }
        startTick = Math.min(startTick, sysStart);
        endTick = Math.max(endTick, sysEnd);
        const xLo = rect.x - X_GAP_EPS;
        const xHi = rect.x + rect.w + X_GAP_EPS;
        for (const n of score.notes) {
            const mi = measureIndexAtTick(score.measures, n.t);
            const measure = score.measures[mi];
            if (!measure || measure.sys !== sysIndex || !collectedKeys.has(measureKey(measure))) {
                continue;
            }
            const nx = xAtTickInMeasure(measure, n.t);
            if (nx < xLo || nx > xHi) {
                continue;
            }
            const staves = score.systems[measure.sys]?.staves;
            if (staves && staves.length > 0) {
                const band = staves[n.h];
                if (!band || !rectsOverlapY(rect, band.y0, band.y1)) {
                    continue;
                }
            }
            const id = `${n.t}:${n.p}:${n.h}`;
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);
            notesInRange.push(n);
        }
    }
    if (notesInRange.length === 0) {
        return null;
    }

    const ticks = [...new Set(notesInRange.map((n) => n.t))].sort((a, b) => a - b);
    const eventOfTick = new Map(ticks.map((t, i) => [t, i]));
    const regionKeySignature = keySigAt(score, startTick);

    const notes: RecognizedNote[] = notesInRange.map((n) => {
        const midi = clampMidi(n.p);
        const hand: 0 | 1 = n.h === HAND_LH ? HAND_LH : HAND_RH;
        const staff: Staff = hand === HAND_LH ? 'lower' : 'upper';
        const noteKey = keySigAt(score, n.t);
        return {
            id: crypto.randomUUID(),
            midi,
            name: midiToName(midi, noteKey),
            staff,
            bbox: synthesizeBbox(score, n.t, midi, hand, noteKey),
            eventIndex: eventOfTick.get(n.t) ?? 0,
            annotatedFinger: null,
            fingerSource: null,
            confidence: 'high',
        };
    });

    return {
        docId,
        page,
        rect,
        keySignature: regionKeySignature,
        clefs: {
            upper: clefSignToName(clefAt(score, startTick, HAND_RH).sign),
            lower: clefSignToName(clefAt(score, startTick, HAND_LH).sign),
        },
        notes,
        handOf: { upper: 'R', lower: 'L' },
        source: 'omr',
    };
};
