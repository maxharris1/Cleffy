import type { ScoreData, ScoreTimeSig } from '../scoreData.js';
import type { CorpusEntry, CorpusMovement } from './manifest.js';

export interface MovementSlice {
    movement: CorpusMovement;
    index: number;
    /** Inclusive start tick. */
    lo: number;
    /** Exclusive end tick. */
    hi: number;
    meterOk: boolean;
}

export interface SegmentResult {
    slices: MovementSlice[];
    movementCountOk: boolean;
    metersOk: boolean;
}

const metersEqual = (sig: ScoreTimeSig, movement: CorpusMovement): boolean =>
    sig.num === movement.meter.num && sig.den === movement.meter.den;

const headingTicks = (score: ScoreData): Set<number> => {
    const ticks = new Set<number>([0]);
    for (const tempo of score.tempos ?? []) {
        // Printed Italian headings (`src: 'word'`). A src-less point after tick 0
        // is the join parseMxlFiles inserts between concatenated movement files.
        if (tempo.src === 'word' || (tempo.src === undefined && tempo.tick > 0)) {
            ticks.add(tempo.tick);
        }
    }
    return ticks;
};

const closeRanges = (slices: MovementSlice[]): void => {
    const assigned = slices.filter((s) => s.meterOk).sort((a, b) => a.lo - b.lo);
    for (let i = 0; i < assigned.length; i++) {
        const current = assigned[i];
        const next = assigned[i + 1];
        if (current && next) {
            current.hi = next.lo;
        }
    }
};

/**
 * Bind movements in order: the next unused signature whose meter matches.
 * Extra signatures that do not match the movement still waiting (flickers)
 * are skipped rather than stolen by a later movement.
 */
const assignLeftToRight = (
    sigs: readonly ScoreTimeSig[],
    entry: CorpusEntry,
    totalTicks: number,
): MovementSlice[] => {
    const slices: MovementSlice[] = [];
    let cursor = 0;
    for (let i = 0; i < entry.movements.length; i++) {
        const movement = entry.movements[i];
        if (!movement) {
            continue;
        }
        let found = -1;
        for (let j = cursor; j < sigs.length; j++) {
            const sig = sigs[j];
            if (sig && metersEqual(sig, movement)) {
                found = j;
                break;
            }
        }
        if (found < 0) {
            slices.push({ movement, index: i, lo: 0, hi: 0, meterOk: false });
            continue;
        }
        const sig = sigs[found];
        if (!sig) {
            slices.push({ movement, index: i, lo: 0, hi: 0, meterOk: false });
            continue;
        }
        slices.push({ movement, index: i, lo: sig.tick, hi: totalTicks, meterOk: true });
        cursor = found + 1;
    }
    closeRanges(slices);
    return slices;
};

const allBound = (slices: MovementSlice[], expected: number): boolean =>
    slices.length === expected && slices.every((s) => s.meterOk);

/**
 * Split a concatenated ScoreData into per-movement tick ranges.
 *
 * Extra `timeSignatures` (meter flicker) must not bind a later movement.
 * When the signature count disagrees with the corpus, prefer seams the parser
 * already emits (tempo headings / concatenated-file joins) and fail
 * `movementCountOk` closed.
 */
export const segmentMovements = (score: ScoreData, entry: CorpusEntry): SegmentResult => {
    const sigs = [...score.timeSignatures].sort((a, b) => a.tick - b.tick);
    const movementCountOk = sigs.length === entry.movements.length;
    let slices = assignLeftToRight(sigs, entry, score.totalTicks);

    if (!movementCountOk) {
        const trustedTicks = headingTicks(score);
        const trusted = sigs.filter((sig, i) => i === 0 || trustedTicks.has(sig.tick));
        const fromHeadings = assignLeftToRight(trusted, entry, score.totalTicks);
        if (allBound(fromHeadings, entry.movements.length)) {
            slices = fromHeadings;
        }
    }

    return { slices, movementCountOk, metersOk: allBound(slices, entry.movements.length) };
};
