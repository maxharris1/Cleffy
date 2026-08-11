import { solve, type DpEvent } from '@/features/fingering/engine/dp';
import { redistributeEventHands } from '@/features/fingering/engine/redistribute';
import type { HandSpan } from '@/features/fingering/engine/span';
import {
    isBlackKey,
    mergedEventIndices,
    type Finger,
    type FingeringSequence,
    type Hand,
    type RecognizedRegion,
} from '@/features/fingering/model';

export type { HandSpan };

/**
 * Public engine API: Parncutt-style ergonomic costs + Viterbi, per hand.
 * The engine works in right-hand geometry; the left hand is solved by
 * negating pitches (which flips the keyboard, so LH-thumb-on-the-right
 * becomes RH-thumb-on-the-left) while black-key flags follow the ORIGINAL
 * keys.
 */

export interface EngineEvent {
    /** Region eventIndex, passed through so steps merge across hands. */
    index: number;
    /** Ascending-midi note ids and pitches (parallel arrays). */
    noteIds: string[];
    midis: number[];
}

export interface EngineInput {
    hand: Hand;
    events: EngineEvent[];
    /** Fingers to keep (from written fingerings), by noteId. */
    pins?: ReadonlyMap<string, Finger>;
    /** Reach limits — children/small hands get tighter span tables. */
    handSpan?: HandSpan;
    /** Ranked paths to return (1 = primary only). */
    k?: number;
}

export interface EngineResult {
    sequence: FingeringSequence;
    /** Additional ranked sequences (length ≤ k−1). */
    alternativeSequences: FingeringSequence[];
    /** Note ids whose pins were unplayable and got ignored. */
    ignoredPinNoteIds: string[];
}

export interface SuggestAlternative {
    sequences: Record<Hand, FingeringSequence | null>;
    fingerById: Map<string, Finger | null>;
}

export interface SuggestForRegionResult {
    sequences: Record<Hand, FingeringSequence | null>;
    /** noteId → hand used for fingering (after redistribution). */
    fingeringHand: Map<string, Hand>;
    /** Notes whose fingering hand differs from staff→handOf. */
    movedNoteIds: string[];
    /** Flattened finger per noteId from the suggested sequences. */
    fingerById: Map<string, Finger | null>;
    /** Distinct lower-ranked options (diagram top-k). */
    alternatives: SuggestAlternative[];
}

export interface SuggestForRegionOptions {
    /** Ranked suggestions to compute (default 1). Diagram uses 3. */
    k?: number;
}

const assignmentToSequence = (
    input: EngineInput,
    mirror: boolean,
    assignments: Array<Finger[] | null>,
): FingeringSequence => {
    const events = input.events.map((event, i) => {
        const assignment = assignments[i];
        const order = event.midis.map((_, idx) => idx);
        order.sort((a, b) => (event.midis[a] as number) - (event.midis[b] as number));
        const positions = mirror ? [...order].reverse() : order;

        const fingerByNote = new Map<string, Finger | null>();
        positions.forEach((noteIndex, dpPosition) => {
            fingerByNote.set(event.noteIds[noteIndex] as string, assignment?.[dpPosition] ?? null);
        });

        return {
            index: event.index,
            hand: input.hand,
            notes: order.map((noteIndex) => ({
                noteId: event.noteIds[noteIndex] as string,
                midi: event.midis[noteIndex] as number,
                finger: fingerByNote.get(event.noteIds[noteIndex] as string) ?? null,
            })),
        };
    });
    return { hand: input.hand, events, source: 'suggested' };
};

export const suggestFingerings = (input: EngineInput): EngineResult => {
    const mirror = input.hand === 'L';
    const k = Math.max(1, input.k ?? 1);

    const dpEvents: DpEvent[] = input.events.map((event) => {
        const order = event.midis.map((_, i) => i);
        order.sort((a, b) => (event.midis[a] as number) - (event.midis[b] as number));
        const positions = mirror ? [...order].reverse() : order;

        const midis = positions.map((i) => (mirror ? -(event.midis[i] as number) : (event.midis[i] as number)));
        const blacks = positions.map((i) => isBlackKey(event.midis[i] as number));
        const pinned = new Map<number, Finger>();
        if (input.pins) {
            positions.forEach((noteIndex, dpPosition) => {
                const pin = input.pins?.get(event.noteIds[noteIndex] as string);
                if (pin) {
                    pinned.set(dpPosition, pin);
                }
            });
        }
        return { midis, blacks, pinned: pinned.size > 0 ? pinned : undefined };
    });

    const { assignments, ignoredPinEvents, alternativeAssignments } = solve(
        dpEvents,
        input.handSpan ?? 'standard',
        { k },
    );

    const ignoredPinNoteIds = ignoredPinEvents.flatMap((i) =>
        (input.events[i]?.noteIds ?? []).filter((id) => input.pins?.has(id)),
    );

    return {
        sequence: assignmentToSequence(input, mirror, assignments),
        alternativeSequences: alternativeAssignments.map((alt) => assignmentToSequence(input, mirror, alt)),
        ignoredPinNoteIds,
    };
};

/**
 * Hand used for fingering each note: staff→hand from the region, then
 * per-onset redistribution when a packed span is unplayable as one hand.
 */
const fingeringHandsForRegion = (
    region: RecognizedRegion,
    handSpan: HandSpan,
): { hands: Map<string, Hand>; movedIds: string[] } => {
    const hands = new Map<string, Hand>();
    const movedIds: string[] = [];
    const byEvent = new Map<number, Array<{ noteId: string; midi: number; hand: Hand }>>();
    for (const note of region.notes) {
        const hand = region.handOf[note.staff];
        hands.set(note.id, hand);
        const group = byEvent.get(note.eventIndex) ?? [];
        group.push({ noteId: note.id, midi: note.midi, hand });
        byEvent.set(note.eventIndex, group);
    }
    for (const group of byEvent.values()) {
        const { hands: next, movedIds: moved } = redistributeEventHands(group, handSpan);
        for (const [noteId, hand] of next) {
            hands.set(noteId, hand);
        }
        movedIds.push(...moved);
    }
    return { hands, movedIds };
};

const buildSequencesForHands = (
    region: RecognizedRegion,
    fingeringHand: Map<string, Hand>,
    keepWritten: boolean,
    handSpan: HandSpan,
    k: number,
): { primary: Record<Hand, FingeringSequence | null>; ranked: Array<Record<Hand, FingeringSequence | null>> } => {
    const eventIndices = mergedEventIndices(region);
    const primary: Record<Hand, FingeringSequence | null> = { L: null, R: null };
    const perHandAlts: Record<Hand, FingeringSequence[]> = { L: [], R: [] };

    for (const hand of ['L', 'R'] as const) {
        const events: EngineEvent[] = [];
        for (const index of eventIndices) {
            const chord = region.notes
                .filter((n) => n.eventIndex === index && fingeringHand.get(n.id) === hand)
                .sort((a, b) => a.midi - b.midi || a.id.localeCompare(b.id));
            if (chord.length === 0) {
                continue;
            }
            events.push({
                index,
                noteIds: chord.map((n) => n.id),
                midis: chord.map((n) => n.midi),
            });
        }
        if (events.length === 0) {
            continue;
        }
        const pins = keepWritten
            ? new Map(
                  region.notes
                      .filter((n) => fingeringHand.get(n.id) === hand && n.annotatedFinger !== null)
                      .map((n) => [n.id, n.annotatedFinger as Finger]),
              )
            : undefined;
        const result = suggestFingerings({ hand, events, pins, handSpan, k });
        primary[hand] = result.sequence;
        perHandAlts[hand] = result.alternativeSequences;
    }

    const ranked: Array<Record<Hand, FingeringSequence | null>> = [];
    // Vary one hand at a time so each option is a coherent single-hand alternate
    // against the other hand's primary — never L[j]×R[j] Frankenstein pairs.
    for (const hand of ['L', 'R'] as const) {
        for (const alt of perHandAlts[hand]) {
            ranked.push({
                L: hand === 'L' ? alt : primary.L,
                R: hand === 'R' ? alt : primary.R,
            });
        }
    }
    return { primary, ranked };
};

const fingerByIdFromSequences = (
    sequences: Record<Hand, FingeringSequence | null>,
): Map<string, Finger | null> => {
    const map = new Map<string, Finger | null>();
    for (const hand of ['L', 'R'] as const) {
        for (const event of sequences[hand]?.events ?? []) {
            for (const n of event.notes) {
                map.set(n.noteId, n.finger);
            }
        }
    }
    return map;
};

const fingerMapsEqual = (a: Map<string, Finger | null>, b: Map<string, Finger | null>): boolean => {
    if (a.size !== b.size) {
        return false;
    }
    for (const [id, finger] of a) {
        if (b.get(id) !== finger) {
            return false;
        }
    }
    return true;
};

/**
 * Suggested fingerings plus redistribution metadata for UI (“moved for reach”).
 */
export const suggestForRegionDetailed = (
    region: RecognizedRegion,
    keepWritten: boolean,
    handSpan: HandSpan = 'standard',
    options: SuggestForRegionOptions = {},
): SuggestForRegionResult => {
    const k = Math.max(1, options.k ?? 1);
    if (region.notes.length === 0) {
        return {
            sequences: { L: null, R: null },
            fingeringHand: new Map(),
            movedNoteIds: [],
            fingerById: new Map(),
            alternatives: [],
        };
    }
    const { hands, movedIds } = fingeringHandsForRegion(region, handSpan);
    const { primary, ranked } = buildSequencesForHands(region, hands, keepWritten, handSpan, k);
    const fingerById = fingerByIdFromSequences(primary);
    const alternatives = ranked
        .map((sequences) => ({ sequences, fingerById: fingerByIdFromSequences(sequences) }))
        .filter((alt) => !fingerMapsEqual(alt.fingerById, fingerById))
        .slice(0, Math.max(0, k - 1));
    return {
        sequences: primary,
        fingeringHand: hands,
        movedNoteIds: movedIds,
        fingerById,
        alternatives,
    };
};

/**
 * Suggested fingerings for a reviewed region, per hand. `keepWritten` pins
 * fingerings already on (or entered for) the score and optimizes around them.
 * Unplayable same-onset packs are split low→L / high→R before the DP runs.
 */
export const suggestForRegion = (
    region: RecognizedRegion,
    keepWritten: boolean,
    handSpan: HandSpan = 'standard',
): Record<Hand, FingeringSequence | null> => suggestForRegionDetailed(region, keepWritten, handSpan).sequences;
