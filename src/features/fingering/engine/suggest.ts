import { solve, type DpEvent } from '@/features/fingering/engine/dp';
import type { HandSpan } from '@/features/fingering/engine/span';
import {
    buildSequences,
    isBlackKey,
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
}

export interface EngineResult {
    sequence: FingeringSequence;
    /** Note ids whose pins were unplayable and got ignored. */
    ignoredPinNoteIds: string[];
}

export const suggestFingerings = (input: EngineInput): EngineResult => {
    const mirror = input.hand === 'L';

    const dpEvents: DpEvent[] = input.events.map((event) => {
        // Right-hand geometry: ascending DP pitches. Mirroring negates midis,
        // which reverses the ascending order.
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

    const { assignments, ignoredPinEvents } = solve(dpEvents, input.handSpan ?? 'standard');

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

    const ignoredPinNoteIds = ignoredPinEvents.flatMap((i) =>
        (input.events[i]?.noteIds ?? []).filter((id) => input.pins?.has(id)),
    );

    return {
        sequence: { hand: input.hand, events, source: 'suggested' },
        ignoredPinNoteIds,
    };
};

/**
 * Suggested fingerings for a reviewed region, per hand. `keepWritten` pins
 * fingerings already on (or entered for) the score and optimizes around them.
 */
export const suggestForRegion = (
    region: RecognizedRegion,
    keepWritten: boolean,
    handSpan: HandSpan = 'standard',
): Record<Hand, FingeringSequence | null> => {
    const annotated = buildSequences(region);
    const result: Record<Hand, FingeringSequence | null> = { L: null, R: null };
    for (const hand of ['L', 'R'] as const) {
        const sequence = annotated[hand];
        if (!sequence) {
            continue;
        }
        const pins = keepWritten
            ? new Map(
                  region.notes
                      .filter((n) => region.handOf[n.staff] === hand && n.annotatedFinger !== null)
                      .map((n) => [n.id, n.annotatedFinger as Finger]),
              )
            : undefined;
        result[hand] = suggestFingerings({
            hand,
            events: sequence.events.map((event) => ({
                index: event.index,
                noteIds: event.notes.map((n) => n.noteId),
                midis: event.notes.map((n) => n.midi),
            })),
            pins,
            handSpan,
        }).sequence;
    }
    return result;
};
