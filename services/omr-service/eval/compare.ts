import { parseMidi, type MidiData } from 'midi-file';

import type { ScoreData } from '../src/scoreData.js';

/**
 * Per-bar pitch comparison of a ScoreData against a reference MIDI.
 *
 * The question asked of every engraved bar is "what fraction of the notes
 * the reference has in this bar did the transcription put somewhere in the
 * same bar, at the right pitch?" — recall of pitch multisets, nothing about
 * onset, duration, or voice inside the bar. That is a follow-along metric, not
 * an OMR accuracy gate for tuplets.
 *
 * Bars are aligned by dynamic time warping rather than by number, so a bar
 * Audiveris merged with its neighbour (or split in two) costs that bar and
 * not every bar after it.
 */

/** One movement of the reference, as `boundaries.json` describes it. */
export interface MovementBoundary {
    name: string;
    /** MIDI file name inside the fixture directory. */
    midi: string;
    /** Quarter beats per reference bar. */
    beats: number;
    /** Quarter beats in a pickup bar before bar 1, 0 for none. */
    pickupBeats: number;
    /**
     * Engraved-measure index range (inclusive) inside the ScoreData for this
     * movement. Optional: when absent, movements are cut where the printed
     * measure numbers restart.
     */
    lo?: number;
    hi?: number;
    /**
     * When true (the default), this movement must meet `gate` for `CompareResult.pass`.
     * When false, the movement is still scored and printed — it does not fail the run.
     */
    gated?: boolean;
}

/** A bar's pitches as a multiset. */
export type PitchBag = Map<number, number>;

export interface ReferenceBar {
    /** 1-based bar number as printed, 0 for a pickup. */
    n: number;
    pitches: PitchBag;
}

export interface ScoreBar {
    /** Engraved index into `ScoreData.measures` (srcIndex). */
    index: number;
    /** Printed number, as the parser read it. */
    n: number;
    pitches: PitchBag;
}

export interface BarResult {
    ref: ReferenceBar;
    /** Engraved score bars aligned to this reference bar (0, 1 or 2). */
    aligned: ScoreBar[];
    /** Fraction of reference notes present at the right pitch, 0..1. */
    match: number;
    /** Reference notes in the bar. */
    refNotes: number;
    /** Reference notes found. */
    found: number;
}

export interface MovementResult {
    name: string;
    bars: BarResult[];
    /** Bars at or above the gate. */
    passing: number;
    /** Sum of found / sum of refNotes. */
    noteRecall: number;
    /** Score bars that aligned to nothing in the reference. */
    extraScoreBars: number;
    /** Whether this movement is part of `CompareResult.pass`. */
    gated: boolean;
}

export interface CompareResult {
    movements: MovementResult[];
    gate: number;
    /**
     * Every *gated* movement has every bar at or above the gate. Ungated
     * movements are reported only. False when nothing is gated, so a report-only
     * run cannot print PASS.
     */
    pass: boolean;
}

export const DEFAULT_GATE = 0.9;

const bagOf = (pitches: Iterable<number>): PitchBag => {
    const bag: PitchBag = new Map();
    for (const p of pitches) {
        bag.set(p, (bag.get(p) ?? 0) + 1);
    }
    return bag;
};

const bagSize = (bag: PitchBag): number => {
    let n = 0;
    for (const count of bag.values()) {
        n += count;
    }
    return n;
};

const bagUnion = (bags: readonly PitchBag[]): PitchBag => {
    const out: PitchBag = new Map();
    for (const bag of bags) {
        for (const [p, count] of bag) {
            out.set(p, (out.get(p) ?? 0) + count);
        }
    }
    return out;
};

/** How many of `ref`'s notes `score` has, pitch for pitch. */
const overlap = (ref: PitchBag, score: PitchBag): number => {
    let found = 0;
    for (const [p, count] of ref) {
        found += Math.min(count, score.get(p) ?? 0);
    }
    return found;
};

/** Recall of `ref` inside `score`; an empty reference bar is trivially complete. */
const recall = (ref: PitchBag, score: PitchBag): number => {
    const size = bagSize(ref);
    return size === 0 ? 1 : overlap(ref, score) / size;
};

/**
 * Reference bars from a MIDI file. Every note-on (velocity > 0) on every
 * track is binned by absolute tick into bars of `beats` quarters, after an
 * optional pickup of `pickupBeats`.
 */
export const referenceBars = (
    midi: Buffer,
    movement: Pick<MovementBoundary, 'beats' | 'pickupBeats'>,
): ReferenceBar[] => {
    const data: MidiData = parseMidi(midi);
    const ticksPerBeat = data.header.ticksPerBeat;
    if (!ticksPerBeat) {
        throw new Error('Reference MIDI uses SMPTE time division; ticks per beat is required');
    }
    const barTicks = movement.beats * ticksPerBeat;
    const pickupTicks = movement.pickupBeats * ticksPerBeat;
    const barIndexOf = (tick: number): number => {
        if (pickupTicks > 0) {
            return tick < pickupTicks ? 0 : 1 + Math.floor((tick - pickupTicks) / barTicks);
        }
        return 1 + Math.floor(tick / barTicks);
    };

    const byBar = new Map<number, number[]>();
    let maxBar = pickupTicks > 0 ? 0 : 1;
    for (const track of data.tracks) {
        let tick = 0;
        for (const event of track) {
            tick += event.deltaTime;
            if (event.type === 'noteOn' && event.velocity > 0) {
                const bar = barIndexOf(tick);
                maxBar = Math.max(maxBar, bar);
                let pitches = byBar.get(bar);
                if (!pitches) {
                    pitches = [];
                    byBar.set(bar, pitches);
                }
                pitches.push(event.noteNumber);
            }
        }
    }
    const bars: ReferenceBar[] = [];
    for (let n = pickupTicks > 0 ? 0 : 1; n <= maxBar; n++) {
        bars.push({ n, pitches: bagOf(byBar.get(n) ?? []) });
    }
    return bars;
};

/**
 * Engraved bars of a ScoreData, in page order. A performed repeat clones a
 * measure under the same `srcIndex`; only the first pass is a bar of the
 * engraving, so only that one is compared.
 */
export const scoreBars = (score: Pick<ScoreData, 'notes' | 'measures'>): ScoreBar[] => {
    const seen = new Set<number>();
    const bars: ScoreBar[] = [];
    const notes = [...score.notes].sort((a, b) => a.t - b.t);
    for (const [position, measure] of score.measures.entries()) {
        const index = measure.srcIndex ?? position;
        if (seen.has(index)) {
            continue;
        }
        seen.add(index);
        const end = measure.tick + measure.dTicks;
        const pitches: number[] = [];
        for (const note of notes) {
            if (note.t >= end) {
                break;
            }
            if (note.t >= measure.tick) {
                pitches.push(note.p);
            }
        }
        bars.push({ index, n: measure.n, pitches: bagOf(pitches) });
    }
    return bars;
};

/**
 * Cut the engraved bars into movements where the printed numbers restart:
 * Audiveris exports one MusicXML per movement and the parser concatenates
 * them, so a movement boundary is the one place the numbers go backwards.
 */
export const splitAtNumberRestarts = (bars: readonly ScoreBar[]): ScoreBar[][] => {
    const segments: ScoreBar[][] = [];
    let current: ScoreBar[] = [];
    let previous = Number.NEGATIVE_INFINITY;
    for (const bar of bars) {
        if (bar.n < previous && current.length > 0) {
            segments.push(current);
            current = [];
        }
        current.push(bar);
        previous = bar.n;
    }
    if (current.length > 0) {
        segments.push(current);
    }
    return segments;
};

/**
 * Alignment moves. `merge` pairs two reference bars with one score bar (the
 * engraving's bar was read as one); `split` pairs one reference bar with two
 * score bars (a barline was hallucinated). Skips cost a full bar on the
 * reference side and a little less on the score side, so a stray extra bar
 * is absorbed rather than dragging the alignment off.
 */
type Move = 'match' | 'merge' | 'split' | 'skipRef' | 'skipScore';

const SKIP_SCORE_COST = 0.6;
/** A merge or split is the rarer explanation: on a tie, a plain match or skip wins. */
const RESHAPE_COST = 0.05;

interface Cell {
    cost: number;
    move: Move | null;
}

/** DTW over pitch-multiset recall; returns the per-reference-bar results. */
export const alignBars = (
    ref: readonly ReferenceBar[],
    score: readonly ScoreBar[],
): { bars: BarResult[]; extra: number } => {
    const n = ref.length;
    const m = score.length;
    const table: Cell[][] = Array.from({ length: n + 1 }, () =>
        Array.from({ length: m + 1 }, () => ({ cost: Number.POSITIVE_INFINITY, move: null })),
    );
    const cell = (i: number, j: number): Cell => {
        const row = table[i];
        const value = row?.[j];
        if (!value) {
            throw new Error(`alignment table out of range at ${i},${j}`);
        }
        return value;
    };
    cell(0, 0).cost = 0;
    for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= m; j++) {
            const here = cell(i, j);
            if (here.cost === Number.POSITIVE_INFINITY) {
                continue;
            }
            const relax = (di: number, dj: number, add: number, move: Move): void => {
                if (i + di > n || j + dj > m) {
                    return;
                }
                const target = cell(i + di, j + dj);
                const cost = here.cost + add;
                if (cost < target.cost) {
                    target.cost = cost;
                    target.move = move;
                }
            };
            const r0 = ref[i];
            const r1 = ref[i + 1];
            const s0 = score[j];
            const s1 = score[j + 1];
            if (r0 && s0) {
                relax(1, 1, 1 - recall(r0.pitches, s0.pitches), 'match');
            }
            if (r0 && r1 && s0) {
                // Pitch-bag recall of the union, not onset or duration: a score
                // bar that contains both reference bars' pitches scores a merge
                // as complete even when the triplet rhythm is wrong.
                const both = bagUnion([r0.pitches, r1.pitches]);
                relax(2, 1, 2 * (1 - recall(both, s0.pitches)) + RESHAPE_COST, 'merge');
            }
            if (r0 && s0 && s1) {
                const both = bagUnion([s0.pitches, s1.pitches]);
                // Two score bars for one reference bar: the hallucinated barline
                // costs a little on top of whatever the notes cost.
                relax(1, 2, 1 - recall(r0.pitches, both) + SKIP_SCORE_COST / 2 + RESHAPE_COST, 'split');
            }
            if (r0) {
                relax(1, 0, 1, 'skipRef');
            }
            if (s0) {
                relax(0, 1, SKIP_SCORE_COST, 'skipScore');
            }
        }
    }

    // Walk back from the corner.
    const results: BarResult[] = [];
    let extra = 0;
    let i = n;
    let j = m;
    const emit = (bar: ReferenceBar, aligned: ScoreBar[]): void => {
        const scoreBag = bagUnion(aligned.map((s) => s.pitches));
        const refNotes = bagSize(bar.pitches);
        const found = overlap(bar.pitches, scoreBag);
        results.push({ ref: bar, aligned, match: refNotes === 0 ? 1 : found / refNotes, refNotes, found });
    };
    while (i > 0 || j > 0) {
        const move = cell(i, j).move;
        switch (move) {
            case 'match': {
                const bar = ref[i - 1];
                const s = score[j - 1];
                if (bar && s) {
                    emit(bar, [s]);
                }
                i -= 1;
                j -= 1;
                break;
            }
            case 'merge': {
                const s = score[j - 1];
                const first = ref[i - 2];
                const second = ref[i - 1];
                if (s && first && second) {
                    // Both bars were read as one: each is credited with what the
                    // merged bar holds of it, sharing nothing twice.
                    // Walking backwards, so the later bar is pushed first.
                    const shared = new Map(s.pitches);
                    for (const bar of [second, first]) {
                        const refNotes = bagSize(bar.pitches);
                        let found = 0;
                        for (const [p, count] of bar.pitches) {
                            const take = Math.min(count, shared.get(p) ?? 0);
                            found += take;
                            shared.set(p, (shared.get(p) ?? 0) - take);
                        }
                        results.push({
                            ref: bar,
                            aligned: [s],
                            match: refNotes === 0 ? 1 : found / refNotes,
                            refNotes,
                            found,
                        });
                    }
                }
                i -= 2;
                j -= 1;
                break;
            }
            case 'split': {
                const bar = ref[i - 1];
                const a = score[j - 2];
                const b = score[j - 1];
                if (bar && a && b) {
                    emit(bar, [a, b]);
                }
                i -= 1;
                j -= 2;
                break;
            }
            case 'skipRef': {
                const bar = ref[i - 1];
                if (bar) {
                    emit(bar, []);
                }
                i -= 1;
                break;
            }
            case 'skipScore':
                extra += 1;
                j -= 1;
                break;
            case null:
                throw new Error(`alignment has no path through ${i},${j}`);
            default: {
                const exhaustive: never = move;
                return exhaustive;
            }
        }
    }
    results.reverse();
    return { bars: results, extra };
};

export interface CompareInput {
    score: Pick<ScoreData, 'notes' | 'measures'>;
    movements: Array<{ boundary: MovementBoundary; midi: Buffer }>;
    gate?: number;
}

/**
 * Compare a ScoreData with the reference movements.
 *
 * When the score cuts into as many movements as the reference has, each is
 * aligned on its own; otherwise (a movement boundary Audiveris missed, or one
 * it invented) the whole score is aligned against the whole reference and the
 * bars are attributed back to their movements afterwards.
 */
export const compareScore = (input: CompareInput): CompareResult => {
    const gate = input.gate ?? DEFAULT_GATE;
    const refByMovement = input.movements.map(({ boundary, midi }) => ({
        boundary,
        bars: referenceBars(midi, boundary),
    }));
    const engraved = scoreBars(input.score);

    const explicit = input.movements.every(({ boundary }) => boundary.lo !== undefined && boundary.hi !== undefined);
    let segments: ScoreBar[][] | null = null;
    if (explicit) {
        segments = input.movements.map(({ boundary }) =>
            engraved.filter(
                (bar) => bar.index >= (boundary.lo ?? 0) && bar.index <= (boundary.hi ?? Number.MAX_SAFE_INTEGER),
            ),
        );
    } else {
        const cut = splitAtNumberRestarts(engraved);
        if (cut.length === refByMovement.length) {
            segments = cut;
        }
    }

    const movements: MovementResult[] = [];
    if (segments) {
        for (const [index, movement] of refByMovement.entries()) {
            const aligned = alignBars(movement.bars, segments[index] ?? []);
            movements.push(summarize(movement.boundary, aligned.bars, aligned.extra, gate));
        }
    } else {
        const allRef = refByMovement.flatMap((movement) => movement.bars);
        const aligned = alignBars(allRef, engraved);
        let offset = 0;
        for (const movement of refByMovement) {
            const slice = aligned.bars.slice(offset, offset + movement.bars.length);
            offset += movement.bars.length;
            movements.push(summarize(movement.boundary, slice, 0, gate));
        }
        const last = movements[movements.length - 1];
        if (last) {
            last.extraScoreBars = aligned.extra;
        }
    }

    const gated = movements.filter((movement) => movement.gated);
    return {
        movements,
        gate,
        pass: gated.length > 0 && gated.every((movement) => movement.passing === movement.bars.length),
    };
};

const summarize = (boundary: MovementBoundary, bars: BarResult[], extra: number, gate: number): MovementResult => {
    let refNotes = 0;
    let found = 0;
    let passing = 0;
    for (const bar of bars) {
        refNotes += bar.refNotes;
        found += bar.found;
        if (bar.match >= gate) {
            passing += 1;
        }
    }
    return {
        name: boundary.name,
        bars,
        passing,
        noteRecall: refNotes === 0 ? 1 : found / refNotes,
        extraScoreBars: extra,
        gated: boundary.gated !== false,
    };
};
