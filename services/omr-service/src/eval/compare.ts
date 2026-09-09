import type { ScoreData, ScoreMeasure, ScoreNote } from '../scoreData.js';
import { DEFAULT_VELOCITY, TICKS_PER_QUARTER } from '../scoreData.js';
import type { CorpusEntry, CorpusMovement } from './manifest.js';
import { quantizeOnset, refBarsOf, type RefNote } from './midiRef.js';
import type { MovementSlice, SegmentResult } from './segment.js';

export type AlignKind = 'match' | 'ref_only' | 'omr_only' | 'merge2';

export interface BarNote {
    onsetQ: number;
    pitch: number;
    hand: 0 | 1;
}

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
    refCount: number;
    omrCount: number;
}

export interface MovementMetrics {
    name: string;
    refBars: number;
    omrPrintedBars: number;
    omrPerformedBars: number;
    refNotes: number;
    omrNotes: number;
    pitchMatch: number;
    exact: number;
    missing: number;
    extra: number;
    octave: number;
    semitone: number;
    handErr: number;
    barsImperfect: number;
    refOnly: number;
    omrOnly: number;
    merge2: number;
    barsAtCorrectLength: number;
    melodySurvival: number;
    melodyTotal: number;
    melodyFound: number;
    barsUnderWrongKey: number;
    tempoInRange: boolean;
    tempoBpm: number | null;
    performedBarsMatch: boolean | null;
    /** Distinct note velocities in the slice (1 ⇒ no hairpin interpolation). */
    velocityDistinct: number;
}

export interface EvalTotals {
    refNotes: number;
    omrNotes: number;
    pitchMatch: number;
    exact: number;
    missing: number;
    extra: number;
    octave: number;
    semitone: number;
    velocityDistinct: number;
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
    notes.map((n) => ({ onsetQ: n.onsetQ, pitch: n.pitch, hand: n.hand }));

const omrPrintedBars = (
    measures: readonly ScoreMeasure[],
    notes: readonly ScoreNote[],
    lo: number,
    hi: number,
    barTicks: number,
): Array<{ measure: ScoreMeasure; notes: BarNote[]; expectedTicks: number }> => {
    const inRange = measures.filter((m) => m.tick >= lo && m.tick < hi);
    const seen = new Set<number>();
    const out: Array<{ measure: ScoreMeasure; notes: BarNote[]; expectedTicks: number }> = [];
    for (const measure of inRange) {
        const key = measure.srcIndex ?? measure.n;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const members = notes.filter((n) => n.t >= measure.tick && n.t < measure.tick + measure.dTicks);
        out.push({
            measure,
            expectedTicks: barTicks,
            notes: members.map((n) => ({
                onsetQ: quantizeOnset((n.t - measure.tick) / TICKS_PER_QUARTER),
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
    const ro = onsetPairs(refNotes);
    const oo = onsetPairs(omrNotes);
    let exact = 0;
    for (const [key, n] of ro) {
        exact += Math.min(n, oo.get(key) ?? 0);
    }
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
        refCount: refNotes.length,
        omrCount: omrNotes.length,
    };
};

const barTicksOf = (movement: CorpusMovement): number =>
    Math.round(movement.meter.num * ((TICKS_PER_QUARTER * 4) / movement.meter.den));

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
    const omrBars = omrPrintedBars(score.measures, score.notes, lo, hi, expected);
    const omrLists = omrBars.map((b) => b.notes);
    const path = alignBars(refLists, omrLists);

    const bars: BarReport[] = [];
    let pitchMatched = 0;
    let exact = 0;
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

    for (const bar of omrBars) {
        if (bar.measure.dTicks === expected) {
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
    for (const bar of omrBars) {
        if (fifthsAt(score, bar.measure.tick) !== movement.expectedFifths) {
            barsUnderWrongKey += 1;
        }
    }

    const performed = score.measures.filter((m) => m.tick >= lo && m.tick < hi).length;
    const tempoBpm = tempoAt(score, lo);
    const tempoInRange =
        tempoBpm !== null && tempoBpm >= movement.expectedTempo.min && tempoBpm <= movement.expectedTempo.max;
    const velocities = new Set(
        score.notes.filter((n) => n.t >= lo && n.t < hi).map((n) => n.v ?? DEFAULT_VELOCITY),
    );

    const metrics: MovementMetrics = {
        name: movement.name,
        refBars: refKeyed.length,
        omrPrintedBars: omrBars.length,
        omrPerformedBars: performed,
        refNotes: refNoteCount,
        omrNotes: omrNoteCount,
        pitchMatch: refNoteCount === 0 ? 100 : (100 * pitchMatched) / refNoteCount,
        exact: refNoteCount === 0 ? 100 : (100 * exact) / refNoteCount,
        missing,
        extra,
        octave,
        semitone,
        handErr,
        barsImperfect,
        refOnly,
        omrOnly,
        merge2,
        barsAtCorrectLength,
        melodySurvival: melody.length === 0 ? 100 : (100 * melodyFound) / melody.length,
        melodyTotal: melody.length,
        melodyFound,
        barsUnderWrongKey,
        tempoInRange,
        tempoBpm,
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
        },
        bars,
    };
    return { ...draft, composite: compositeScore(draft) };
};
