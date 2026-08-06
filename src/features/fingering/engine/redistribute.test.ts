import { describe, expect, it } from 'vitest';

import { isFingerableChord } from '@/features/fingering/engine/chords';
import { redistributeEventHands } from '@/features/fingering/engine/redistribute';
import { suggestForRegion, suggestForRegionDetailed } from '@/features/fingering/engine/suggest';
import { emptyRegion, type RecognizedNote, type RecognizedRegion } from '@/features/fingering/model';


const note = (partial: Partial<RecognizedNote> & Pick<RecognizedNote, 'id' | 'midi'>): RecognizedNote => ({
    id: partial.id,
    midi: partial.midi,
    name: partial.name ?? `n${partial.midi}`,
    staff: partial.staff ?? 'upper',
    bbox: partial.bbox ?? { x: 0, y: 0, w: 0, h: 0 },
    eventIndex: partial.eventIndex ?? 0,
    annotatedFinger: partial.annotatedFinger ?? null,
    fingerSource: partial.fingerSource ?? null,
    confidence: partial.confidence ?? 'high',
});

const regionOf = (notes: RecognizedNote[]): RecognizedRegion => ({
    ...emptyRegion('doc', 0, { x: 0, y: 0, w: 0.5, h: 0.2 }),
    notes,
    source: 'omr',
});

describe('redistributeEventHands', () => {
    it('leaves an already-playable RH triad alone', () => {
        const notes = [
            { noteId: 'a', midi: 59, hand: 'R' as const },
            { noteId: 'b', midi: 62, hand: 'R' as const },
            { noteId: 'c', midi: 66, hand: 'R' as const },
        ];
        const { hands, movedIds } = redistributeEventHands(notes, 'standard');
        expect([...hands.values()]).toEqual(['R', 'R', 'R']);
        expect(movedIds).toEqual([]);
    });

    it('peels Gymnopédie melody: triad on LH, F#5 on RH', () => {
        // OMR packed triad + high melody onto RH (19-st span).
        const notes = [
            { noteId: 'b3', midi: 59, hand: 'R' as const },
            { noteId: 'd4', midi: 62, hand: 'R' as const },
            { noteId: 'fs4', midi: 66, hand: 'R' as const },
            { noteId: 'fs5', midi: 78, hand: 'R' as const },
        ];
        expect(isFingerableChord([59, 62, 66, 78], 'R', 'standard')).toBe(false);

        const { hands, movedIds } = redistributeEventHands(notes, 'standard');
        const L = notes.filter((n) => hands.get(n.noteId) === 'L').map((n) => n.midi);
        const R = notes.filter((n) => hands.get(n.noteId) === 'R').map((n) => n.midi);
        expect(isFingerableChord(L, 'L', 'standard')).toBe(true);
        expect(isFingerableChord(R, 'R', 'standard')).toBe(true);
        expect(L.sort((a, b) => a - b)).toEqual([59, 62, 66]);
        expect(R).toEqual([78]);
        expect(movedIds.sort()).toEqual(['b3', 'd4', 'fs4']);
    });

    it('keeps an occupied LH note put when the RH pack cannot be rescued without it', () => {
        // G2 on LH + unplayable RH pack: no playable merge exists at standard span,
        // so we must not displace G2 just to try.
        const notes = [
            { noteId: 'g2', midi: 43, hand: 'L' as const },
            { noteId: 'b3', midi: 59, hand: 'R' as const },
            { noteId: 'd4', midi: 62, hand: 'R' as const },
            { noteId: 'fs4', midi: 66, hand: 'R' as const },
            { noteId: 'fs5', midi: 78, hand: 'R' as const },
        ];
        expect(isFingerableChord([59, 62, 66, 78], 'R', 'standard')).toBe(false);

        const { hands, movedIds } = redistributeEventHands(notes, 'standard');
        expect(hands.get('g2')).toBe('L');
        expect(movedIds.includes('g2')).toBe(false);
    });

    it('peels RH melody while leaving a playable LH note alone', () => {
        // C4 already on LH; RH has E4–G4–C6 (unplayable outer). Moving E+G onto L
        // yields a C major triad on L and C6 alone on R — without displacing C4.
        const notes = [
            { noteId: 'c4', midi: 60, hand: 'L' as const },
            { noteId: 'e4', midi: 64, hand: 'R' as const },
            { noteId: 'g4', midi: 67, hand: 'R' as const },
            { noteId: 'c6', midi: 84, hand: 'R' as const },
        ];
        expect(isFingerableChord([64, 67, 84], 'R', 'standard')).toBe(false);

        const { hands, movedIds } = redistributeEventHands(notes, 'standard');
        expect(hands.get('c4')).toBe('L');
        expect(movedIds.includes('c4')).toBe(false);
        const L = notes.filter((n) => hands.get(n.noteId) === 'L').map((n) => n.midi).sort((a, b) => a - b);
        const R = notes.filter((n) => hands.get(n.noteId) === 'R').map((n) => n.midi).sort((a, b) => a - b);
        expect(isFingerableChord(L, 'L', 'standard')).toBe(true);
        expect(isFingerableChord(R, 'R', 'standard')).toBe(true);
        expect(L).toEqual([60, 64, 67]);
        expect(R).toEqual([84]);
    });

    it('returns the original when no pitch split is playable', () => {
        const notes = [36, 48, 60, 72, 84, 96].map((midi, i) => ({
            noteId: `n${i}`,
            midi,
            hand: 'R' as const,
        }));
        const { hands, movedIds } = redistributeEventHands(notes, 'standard');
        expect([...hands.values()].every((h) => h === 'R')).toBe(true);
        expect(movedIds).toEqual([]);
    });
});

describe('suggestForRegion redistribution', () => {
    it('fingers the Gymnopédie RH pack with triad→L and melody→R', () => {
        const region = regionOf([
            note({ id: 'b3', midi: 59, name: 'B3' }),
            note({ id: 'd4', midi: 62, name: 'D4' }),
            note({ id: 'fs4', midi: 66, name: 'F#4' }),
            note({ id: 'fs5', midi: 78, name: 'F#5' }),
        ]);
        const detailed = suggestForRegionDetailed(region, false, 'standard');
        const fingers = [
            ...(detailed.sequences.L?.events[0]?.notes ?? []),
            ...(detailed.sequences.R?.events[0]?.notes ?? []),
        ].map((n) => n.finger);
        expect(fingers.length).toBe(4);
        expect(fingers.every((f) => f !== null)).toBe(true);
        expect(detailed.sequences.L?.events[0]?.notes.map((n) => n.midi)).toEqual([59, 62, 66]);
        expect(detailed.sequences.R?.events[0]?.notes.map((n) => n.midi)).toEqual([78]);
        expect(detailed.movedNoteIds.sort()).toEqual(['b3', 'd4', 'fs4']);
    });

    it('still fingers a normal RH triad without inventing a left hand', () => {
        const region = regionOf([
            note({ id: 'c', midi: 60 }),
            note({ id: 'e', midi: 64 }),
            note({ id: 'g', midi: 67 }),
        ]);
        const suggested = suggestForRegion(region, false, 'standard');
        expect(suggested.L).toBeNull();
        expect(suggested.R?.events[0]?.notes.map((n) => n.finger)).toEqual([1, 3, 5]);
    });
});
