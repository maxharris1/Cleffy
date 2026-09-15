import { fifthsAt, pitchSim, type BarNote } from '../eval/compare.js';
import type { CorpusEntry, CorpusMovement } from '../eval/manifest.js';
import { notesFromMidi, parseSmfForTest, place, quantizeOnset, refBarsOf } from '../eval/midiRef.js';
import { SCORE_DATA_VERSION, TICKS_PER_QUARTER, type ScoreData } from '../scoreData.js';
import type { WorkKey } from './types.js';

export const OPENING_BARS = 8;

/** Onset residual at or above this is performance MIDI (1/24 quarter). */
export const PERFORMANCE_RESIDUAL_LIMIT = 1 / 24;

export interface Meter {
    num: number;
    den: number;
}

export interface PdfSignals {
    meter: Meter;
    fifths: number;
    printedBars: number;
    pickupQuarters: number;
    opening: BarNote[][];
    workKey: WorkKey;
    pageCount: number;
}

export interface MatchCandidateInput {
    source: 'mutopia' | 'imslp' | 'user' | 'asap_eval';
    format: 'mxl' | 'xml' | 'ly' | 'mid' | 'mscz' | 'user-xml';
    url: string;
    sha256?: string;
    workKey: WorkKey;
    meter: Meter;
    fifths: number;
    barCount: number;
    pickupQuarters: number;
    opening: BarNote[][];
    arrangement: boolean;
    midi?: Buffer;
}

const beatsOf = (meter: Meter): number => (meter.num * 4) / meter.den;

export const barIndexOfTick = (tick: number, tpq: number, meter: Meter, pickupQuarters: number): number =>
    place(tick, tpq, beatsOf(meter), pickupQuarters, new Map()).bar;

const asBarNote = (n: { onsetQ: number; pitch: number; durQ: number; hand: 0 | 1 }): BarNote => ({
    onsetQ: n.onsetQ,
    pitch: n.pitch,
    durQ: n.durQ,
    hand: n.hand,
});

export const openingFromNotes = (notes: readonly { bar: number; onsetQ: number; pitch: number; durQ: number; hand: 0 | 1 }[]): BarNote[][] => {
    const bars = refBarsOf(notes);
    const ids = [...bars.keys()].sort((a, b) => a - b).slice(0, OPENING_BARS);
    return ids.map((id) => (bars.get(id) ?? []).map(asBarNote));
};

export const printedBarCountFromTicks = (
    ticks: readonly number[],
    tpq: number,
    meter: Meter,
    pickupQuarters: number,
): number => {
    if (ticks.length === 0) {
        return 0;
    }
    const bars = ticks.map((tick) => barIndexOfTick(tick, tpq, meter, pickupQuarters));
    return Math.max(...bars) - Math.min(...bars) + 1;
};

export const isPerformanceMidi = (buf: Buffer): boolean => {
    const parsed = parseSmfForTest(buf);
    if (parsed.notes.length === 0) {
        return false;
    }
    const residuals = parsed.notes.map((n) => {
        const q = n.tick / parsed.tpq;
        return Math.abs(q - quantizeOnset(q));
    });
    residuals.sort((a, b) => a - b);
    const mid = residuals[Math.floor(residuals.length / 2)] ?? 0;
    // Spec says median residual > 1/24. Nearest-grid residual is at most 1/24,
    // so the halfway case (>=) is the only way a synthetic jitter can fire.
    return mid >= PERFORMANCE_RESIDUAL_LIMIT - 1e-9;
};

const movementStub = (meter: Meter, pickupQuarters: number, printedBars: number, fifths: number): CorpusMovement => ({
    name: 'symbolic',
    midi: 'symbolic.mid',
    meter,
    pickupQuarters,
    partialBars: [],
    printedBars: Math.max(1, printedBars),
    expectedFifths: fifths,
    expectedTempo: { min: 40, max: 200 },
    repeatsUnfoldedInMidi: false,
    expectedHolds: 0,
    expectedExtraNotes: 0,
});

export const fifthsViaLibrary = (fifths: number): number => {
    const score: ScoreData = {
        version: SCORE_DATA_VERSION,
        ticksPerQuarter: TICKS_PER_QUARTER,
        defaultBpm: 80,
        timeSignatures: [{ tick: 0, num: 4, den: 4 }],
        keySignatures: [{ tick: 0, fifths }],
        totalTicks: 1,
        notes: [],
        measures: [],
        systems: [],
        warnings: [],
    };
    return fifthsAt(score, 0);
};

export const candidateFromMidi = (
    buf: Buffer,
    meta: {
        source: MatchCandidateInput['source'];
        format: MatchCandidateInput['format'];
        url: string;
        sha256?: string;
        workKey: WorkKey;
        meter: Meter;
        fifths: number;
        pickupQuarters: number;
        arrangement: boolean;
    },
): MatchCandidateInput => {
    const parsed = parseSmfForTest(buf);
    const barCount = printedBarCountFromTicks(
        parsed.notes.map((n) => n.tick),
        parsed.tpq,
        meta.meter,
        meta.pickupQuarters,
    );
    const notes = notesFromMidi(
        buf,
        movementStub(meta.meter, meta.pickupQuarters, Math.max(1, barCount), meta.fifths),
    );
    const out: MatchCandidateInput = {
        source: meta.source,
        format: meta.format,
        url: meta.url,
        workKey: meta.workKey,
        meter: meta.meter,
        fifths: fifthsViaLibrary(meta.fifths),
        barCount,
        pickupQuarters: meta.pickupQuarters,
        opening: openingFromNotes(notes),
        arrangement: meta.arrangement,
        midi: buf,
    };
    if (meta.sha256 !== undefined) {
        out.sha256 = meta.sha256;
    }
    return out;
};

/**
 * PDF fingerprint stand-in: meters / pickup / printedBars from the corpus pin,
 * opening pitch bag from `midi` (the same bytes used as the candidate).
 * There is no PDF text/layout reader on this path yet.
 */
export const pdfSignalsFromPin = (entry: CorpusEntry, midi: Buffer, workKey: WorkKey): PdfSignals => {
    const mov = entry.movements[0];
    if (!mov) {
        throw new Error(`${entry.slug}: pin has no movements`);
    }
    const cand = candidateFromMidi(midi, {
        source: 'mutopia',
        format: 'mid',
        url: entry.reference.source === 'mutopia' ? entry.reference.url : '',
        workKey,
        meter: mov.meter,
        fifths: mov.expectedFifths,
        pickupQuarters: mov.pickupQuarters,
        arrangement: false,
    });
    return {
        meter: mov.meter,
        fifths: fifthsViaLibrary(mov.expectedFifths),
        printedBars: mov.printedBars,
        pickupQuarters: mov.pickupQuarters,
        opening: cand.opening,
        workKey,
        pageCount: entry.pdf.pages,
    };
};

export const openingSim = (pdf: readonly BarNote[][], cand: readonly BarNote[][]): number => {
    const n = Math.min(OPENING_BARS, pdf.length, cand.length);
    if (n === 0) {
        return pdf.length === 0 && cand.length === 0 ? 1 : 0;
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += pitchSim(pdf[i] ?? [], cand[i] ?? []);
    }
    return sum / n;
};
