import { enumerateStates } from '@/features/fingering/engine/chords';
import { order2Cost, transitionCost, unaryCost, type EventGeometry } from '@/features/fingering/engine/cost';
import type { HandSpan } from '@/features/fingering/engine/span';
import type { Finger } from '@/features/fingering/model';

/**
 * List-Viterbi over per-event finger assignments. Soft phrase resets live in
 * transitionCost. Monophonic order2Cost is a tie-break among equal primary
 * costs. When k>1, each state keeps k hypotheses so alternates are true
 * ranked full paths (not ending-state diversity on a 1-best tree).
 */

export interface DpEvent extends EventGeometry {
    /** Pinned fingers by ascending-pitch position (from written fingerings). */
    pinned?: ReadonlyMap<number, Finger>;
}

export interface DpSolveOptions {
    /** Number of ranked full-sequence paths to return (default 1). */
    k?: number;
}

export interface DpResult {
    /** Best assignment per event, ascending-pitch order; null = unfingerable. */
    assignments: Array<Finger[] | null>;
    /** Events whose pins had to be ignored to stay playable. */
    ignoredPinEvents: number[];
    /** Additional full-sequence paths ranked after the primary (length ≤ k−1). */
    alternativeAssignments: Array<Array<Finger[] | null>>;
}

const COST_EPS = 1e-9;

interface Hyp {
    cost: number;
    /** State index at previous event (−1 at segment start). */
    prevState: number;
    /** Hypothesis index within that previous state's list (−1 at start). */
    prevHyp: number;
    /** Tie-break key (order2); lower wins when primary costs tie. */
    o2: number;
}

const matchesPins = (fingers: readonly Finger[], pinned: ReadonlyMap<number, Finger> | undefined): boolean => {
    if (!pinned) {
        return true;
    }
    for (const [position, finger] of pinned) {
        if (fingers[position] !== finger) {
            return false;
        }
    }
    return true;
};

const isMonophonicRun = (events: readonly DpEvent[], start: number, end: number): boolean => {
    for (let i = start; i <= end; i++) {
        if (events[i]!.midis.length !== 1) {
            return false;
        }
    }
    return true;
};

const compareHyps = (a: Hyp, b: Hyp): number => {
    const d = a.cost - b.cost;
    if (Math.abs(d) > COST_EPS) {
        return d;
    }
    const o = a.o2 - b.o2;
    if (Math.abs(o) > COST_EPS) {
        return o;
    }
    if (a.prevState !== b.prevState) {
        return a.prevState - b.prevState;
    }
    return a.prevHyp - b.prevHyp;
};

/** Keep the best `k` hypotheses (sorted ascending). */
const takeTopK = (candidates: Hyp[], k: number): Hyp[] => {
    candidates.sort(compareHyps);
    return candidates.slice(0, Math.min(k, candidates.length));
};

const pathsEqual = (a: Finger[][], b: Finger[][]): boolean => {
    if (a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i++) {
        const aa = a[i]!;
        const bb = b[i]!;
        if (aa.length !== bb.length || aa.some((f, j) => f !== bb[j])) {
            return false;
        }
    }
    return true;
};

export const solve = (
    events: readonly DpEvent[],
    hand: HandSpan = 'standard',
    options: DpSolveOptions = {},
): DpResult => {
    const k = Math.max(1, options.k ?? 1);
    const ignoredPinEvents: number[] = [];

    const states: Finger[][][] = events.map((event, index) => {
        const all = enumerateStates(event.midis, hand);
        if (all.length === 0) {
            return [];
        }
        const pinnedStates = all.filter((s) => matchesPins(s, event.pinned));
        if (event.pinned && event.pinned.size > 0 && pinnedStates.length === 0) {
            ignoredPinEvents.push(index);
            return all;
        }
        return pinnedStates;
    });

    const ranked: Array<Array<Finger[] | null>> = Array.from({ length: k }, () => events.map(() => null));

    let segmentStart = 0;
    while (segmentStart < events.length) {
        if (states[segmentStart]!.length === 0) {
            segmentStart++;
            continue;
        }
        let segmentEnd = segmentStart;
        while (segmentEnd + 1 < events.length && states[segmentEnd + 1]!.length > 0) {
            segmentEnd++;
        }
        const useOrder2 = isMonophonicRun(events, segmentStart, segmentEnd);
        const paths = solveSegmentListViterbi(events, states, segmentStart, segmentEnd, hand, k, useOrder2);
        for (let r = 0; r < paths.length; r++) {
            const path = paths[r]!;
            for (let i = segmentStart; i <= segmentEnd; i++) {
                ranked[r]![i] = path[i - segmentStart]!;
            }
        }
        // Shorter path lists: fill remaining ranks with the best path for this segment.
        for (let r = paths.length; r < k; r++) {
            const path = paths[0];
            if (!path) {
                break;
            }
            for (let i = segmentStart; i <= segmentEnd; i++) {
                ranked[r]![i] = path[i - segmentStart]!;
            }
        }
        segmentStart = segmentEnd + 1;
    }

    const primary = ranked[0]!;
    const alternativeAssignments = ranked.slice(1).filter((alt) =>
        alt.some((a, i) => {
            const best = primary[i];
            if (a === null && best === null) {
                return false;
            }
            if (a === null || best === null) {
                return true;
            }
            return a.length !== best.length || a.some((f, j) => f !== best[j]);
        }),
    );

    return { assignments: primary, ignoredPinEvents, alternativeAssignments };
};

/**
 * List-Viterbi: each state keeps up to `k` incoming hypotheses so the global
 * top-k finals are distinct ranked full paths.
 */
const solveSegmentListViterbi = (
    events: readonly DpEvent[],
    states: Finger[][][],
    start: number,
    end: number,
    hand: HandSpan,
    k: number,
    useOrder2: boolean,
): Finger[][][] => {
    // hyps[eventOffset][stateIdx] = ranked hypotheses ending in that state
    const hyps: Hyp[][][] = [];
    hyps.push(
        states[start]!.map((s) => [
            { cost: unaryCost(events[start]!, s, hand), prevState: -1, prevHyp: -1, o2: 0 },
        ]),
    );

    for (let i = start + 1; i <= end; i++) {
        const event = events[i]!;
        const eventStates = states[i]!;
        const prevHyps = hyps[hyps.length - 1]!;
        const prevEvent = events[i - 1]!;
        const prevStates = states[i - 1]!;
        const layer: Hyp[][] = [];

        for (let s = 0; s < eventStates.length; s++) {
            const state = eventStates[s]!;
            const unary = unaryCost(event, state, hand);
            const candidates: Hyp[] = [];
            for (let p = 0; p < prevStates.length; p++) {
                const atPrev = prevHyps[p]!;
                for (let h = 0; h < atPrev.length; h++) {
                    const prev = atPrev[h]!;
                    const primary =
                        prev.cost + transitionCost(prevEvent, prevStates[p]!, event, state, hand);
                    let o2 = 0;
                    if (useOrder2 && i >= start + 2 && prev.prevState >= 0) {
                        const prevPrevState = states[i - 2]![prev.prevState]!;
                        o2 = order2Cost(
                            prevPrevState[0] as Finger,
                            prevStates[p]![0] as Finger,
                            state[0] as Finger,
                            events[i - 2]!.midis[0] as number,
                            prevEvent.midis[0] as number,
                            event.midis[0] as number,
                        );
                    }
                    candidates.push({
                        cost: primary + unary,
                        prevState: p,
                        prevHyp: h,
                        o2,
                    });
                }
            }
            layer.push(takeTopK(candidates, k));
        }
        hyps.push(layer);
    }

    // Global top-k finals across all ending states / hypotheses.
    const finals: Array<{ state: number; hyp: number; cost: number; o2: number }> = [];
    const lastLayer = hyps[hyps.length - 1]!;
    for (let s = 0; s < lastLayer.length; s++) {
        for (let h = 0; h < lastLayer[s]!.length; h++) {
            const hyp = lastLayer[s]![h]!;
            finals.push({ state: s, hyp: h, cost: hyp.cost, o2: hyp.o2 });
        }
    }
    finals.sort((a, b) => {
        const d = a.cost - b.cost;
        if (Math.abs(d) > COST_EPS) {
            return d;
        }
        const o = a.o2 - b.o2;
        if (Math.abs(o) > COST_EPS) {
            return o;
        }
        return a.state - b.state || a.hyp - b.hyp;
    });

    const paths: Finger[][][] = [];
    for (const final of finals) {
        if (paths.length >= k) {
            break;
        }
        const path = backtraceListPath(states, hyps, start, end, final.state, final.hyp);
        if (paths.some((existing) => pathsEqual(existing, path))) {
            continue;
        }
        paths.push(path);
    }
    return paths;
};

const backtraceListPath = (
    states: Finger[][][],
    hyps: Hyp[][][],
    start: number,
    end: number,
    endState: number,
    endHyp: number,
): Finger[][] => {
    const path: Finger[][] = [];
    let state = endState;
    let hypIdx = endHyp;
    for (let i = end; i >= start; i--) {
        path.push([...states[i]![state]!]);
        if (i === start) {
            break;
        }
        const hyp = hyps[i - start]![state]![hypIdx]!;
        state = hyp.prevState;
        hypIdx = hyp.prevHyp;
    }
    path.reverse();
    return path;
};
