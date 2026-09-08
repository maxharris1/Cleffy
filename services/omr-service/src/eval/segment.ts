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

/**
 * Split a concatenated ScoreData into per-movement tick ranges by matching
 * `timeSignatures` against the corpus meter sequence. A mismatch is reported,
 * not thrown — the caller still compares whatever slices it can form.
 */
export const segmentMovements = (score: ScoreData, entry: CorpusEntry): SegmentResult => {
    const sigs = [...score.timeSignatures].sort((a, b) => a.tick - b.tick);
    const used = new Set<number>();
    const slices: MovementSlice[] = [];

    for (let i = 0; i < entry.movements.length; i++) {
        const movement = entry.movements[i];
        if (!movement) {
            continue;
        }
        let sigIndex = -1;
        const sequential = sigs[i];
        if (sequential && !used.has(i) && metersEqual(sequential, movement)) {
            sigIndex = i;
        } else {
            sigIndex = sigs.findIndex((sig, j) => !used.has(j) && metersEqual(sig, movement));
        }
        if (sigIndex < 0) {
            slices.push({ movement, index: i, lo: 0, hi: 0, meterOk: false });
            continue;
        }
        used.add(sigIndex);
        const sig = sigs[sigIndex];
        if (!sig) {
            slices.push({ movement, index: i, lo: 0, hi: 0, meterOk: false });
            continue;
        }
        slices.push({ movement, index: i, lo: sig.tick, hi: score.totalTicks, meterOk: true });
    }

    const assigned = slices.filter((s) => s.meterOk).sort((a, b) => a.lo - b.lo);
    for (let i = 0; i < assigned.length; i++) {
        const current = assigned[i];
        const next = assigned[i + 1];
        if (current && next) {
            current.hi = next.lo;
        }
    }

    const movementCountOk = sigs.length === entry.movements.length;
    const metersOk = slices.length === entry.movements.length && slices.every((s) => s.meterOk);
    return { slices, movementCountOk, metersOk };
};
