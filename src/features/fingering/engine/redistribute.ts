import { isFingerableChord } from '@/features/fingering/engine/chords';
import type { HandSpan } from '@/features/fingering/engine/span';
import type { Hand } from '@/features/fingering/model';

/**
 * When OMR packs an unplayable span onto one hand at a single onset, reassign
 * notes across hands before the DP runs. Candidates: keep OK hand fixed and
 * peel from the broken hand; plus full low→L / high→R pitch splits. One scorer
 * picks among playable candidates.
 */

export interface RedistributeNote {
    noteId: string;
    midi: number;
    hand: Hand;
}

export interface RedistributeResult {
    hands: Map<string, Hand>;
    movedIds: string[];
}

const midisFor = (notes: readonly RedistributeNote[], hand: Hand, assignment: ReadonlyMap<string, Hand>): number[] =>
    notes.filter((n) => assignment.get(n.noteId) === hand).map((n) => n.midi);

const isPlayable = (
    notes: readonly RedistributeNote[],
    assignment: ReadonlyMap<string, Hand>,
    handSpan: HandSpan,
): boolean =>
    isFingerableChord(midisFor(notes, 'L', assignment), 'L', handSpan) &&
    isFingerableChord(midisFor(notes, 'R', assignment), 'R', handSpan);

const movedIdsFrom = (notes: readonly RedistributeNote[], assignment: ReadonlyMap<string, Hand>): string[] =>
    notes.filter((n) => assignment.get(n.noteId) !== n.hand).map((n) => n.noteId);

const resultOf = (notes: readonly RedistributeNote[], hands: Map<string, Hand>): RedistributeResult => ({
    hands,
    movedIds: movedIdsFrom(notes, hands),
});

/** Soft cost among playable assignments (lower wins). */
const scoreAssignment = (
    notes: readonly RedistributeNote[],
    assignment: ReadonlyMap<string, Hand>,
    handSpan: HandSpan,
): number => {
    const origL = notes.filter((n) => n.hand === 'L');
    const origR = notes.filter((n) => n.hand === 'R');
    const lPlayable = isFingerableChord(
        origL.map((n) => n.midi),
        'L',
        handSpan,
    );
    const rPlayable = isFingerableChord(
        origR.map((n) => n.midi),
        'R',
        handSpan,
    );
    const allOriginalR = origL.length === 0 && origR.length === notes.length;

    let changes = 0;
    let stealFromPlayable = 0;
    let lhCount = 0;
    let rhCount = 0;
    for (const n of notes) {
        const next = assignment.get(n.noteId) ?? n.hand;
        if (next === 'L') {
            lhCount += 1;
        } else {
            rhCount += 1;
        }
        if (next === n.hand) {
            continue;
        }
        changes += 1;
        if (n.hand === 'L' && lPlayable && origL.length > 0) {
            stealFromPlayable += 1;
        }
        if (n.hand === 'R' && rPlayable && origR.length > 0 && !allOriginalR) {
            stealFromPlayable += 1;
        }
    }

    let melodyPeel = 0;
    if (allOriginalR && rhCount >= 1 && lhCount >= 1) {
        melodyPeel += rhCount === 1 ? 0 : rhCount === 2 ? 40 : 80;
        melodyPeel += lhCount === 3 ? 0 : Math.abs(lhCount - 3) * 15;
    }

    const emptyRhPenalty = rhCount === 0 && origR.length > 0 ? 25 : 0;
    return stealFromPlayable * 1000 + melodyPeel * 10 + changes * 100 + emptyRhPenalty + Math.abs(lhCount - rhCount);
};

const pitchSplit = (sorted: readonly RedistributeNote[], splitIndex: number): Map<string, Hand> => {
    const next = new Map<string, Hand>();
    for (let i = 0; i < sorted.length; i++) {
        next.set(sorted[i]!.noteId, i < splitIndex ? 'L' : 'R');
    }
    return next;
};

/** Keep `okHand` notes fixed; move k notes from the problem hand onto the other. */
const fixBrokenHand = (
    notes: readonly RedistributeNote[],
    problemHand: Hand,
    k: number,
): Map<string, Hand> => {
    const okHand: Hand = problemHand === 'R' ? 'L' : 'R';
    const problem = [...notes.filter((n) => n.hand === problemHand)].sort(
        (a, b) => a.midi - b.midi || a.noteId.localeCompare(b.noteId),
    );
    const next = new Map<string, Hand>();
    for (const n of notes) {
        if (n.hand === okHand) {
            next.set(n.noteId, okHand);
        }
    }
    if (problemHand === 'R') {
        for (let i = 0; i < problem.length; i++) {
            next.set(problem[i]!.noteId, i < k ? 'L' : 'R');
        }
    } else {
        const keepOnL = problem.length - k;
        for (let i = 0; i < problem.length; i++) {
            next.set(problem[i]!.noteId, i < keepOnL ? 'L' : 'R');
        }
    }
    return next;
};

const collectCandidates = (notes: readonly RedistributeNote[], handSpan: HandSpan): Map<string, Hand>[] => {
    const candidates: Map<string, Hand>[] = [];
    const seen = new Set<string>();
    const push = (assignment: Map<string, Hand>) => {
        const key = [...assignment.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([id, h]) => `${id}:${h}`)
            .join('|');
        if (!seen.has(key)) {
            seen.add(key);
            candidates.push(assignment);
        }
    };

    push(new Map(notes.map((n) => [n.noteId, n.hand])));

    const origLOk = isFingerableChord(
        notes.filter((n) => n.hand === 'L').map((n) => n.midi),
        'L',
        handSpan,
    );
    const origROk = isFingerableChord(
        notes.filter((n) => n.hand === 'R').map((n) => n.midi),
        'R',
        handSpan,
    );
    const problemCountR = notes.filter((n) => n.hand === 'R').length;
    const problemCountL = notes.filter((n) => n.hand === 'L').length;

    if (origLOk && !origROk) {
        for (let k = 0; k <= problemCountR; k++) {
            push(fixBrokenHand(notes, 'R', k));
        }
    }
    if (origROk && !origLOk) {
        for (let k = 0; k <= problemCountL; k++) {
            push(fixBrokenHand(notes, 'L', k));
        }
    }
    if (!origLOk && !origROk) {
        for (let k = 0; k <= problemCountR; k++) {
            push(fixBrokenHand(notes, 'R', k));
        }
        for (let k = 0; k <= problemCountL; k++) {
            push(fixBrokenHand(notes, 'L', k));
        }
    }

    const sorted = [...notes].sort((a, b) => a.midi - b.midi || a.noteId.localeCompare(b.noteId));
    for (let i = 0; i <= sorted.length; i++) {
        push(pitchSplit(sorted, i));
    }
    return candidates;
};

/**
 * Reassign hands for one simultaneity group. Already-playable assignments are
 * returned unchanged. If nothing playable exists, returns the original.
 */
export const redistributeEventHands = (
    notes: readonly RedistributeNote[],
    handSpan: HandSpan = 'standard',
): RedistributeResult => {
    const original = new Map(notes.map((n) => [n.noteId, n.hand]));
    if (notes.length === 0 || isPlayable(notes, original, handSpan)) {
        return resultOf(notes, original);
    }

    let best: Map<string, Hand> | null = null;
    let bestScore = Infinity;
    for (const candidate of collectCandidates(notes, handSpan)) {
        if (!isPlayable(notes, candidate, handSpan)) {
            continue;
        }
        const score = scoreAssignment(notes, candidate, handSpan);
        if (score < bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return resultOf(notes, best ?? original);
};
