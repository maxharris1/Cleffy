import { isFingerableChord } from '@/features/fingering/engine/chords';
import type { HandSpan } from '@/features/fingering/engine/span';
import type { Finger, FingeringSequence, Hand } from '@/features/fingering/model';

/**
 * Eval helpers for fingering quality: match rate vs ground truth (Nakamura-style
 * multi-annotator OR) and an IFR-inspired irrational fingering rate.
 */

export interface FingerLabeledNote {
    noteId: string;
    finger: Finger | null;
}

/** Exact finger match rate in [0, 1]. Empty predicted → 0. */
export const matchRate = (
    predicted: readonly FingerLabeledNote[],
    truths: readonly (readonly FingerLabeledNote[])[],
): number => {
    if (predicted.length === 0) {
        return 0;
    }
    if (truths.length === 0) {
        return 0;
    }
    let hits = 0;
    for (const p of predicted) {
        const ok = truths.some((truth) => {
            const t = truth.find((n) => n.noteId === p.noteId);
            return t !== undefined && t.finger !== null && t.finger === p.finger;
        });
        if (ok) {
            hits += 1;
        }
    }
    return hits / predicted.length;
};

export interface IfrNote {
    noteId: string;
    midi: number;
    hand: Hand;
    finger: Finger | null;
    eventIndex: number;
}

/**
 * Fraction of notes that are irrational: null finger, or part of a same-hand
 * onset chord that fails practical span (PdF-inspired IFR).
 */
export const irrationalFingeringRate = (
    notes: readonly IfrNote[],
    handSpan: HandSpan = 'standard',
): number => {
    if (notes.length === 0) {
        return 0;
    }
    const bad = new Set<string>();
    for (const n of notes) {
        if (n.finger === null) {
            bad.add(n.noteId);
        }
    }
    const byEventHand = new Map<string, IfrNote[]>();
    for (const n of notes) {
        const key = `${n.eventIndex}:${n.hand}`;
        const group = byEventHand.get(key) ?? [];
        group.push(n);
        byEventHand.set(key, group);
    }
    for (const group of byEventHand.values()) {
        const midis = group.map((n) => n.midi);
        const hand = group[0]!.hand;
        if (!isFingerableChord(midis, hand, handSpan)) {
            for (const n of group) {
                bad.add(n.noteId);
            }
        }
    }
    return bad.size / notes.length;
};

/** Flatten suggestForRegion sequences into IFR notes. */
export const ifrNotesFromSequences = (
    sequences: Record<Hand, FingeringSequence | null>,
): IfrNote[] => {
    const out: IfrNote[] = [];
    for (const hand of ['L', 'R'] as const) {
        for (const event of sequences[hand]?.events ?? []) {
            for (const n of event.notes) {
                out.push({
                    noteId: n.noteId,
                    midi: n.midi,
                    hand,
                    finger: n.finger,
                    eventIndex: event.index,
                });
            }
        }
    }
    return out;
};
