import { enumerateStates } from '@/features/fingering/engine/chords';
import { transitionCost, unaryCost, type EventGeometry } from '@/features/fingering/engine/cost';
import type { HandSpan } from '@/features/fingering/engine/span';
import type { Finger } from '@/features/fingering/model';

/**
 * Viterbi over per-event finger assignments: cost[i][s] = unary(i,s) +
 * min over s' of (cost[i-1][s'] + transition(s', s)), with backpointers.
 * State counts are ≤ C(5,k) = 10 per event, so this is O(n·100) — microseconds
 * for realistic phrases. Ties break to the earliest-enumerated (lexicographic)
 * state so results are deterministic.
 */

export interface DpEvent extends EventGeometry {
    /** Pinned fingers by ascending-pitch position (from written fingerings). */
    pinned?: ReadonlyMap<number, Finger>;
}

export interface DpResult {
    /** One assignment per event, ascending-pitch order; null = unfingerable. */
    assignments: Array<Finger[] | null>;
    /** Events whose pins had to be ignored to stay playable. */
    ignoredPinEvents: number[];
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

export const solve = (events: readonly DpEvent[], hand: HandSpan = 'standard'): DpResult => {
    const ignoredPinEvents: number[] = [];

    // Per-event state sets, pins applied (falling back to unpinned when pins
    // would make the event unplayable).
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

    // Segment the sequence at unfingerable events (empty state sets) — each
    // playable run is solved independently.
    const assignments: Array<Finger[] | null> = events.map(() => null);
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
        solveSegment(events, states, assignments, segmentStart, segmentEnd, hand);
        segmentStart = segmentEnd + 1;
    }

    return { assignments, ignoredPinEvents };
};

const solveSegment = (
    events: readonly DpEvent[],
    states: Finger[][][],
    assignments: Array<Finger[] | null>,
    start: number,
    end: number,
    hand: HandSpan,
): void => {
    let prevCosts = states[start]!.map((s) => unaryCost(events[start]!, s, hand));
    const backpointers: number[][] = [];

    for (let i = start + 1; i <= end; i++) {
        const event = events[i]!;
        const eventStates = states[i]!;
        const costs = new Array<number>(eventStates.length);
        const back = new Array<number>(eventStates.length);
        for (let s = 0; s < eventStates.length; s++) {
            const state = eventStates[s]!;
            let best = Infinity;
            let bestPrev = 0;
            for (let p = 0; p < prevCosts.length; p++) {
                const total =
                    prevCosts[p]! + transitionCost(events[i - 1]!, states[i - 1]![p]!, event, state, hand);
                if (total < best) {
                    best = total;
                    bestPrev = p;
                }
            }
            costs[s] = best + unaryCost(event, state, hand);
            back[s] = bestPrev;
        }
        backpointers.push(back);
        prevCosts = costs;
    }

    let bestFinal = 0;
    for (let s = 1; s < prevCosts.length; s++) {
        if (prevCosts[s]! < prevCosts[bestFinal]!) {
            bestFinal = s;
        }
    }

    let cursor = bestFinal;
    for (let i = end; i >= start; i--) {
        assignments[i] = [...states[i]![cursor]!];
        if (i > start) {
            cursor = backpointers[i - 1 - start]![cursor]!;
        }
    }
};
