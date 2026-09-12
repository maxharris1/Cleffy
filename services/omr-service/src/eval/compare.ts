import type { ScoreData, ScoreMeasure, ScoreNote } from '../scoreData.js';
import { DEFAULT_VELOCITY, TICKS_PER_QUARTER } from '../scoreData.js';
import type { CorpusEntry, CorpusMovement } from './manifest.js';
import { quantizeDur, quantizeOnset, refBarsOf, type RefNote } from './midiRef.js';
import type { MovementSlice, SegmentResult } from './segment.js';

export type AlignKind = 'match' | 'ref_only' | 'omr_only' | 'merge2';

export interface BarNote {
    onsetQ: number;
    pitch: number;
    /** Quantized note length in quarters. See `quantizeDur`. */
    durQ: number;
    hand: 0 | 1;
}

/**
 * Warning codes the parser emits that describe a printed-grid failure rather
 * than a cosmetic degradation. Matched by exact code, never by substring of the
 * joined summary line.
 */
export const UNDERFULL_WARNING = 'measure_underfull';
export const OVERFULL_WARNING = 'measure_overfull';
export const TEMPO_DEFAULTED_WARNING = 'tempo_defaulted';
export const REPEATS_IGNORED_WARNING = 'repeats_ignored';
export const JUMPS_IGNORED_WARNING = 'jumps_ignored';

export interface BarReport {
    kind: AlignKind;
    refBars: number[];
    omrNs: number[];
    sim: number;
    dTicks: number[];
    missing: number[];
    extra: number[];
    octave: number;
    semitone: number;
    handErr: number;
    pitchMatched: number;
    exact: number;
    /** Same pitch, same quantized onset AND same quantized length. */
    onGrid: number;
    refCount: number;
    omrCount: number;
}

export interface MovementMetrics {
    name: string;
    refBars: number;
    omrPrintedBars: number;
    omrPerformedBars: number;
    /**
     * Bars actually aligned against the reference: the performed list when the
     * reference MIDI unfolds repeats, the srcIndex-deduped printed list
     * otherwise. `scoredBars === refBars` is the alignment-integrity check.
     */
    scoredBars: number;
    refNotes: number;
    omrNotes: number;
    pitchMatch: number;
    exact: number;
    /**
     * Share of reference notes reproduced at the same pitch, the same quantized
     * onset, and a length consistent with the printed value once the parser's
     * articulation gating is allowed for. The headline play-along rate: "the note
     * is there, it starts when the page says, and it lasts as long".
     */
    onGrid: number;
    missing: number;
    extra: number;
    octave: number;
    semitone: number;
    handErr: number;
    barsImperfect: number;
    refOnly: number;
    omrOnly: number;
    merge2: number;
    /**
     * Longest run of consecutive reference bars the alignment could not place.
     * One unplaced bar is a bad bar; several in a row is a skipped passage,
     * which is the failure a per-note rate dilutes away.
     */
    maxRefOnlyRun: number;
    barsAtCorrectLength: number;
    /** Printed bars whose `dTicks` disagrees with the pickup-aware expectation. */
    barsWrongLength: number;
    /** `omrPrintedBars` equals the corpus `printedBars` pin. */
    printedBarsMatch: boolean;
    /**
     * The reference MIDI produced the bar count its pin claims — `performedBars`
     * when the reference unfolds repeats, `printedBars` otherwise. This grades
     * the corpus, not the OMR: when it is false the movement's rates are being
     * measured against a mis-pinned oracle and mean nothing.
     */
    refBarsMatch: boolean;
    /**
     * Extra notes left after subtracting the corpus `expectedExtraNotes`
     * allowance for ornaments the reference MIDI does not realize. This, not
     * `extra`, is the count the gate judges.
     */
    extraUnexplained: number;
    /** Fermata clock-stops inside the movement slice. */
    holds: number;
    /** `holds` is at most the corpus `expectedHolds` pin — no invented pauses. */
    holdsOk: boolean;
    melodySurvival: number;
    melodyTotal: number;
    melodyFound: number;
    barsUnderWrongKey: number;
    tempoInRange: boolean;
    tempoBpm: number | null;
    /**
     * Opening BPM the way playback reads it: a `metronome` or `word` tempo point
     * at the movement start, with no `defaultBpm` fallback and `ramp` points
     * ignored. `tempoBpm` above seeds from `defaultBpm`, which playback treats
     * as a meter guess rather than a printed opening — so the two disagree
     * exactly when the page never printed a tempo. Reported, not gated: a piece
     * played at the wrong speed is still on pitch and on the printed grid.
     */
    printedTempoBpm: number | null;
    printedTempoInRange: boolean;
    performedBarsMatch: boolean | null;
    /** Distinct note velocities in the slice (1 ⇒ no hairpin interpolation). */
    velocityDistinct: number;
}

export interface EvalTotals {
    refNotes: number;
    omrNotes: number;
    pitchMatch: number;
    exact: number;
    onGrid: number;
    missing: number;
    extra: number;
    octave: number;
    semitone: number;
    velocityDistinct: number;
}

/** Parser degradations that describe the printed grid, as exact-code booleans. */
export interface StructureFlags {
    measureUnderfull: boolean;
    measureOverfull: boolean;
    tempoDefaulted: boolean;
    repeatsIgnored: boolean;
    jumpsIgnored: boolean;
}

export interface EvalResult {
    slug: string;
    title: string;
    movements: MovementMetrics[];
    overall: EvalTotals;
    structure: {
        movementCountOk: boolean;
        metersOk: boolean;
        warnings: string[];
        flags: StructureFlags;
    };
    composite: number;
    bars: Record<string, BarReport[]>;
}

type PathStep = { kind: AlignKind; ri: number[]; oj: number[] };

const INF = 1e9;

/**
 * A zero-similarity 1:1 match costs `1 - 0 = 1`. Skip must be strictly dearer
 * or DTW prefers leaving a bar unpaired over aligning two dissimilar bars.
 * merge2 pays that skip on top of the combined mismatch so a mediocre two-bar
 * swallow is not cheaper than two honest matches.
 */
export const ALIGN_SKIP_COST = 1.1;
export const ALIGN_MERGE2_EXTRA = ALIGN_SKIP_COST;

const countPitches = (notes: readonly BarNote[]): Map<number, number> => {
    const map = new Map<number, number>();
    for (const note of notes) {
        map.set(note.pitch, (map.get(note.pitch) ?? 0) + 1);
    }
    return map;
};

const intersectCount = (a: Map<number, number>, b: Map<number, number>): number => {
    let n = 0;
    for (const [pitch, ca] of a) {
        n += Math.min(ca, b.get(pitch) ?? 0);
    }
    return n;
};

export const pitchSim = (a: readonly BarNote[], b: readonly BarNote[]): number => {
    const ca = countPitches(a);
    const cb = countPitches(b);
    const inter = intersectCount(ca, cb);
    const tot = a.length + b.length;
    return tot === 0 ? 1 : (2 * inter) / tot;
};

const classify = (
    missingIn: number[],
    extraIn: number[],
): { octave: number; semitone: number; missing: number[]; extra: number[] } => {
    const missing = [...missingIn];
    const extra = [...extraIn];
    const used = new Set<number>();
    let octave = 0;
    let semitone = 0;
    for (let mi = missing.length - 1; mi >= 0; mi--) {
        const mp = missing[mi];
        if (mp === undefined) {
            continue;
        }
        const ei = extra.findIndex((ep, k) => !used.has(k) && Math.abs(ep - mp) === 12);
        if (ei >= 0) {
            used.add(ei);
            missing.splice(mi, 1);
            octave += 1;
        }
    }
    for (let mi = missing.length - 1; mi >= 0; mi--) {
        const mp = missing[mi];
        if (mp === undefined) {
            continue;
        }
        const ei = extra.findIndex((ep, k) => !used.has(k) && Math.abs(ep - mp) === 1);
        if (ei >= 0) {
            used.add(ei);
            missing.splice(mi, 1);
            semitone += 1;
        }
    }
    return { octave, semitone, missing, extra: extra.filter((_, k) => !used.has(k)) };
};

const handPairs = (notes: readonly BarNote[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const note of notes) {
        const key = `${note.pitch}:${note.hand}`;
        map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
};

const onsetPairs = (notes: readonly BarNote[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const note of notes) {
        const key = `${note.onsetQ}:${note.pitch}`;
        map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
};

const bagOverlap = (a: Map<string, number>, b: Map<string, number>): number => {
    let n = 0;
    for (const [key, count] of a) {
        n += Math.min(count, b.get(key) ?? 0);
    }
    return n;
};

/**
 * Articulation gates the parser can apply to a notated length (`musicxml.ts`:
 * staccatissimo, staccato, portato, plain, legato). `ScoreNote.d` is a SOUNDING
 * length — notated × gate, floored at `MIN_SOUNDING_TICKS` — while the reference
 * MIDI carries the notated length, because Mutopia does not run LilyPond's
 * `articulate.ly`. Comparing the two numbers directly reports every correctly
 * read note as a duration error.
 */
const ARTICULATION_GATES = [1, 0.9, 0.7, 0.5, 0.25] as const;

/**
 * True when an OMR sounding length is a legal articulation gating of the printed
 * length. The floor at `MIN_SOUNDING_TICKS` only ever lengthens a gated note
 * back toward its notated value, and gate 1 covers that, so nothing correctly
 * read is rejected.
 *
 * Known blind spot: a gate and a note value can collide. A printed quarter read
 * as a slurred eighth sounds for the same ticks as a staccato quarter, so this
 * check cannot separate them. Onsets can — a halved note value moves every later
 * attack in the bar, which `exact` already measures at 1/12 of a quarter — so
 * the pair of metrics covers what neither does alone. An over-held note has no
 * such escape: no gate exceeds 1, so a tied blob that swallows the next attack
 * always fails here.
 */
const lengthConsistent = (refDurQ: number, omrDurQ: number): boolean =>
    ARTICULATION_GATES.some((gate) => quantizeDur(refDurQ * gate) === omrDurQ);

/**
 * Reference notes that pair with an OMR note on pitch AND onset AND whose length
 * is consistent with the printed value. Greedy over a per-(onset, pitch) bucket:
 * each OMR note is consumed once, so two reference notes cannot both claim it.
 */
const onGridOverlap = (ref: readonly BarNote[], omr: readonly BarNote[]): number => {
    const buckets = new Map<string, number[]>();
    for (const note of omr) {
        const key = `${note.onsetQ}:${note.pitch}`;
        const list = buckets.get(key) ?? [];
        list.push(note.durQ);
        buckets.set(key, list);
    }
    let matched = 0;
    for (const note of ref) {
        const list = buckets.get(`${note.onsetQ}:${note.pitch}`);
        if (list === undefined) {
            continue;
        }
        const at = list.findIndex((durQ) => lengthConsistent(note.durQ, durQ));
        if (at >= 0) {
            list.splice(at, 1);
            matched += 1;
        }
    }
    return matched;
};

const alignBars = (ref: BarNote[][], omr: BarNote[][]): PathStep[] => {
    const n = ref.length;
    const m = omr.length;
    const D: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(INF));
    const prev: Array<Array<PathStep | null>> = Array.from({ length: n + 1 }, () =>
        Array<PathStep | null>(m + 1).fill(null),
    );
    const origin: PathStep = { kind: 'match', ri: [], oj: [] };
    const d0 = D[0];
    if (d0) {
        d0[0] = 0;
    }
    const set = (i: number, j: number, cost: number, step: PathStep): void => {
        const row = D[i];
        const prow = prev[i];
        if (!row || !prow) {
            return;
        }
        const cur = row[j] ?? INF;
        if (cost < cur) {
            row[j] = cost;
            prow[j] = step;
        }
    };
    for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= m; j++) {
            const here = D[i]?.[j];
            if (here === undefined || here >= INF) {
                continue;
            }
            if (i < n && j < m) {
                const r = ref[i];
                const o = omr[j];
                if (r && o) {
                    set(i + 1, j + 1, here + (1 - pitchSim(r, o)), { kind: 'match', ri: [i], oj: [j] });
                }
            }
            if (i < n) {
                set(i + 1, j, here + ALIGN_SKIP_COST, { kind: 'ref_only', ri: [i], oj: [] });
            }
            if (j < m) {
                set(i, j + 1, here + ALIGN_SKIP_COST, { kind: 'omr_only', ri: [], oj: [j] });
            }
            if (i + 1 < n && j < m) {
                const a = ref[i];
                const b = ref[i + 1];
                const o = omr[j];
                if (a && b && o) {
                    set(i + 2, j + 1, here + (1 - pitchSim([...a, ...b], o)) + ALIGN_MERGE2_EXTRA, {
                        kind: 'merge2',
                        ri: [i, i + 1],
                        oj: [j],
                    });
                }
            }
        }
    }
    const path: PathStep[] = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        const step = prev[i]?.[j] ?? origin;
        path.push(step);
        i -= step.ri.length;
        j -= step.oj.length;
        if (step === origin) {
            break;
        }
    }
    return path.reverse();
};

const asBarNotes = (notes: readonly RefNote[]): BarNote[] =>
    notes.map((n) => ({ onsetQ: n.onsetQ, durQ: quantizeDur(n.durQ), pitch: n.pitch, hand: n.hand }));

interface OmrBar {
    measure: ScoreMeasure;
    notes: BarNote[];
    expectedTicks: number;
}

/**
 * OMR bars inside a movement slice.
 *
 * `dedupe` collapses the repeat unroll by `srcIndex` down to the engraved page,
 * which is what a printed-once reference MIDI must be compared against. A
 * reference that unfolds its own repeats wants the performed list instead, so
 * the two sequences describe the same performance.
 *
 * `expectedTicks` is pickup-aware: the anacrusis is legitimately short, and the
 * parser deliberately leaves pickups at content length. Measuring it against a
 * full bar would red-X every pickup piece in the corpus.
 */
const omrBarList = (
    measures: readonly ScoreMeasure[],
    notes: readonly ScoreNote[],
    lo: number,
    hi: number,
    barTicks: number,
    pickupQuarters: number,
    dedupe: boolean,
): OmrBar[] => {
    const inRange = measures.filter((m) => m.tick >= lo && m.tick < hi);
    const seen = new Set<number>();
    const out: OmrBar[] = [];
    const pickupTicks = Math.round(pickupQuarters * TICKS_PER_QUARTER);
    for (const measure of inRange) {
        const key = measure.srcIndex ?? measure.n;
        if (dedupe) {
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
        }
        const isPickup = out.length === 0 && pickupTicks > 0;
        // `place()` in midiRef puts anacrusis notes at the END of a notional full
        // bar, so the OMR pickup has to be right-aligned the same way or not one
        // pickup note can ever pair on onset.
        const shift = isPickup ? barTicks - pickupTicks : 0;
        const members = notes.filter((n) => n.t >= measure.tick && n.t < measure.tick + measure.dTicks);
        out.push({
            measure,
            expectedTicks: isPickup ? pickupTicks : barTicks,
            notes: members.map((n) => ({
                onsetQ: quantizeOnset((n.t - measure.tick + shift) / TICKS_PER_QUARTER),
                durQ: quantizeDur(n.d / TICKS_PER_QUARTER),
                pitch: n.p,
                hand: n.h,
            })),
        });
    }
    return out;
};

const fifthsAt = (score: ScoreData, tick: number): number => {
    let fifths = 0;
    for (const sig of score.keySignatures ?? []) {
        if (sig.tick > tick) {
            break;
        }
        fifths = sig.fifths;
    }
    return fifths;
};

const tempoAt = (score: ScoreData, tick: number): number | null => {
    let bpm = score.defaultBpm;
    for (const tempo of score.tempos ?? []) {
        if (tempo.tick > tick) {
            break;
        }
        bpm = tempo.bpm;
    }
    return bpm;
};

/**
 * The opening tempo playback will actually use: the last engraved `metronome` or
 * `word` point at or before the movement start. No `defaultBpm` seed — playback
 * treats that as a practice-tempo guess, not a printed mark — and `ramp` points
 * are skipped because a discretized rit. is inferred feel, not page truth.
 */
const printedTempoAt = (score: ScoreData, tick: number): number | null => {
    let bpm: number | null = null;
    for (const tempo of score.tempos ?? []) {
        if (tempo.tick > tick) {
            break;
        }
        if (tempo.src === 'metronome' || tempo.src === 'word') {
            bpm = tempo.bpm;
        }
    }
    return bpm;
};

const longestRun = (flags: readonly boolean[]): number => {
    let best = 0;
    let run = 0;
    for (const flag of flags) {
        run = flag ? run + 1 : 0;
        best = Math.max(best, run);
    }
    return best;
};

const describeStep = (
    step: PathStep,
    refKeyed: Array<[number, BarNote[]]>,
    omrBars: Array<{ measure: ScoreMeasure; notes: BarNote[] }>,
): BarReport => {
    const refNotes = step.ri.flatMap((i) => refKeyed[i]?.[1] ?? []);
    const omrNotes = step.oj.flatMap((j) => omrBars[j]?.notes ?? []);
    const cr = countPitches(refNotes);
    const co = countPitches(omrNotes);
    const missingAll: number[] = [];
    const extraAll: number[] = [];
    const pitches = new Set([...cr.keys(), ...co.keys()]);
    for (const pitch of pitches) {
        const d = (cr.get(pitch) ?? 0) - (co.get(pitch) ?? 0);
        if (d > 0) {
            for (let i = 0; i < d; i++) {
                missingAll.push(pitch);
            }
        } else if (d < 0) {
            for (let i = 0; i < -d; i++) {
                extraAll.push(pitch);
            }
        }
    }
    const { octave, semitone, missing, extra } = classify(missingAll, extraAll);
    const inter = intersectCount(cr, co);
    const rh = handPairs(refNotes);
    const oh = handPairs(omrNotes);
    let handShared = 0;
    for (const [key, n] of rh) {
        handShared += Math.min(n, oh.get(key) ?? 0);
    }
    const exact = bagOverlap(onsetPairs(refNotes), onsetPairs(omrNotes));
    const onGrid = onGridOverlap(refNotes, omrNotes);
    return {
        kind: step.kind,
        refBars: step.ri.map((i) => refKeyed[i]?.[0] ?? -1),
        omrNs: step.oj.map((j) => omrBars[j]?.measure.n ?? -1),
        sim: pitchSim(refNotes, omrNotes),
        dTicks: step.oj.map((j) => omrBars[j]?.measure.dTicks ?? 0),
        missing,
        extra,
        octave,
        semitone,
        handErr: inter - handShared,
        pitchMatched: inter,
        exact,
        onGrid,
        refCount: refNotes.length,
        omrCount: omrNotes.length,
    };
};

const barTicksOf = (movement: CorpusMovement): number =>
    Math.round(movement.meter.num * ((TICKS_PER_QUARTER * 4) / movement.meter.den));

/** Bars the reference MIDI should contain, given whether it unfolds repeats. */
const expectedRefBars = (movement: CorpusMovement): number =>
    movement.repeatsUnfoldedInMidi ? movement.performedBars ?? movement.printedBars : movement.printedBars;

const scoreMovement = (
    refNotes: readonly RefNote[],
    score: ScoreData,
    slice: MovementSlice,
): { metrics: MovementMetrics; bars: BarReport[] } => {
    const { movement, lo, hi } = slice;
    const refMap = refBarsOf(refNotes);
    const refKeyed = [...refMap.entries()].sort((a, b) => a[0] - b[0]);
    const refLists = refKeyed.map(([, notes]) => asBarNotes(notes));
    const expected = barTicksOf(movement);
    const printedBars = omrBarList(
        score.measures,
        score.notes,
        lo,
        hi,
        expected,
        movement.pickupQuarters,
        true,
    );
    // A reference that unfolds its own repeats describes the performance, so the
    // performed measure list is the comparable sequence. A printed-once
    // reference wants the engraved page.
    const omrBars = movement.repeatsUnfoldedInMidi
        ? omrBarList(score.measures, score.notes, lo, hi, expected, movement.pickupQuarters, false)
        : printedBars;
    const omrLists = omrBars.map((b) => b.notes);
    const path = alignBars(refLists, omrLists);

    const bars: BarReport[] = [];
    let pitchMatched = 0;
    let exact = 0;
    let onGrid = 0;
    let missing = 0;
    let extra = 0;
    let octave = 0;
    let semitone = 0;
    let handErr = 0;
    let barsImperfect = 0;
    let refOnly = 0;
    let omrOnly = 0;
    let merge2 = 0;
    let barsAtCorrectLength = 0;
    let refNoteCount = 0;
    let omrNoteCount = 0;

    for (const step of path) {
        const report = describeStep(step, refKeyed, omrBars);
        bars.push(report);
        pitchMatched += report.pitchMatched;
        exact += report.exact;
        onGrid += report.onGrid;
        missing += report.missing.length;
        extra += report.extra.length;
        octave += report.octave;
        semitone += report.semitone;
        handErr += report.handErr;
        refNoteCount += report.refCount;
        omrNoteCount += report.omrCount;
        if (report.sim < 1) {
            barsImperfect += 1;
        }
        switch (step.kind) {
            case 'match':
                break;
            case 'ref_only':
                refOnly += 1;
                break;
            case 'omr_only':
                omrOnly += 1;
                break;
            case 'merge2':
                merge2 += 1;
                break;
            default: {
                const exhaustive: never = step.kind;
                throw new Error(`unhandled align kind ${exhaustive}`);
            }
        }
    }

    // Bar length is a property of the engraved page, so it is always counted on
    // the deduped printed list — which also keeps the
    // `barsAtCorrectLength <= omrPrintedBars` record invariant true for an
    // unfolded-reference movement, where the scored list is longer.
    for (const bar of printedBars) {
        if (bar.measure.dTicks === bar.expectedTicks) {
            barsAtCorrectLength += 1;
        }
    }

    const melody = refNotes.filter((n) => n.hand === 0 && n.durQ >= 0.75);
    let melodyFound = 0;
    const omrByN = new Map(omrBars.map((b) => [b.measure.n, b]));
    for (const note of melody) {
        const aligned = bars.find((b) => b.refBars.includes(note.bar));
        const omrN = aligned?.omrNs[0];
        const bucket = omrN === undefined ? undefined : omrByN.get(omrN);
        if (bucket?.notes.some((n) => n.pitch === note.pitch)) {
            melodyFound += 1;
        }
    }

    let barsUnderWrongKey = 0;
    for (const bar of printedBars) {
        if (fifthsAt(score, bar.measure.tick) !== movement.expectedFifths) {
            barsUnderWrongKey += 1;
        }
    }

    const performed = score.measures.filter((m) => m.tick >= lo && m.tick < hi).length;
    const tempoBpm = tempoAt(score, lo);
    const tempoInRange =
        tempoBpm !== null && tempoBpm >= movement.expectedTempo.min && tempoBpm <= movement.expectedTempo.max;
    const printedTempoBpm = printedTempoAt(score, lo);
    const velocities = new Set(
        score.notes.filter((n) => n.t >= lo && n.t < hi).map((n) => n.v ?? DEFAULT_VELOCITY),
    );
    const holds = (score.holds ?? []).filter((h) => h.tick >= lo && h.tick < hi).length;

    const metrics: MovementMetrics = {
        name: movement.name,
        refBars: refKeyed.length,
        omrPrintedBars: printedBars.length,
        omrPerformedBars: performed,
        scoredBars: omrBars.length,
        refNotes: refNoteCount,
        omrNotes: omrNoteCount,
        pitchMatch: refNoteCount === 0 ? 100 : (100 * pitchMatched) / refNoteCount,
        exact: refNoteCount === 0 ? 100 : (100 * exact) / refNoteCount,
        onGrid: refNoteCount === 0 ? 100 : (100 * onGrid) / refNoteCount,
        missing,
        extra,
        octave,
        semitone,
        handErr,
        barsImperfect,
        refOnly,
        omrOnly,
        merge2,
        maxRefOnlyRun: longestRun(path.map((step) => step.kind === 'ref_only')),
        barsAtCorrectLength,
        barsWrongLength: printedBars.length - barsAtCorrectLength,
        printedBarsMatch: printedBars.length === movement.printedBars,
        refBarsMatch: refKeyed.length === expectedRefBars(movement),
        extraUnexplained: Math.max(0, extra - movement.expectedExtraNotes),
        holds,
        holdsOk: holds <= movement.expectedHolds,
        melodySurvival: melody.length === 0 ? 100 : (100 * melodyFound) / melody.length,
        melodyTotal: melody.length,
        melodyFound,
        barsUnderWrongKey,
        tempoInRange,
        tempoBpm,
        printedTempoBpm,
        printedTempoInRange:
            printedTempoBpm !== null &&
            printedTempoBpm >= movement.expectedTempo.min &&
            printedTempoBpm <= movement.expectedTempo.max,
        performedBarsMatch: movement.performedBars === undefined ? null : performed === movement.performedBars,
        velocityDistinct: velocities.size,
    };
    return { metrics, bars };
};

/**
 * Composite 0–100. Weights: pitch 40, exact onset 20, missing 15, structure 15, tempo 10.
 * Missing is inverted (fewer missing notes → higher). Structure is the mean of
 * movement-count, meters, per-movement performed-bar match (when declared), and
 * key stability (share of printed bars under the expected fifths).
 */
export const compositeScore = (result: Omit<EvalResult, 'composite'>): number => {
    const pitch = result.overall.pitchMatch;
    const exact = result.overall.exact;
    const missing =
        result.overall.refNotes === 0 ? 100 : 100 * (1 - result.overall.missing / result.overall.refNotes);
    const structParts: number[] = [
        result.structure.movementCountOk ? 100 : 0,
        result.structure.metersOk ? 100 : 0,
    ];
    for (const mov of result.movements) {
        if (mov.performedBarsMatch !== null) {
            structParts.push(mov.performedBarsMatch ? 100 : 0);
        }
        const printed = mov.omrPrintedBars;
        structParts.push(printed === 0 ? 0 : 100 * (1 - mov.barsUnderWrongKey / printed));
    }
    const structure = structParts.reduce((a, b) => a + b, 0) / Math.max(1, structParts.length);
    const tempo =
        result.movements.length === 0
            ? 0
            : (100 * result.movements.filter((m) => m.tempoInRange).length) / result.movements.length;
    return 0.4 * pitch + 0.2 * exact + 0.15 * Math.max(0, missing) + 0.15 * structure + 0.1 * tempo;
};

export const compareScore = (
    score: ScoreData,
    entry: CorpusEntry,
    refByMovement: RefNote[][],
    segmented: SegmentResult,
): EvalResult => {
    const movements: MovementMetrics[] = [];
    const bars: Record<string, BarReport[]> = {};
    let refNotes = 0;
    let omrNotes = 0;
    let pitchMatched = 0;
    let exact = 0;
    let onGrid = 0;
    let missing = 0;
    let extra = 0;
    let octave = 0;
    let semitone = 0;
    const velocityDistinct = new Set<number>();

    for (const slice of segmented.slices) {
        const ref = refByMovement[slice.index] ?? [];
        const { metrics, bars: reports } = scoreMovement(ref, score, slice);
        movements.push(metrics);
        bars[metrics.name] = reports;
        const matched = (metrics.pitchMatch / 100) * metrics.refNotes;
        const exactN = (metrics.exact / 100) * metrics.refNotes;
        refNotes += metrics.refNotes;
        omrNotes += metrics.omrNotes;
        pitchMatched += matched;
        exact += exactN;
        onGrid += (metrics.onGrid / 100) * metrics.refNotes;
        missing += metrics.missing;
        extra += metrics.extra;
        octave += metrics.octave;
        semitone += metrics.semitone;
        for (const note of score.notes) {
            if (note.t >= slice.lo && note.t < slice.hi) {
                velocityDistinct.add(note.v ?? DEFAULT_VELOCITY);
            }
        }
    }

    const draft: Omit<EvalResult, 'composite'> = {
        slug: entry.slug,
        title: entry.title,
        movements,
        overall: {
            refNotes,
            omrNotes,
            pitchMatch: refNotes === 0 ? 100 : (100 * pitchMatched) / refNotes,
            exact: refNotes === 0 ? 100 : (100 * exact) / refNotes,
            onGrid: refNotes === 0 ? 100 : (100 * onGrid) / refNotes,
            missing,
            extra,
            octave,
            semitone,
            velocityDistinct: velocityDistinct.size,
        },
        structure: {
            movementCountOk: segmented.movementCountOk,
            metersOk: segmented.metersOk,
            warnings: [...score.warnings],
            flags: {
                measureUnderfull: score.warnings.includes(UNDERFULL_WARNING),
                measureOverfull: score.warnings.includes(OVERFULL_WARNING),
                tempoDefaulted: score.warnings.includes(TEMPO_DEFAULTED_WARNING),
                repeatsIgnored: score.warnings.includes(REPEATS_IGNORED_WARNING),
                jumpsIgnored: score.warnings.includes(JUMPS_IGNORED_WARNING),
            },
        },
        bars,
    };
    return { ...draft, composite: compositeScore(draft) };
};
