import { describe, expect, it } from 'vitest';

import {
    buildSequences,
    clampMidi,
    emptyRegion,
    groupIntoEvents,
    isBlackKey,
    mergedEventIndices,
    midiToName,
    pressedAtIndex,
    type RecognizedNote,
    type RecognizedRegion,
} from '@/features/fingering/model';

const note = (overrides: Partial<RecognizedNote>): RecognizedNote => ({
    id: overrides.id ?? crypto.randomUUID(),
    midi: 60,
    name: 'C4',
    staff: 'upper',
    bbox: { x: 0, y: 0, w: 0, h: 0 },
    eventIndex: 0,
    annotatedFinger: null,
    fingerSource: null,
    confidence: 'high',
    ...overrides,
});

describe('midiToName', () => {
    it('spells middle C and octaves', () => {
        expect(midiToName(60)).toBe('C4');
        expect(midiToName(21)).toBe('A0');
        expect(midiToName(108)).toBe('C8');
    });

    it('uses sharps in sharp keys and flats in flat keys', () => {
        expect(midiToName(61, 2)).toBe('C#4');
        expect(midiToName(61, -2)).toBe('Db4');
        expect(midiToName(70, -1)).toBe('Bb4');
        expect(midiToName(70, 0)).toBe('A#4');
    });
});

describe('clampMidi / isBlackKey', () => {
    it('clamps to the piano range and rounds', () => {
        expect(clampMidi(10)).toBe(21);
        expect(clampMidi(200)).toBe(108);
        expect(clampMidi(60.4)).toBe(60);
    });

    it('identifies black keys', () => {
        expect(isBlackKey(60)).toBe(false); // C
        expect(isBlackKey(61)).toBe(true); // C#
        expect(isBlackKey(66)).toBe(true); // F#
        expect(isBlackKey(71)).toBe(false); // B
    });
});

describe('groupIntoEvents', () => {
    it('clusters notes by x-center into simultaneity groups', () => {
        const notes = [
            note({ midi: 60, bbox: { x: 0.1, y: 0.2, w: 0.02, h: 0.01 } }),
            note({ midi: 64, bbox: { x: 0.101, y: 0.18, w: 0.02, h: 0.01 } }), // chord with first
            note({ midi: 67, bbox: { x: 0.2, y: 0.16, w: 0.02, h: 0.01 } }), // clearly later
        ];
        const grouped = groupIntoEvents(notes);
        expect(grouped[0]?.eventIndex).toBe(0);
        expect(grouped[1]?.eventIndex).toBe(0);
        expect(grouped[2]?.eventIndex).toBe(1);
    });

    it('is deterministic and does not mutate the input', () => {
        const notes = [
            note({ midi: 60, bbox: { x: 0.3, y: 0, w: 0.02, h: 0.01 }, eventIndex: 7 }),
            note({ midi: 62, bbox: { x: 0.1, y: 0, w: 0.02, h: 0.01 }, eventIndex: 7 }),
        ];
        const grouped = groupIntoEvents(notes);
        // Re-indexed left-to-right, originals untouched.
        expect(grouped.map((n) => n.eventIndex)).toEqual([0, 1]);
        expect(grouped[0]?.midi).toBe(62);
        expect(notes[0]?.eventIndex).toBe(7);
    });
});

const regionWith = (notes: RecognizedNote[], overrides?: Partial<RecognizedRegion>): RecognizedRegion => ({
    ...emptyRegion('doc', 0, { x: 0, y: 0, w: 1, h: 1 }),
    notes,
    ...overrides,
});

describe('buildSequences', () => {
    it('partitions by staff→hand and sorts chord notes by ascending midi', () => {
        const region = regionWith([
            note({ id: 'a', midi: 67, staff: 'upper', eventIndex: 0, annotatedFinger: 5 }),
            note({ id: 'b', midi: 60, staff: 'upper', eventIndex: 0, annotatedFinger: 1 }),
            note({ id: 'c', midi: 48, staff: 'lower', eventIndex: 0, annotatedFinger: 5 }),
        ]);
        const seqs = buildSequences(region);
        expect(seqs.R?.events).toHaveLength(1);
        expect(seqs.R?.events[0]?.notes.map((n) => n.midi)).toEqual([60, 67]);
        expect(seqs.R?.events[0]?.notes.map((n) => n.finger)).toEqual([1, 5]);
        expect(seqs.L?.events[0]?.notes.map((n) => n.midi)).toEqual([48]);
        expect(seqs.R?.source).toBe('annotated');
    });

    it('respects a swapped hand mapping', () => {
        const region = regionWith([note({ midi: 60, staff: 'upper' })], {
            handOf: { upper: 'L', lower: 'R' },
        });
        const seqs = buildSequences(region);
        expect(seqs.L?.events[0]?.notes[0]?.midi).toBe(60);
        expect(seqs.R).toBeNull();
    });

    it('orders events left-to-right by notehead x, falling back to eventIndex', () => {
        const region = regionWith([
            note({ midi: 60, eventIndex: 2, bbox: { x: 0.1, y: 0, w: 0.02, h: 0.01 } }),
            note({ midi: 62, eventIndex: 1, bbox: { x: 0.5, y: 0, w: 0.02, h: 0.01 } }),
        ]);
        const seqs = buildSequences(region);
        expect(seqs.R?.events.map((e) => e.index)).toEqual([2, 1]);

        // No bboxes (manual entry) → eventIndex order.
        const manual = regionWith([note({ midi: 60, eventIndex: 1 }), note({ midi: 62, eventIndex: 0 })]);
        expect(buildSequences(manual).R?.events.map((e) => e.index)).toEqual([0, 1]);
    });
});

describe('mergedEventIndices / pressedAtIndex', () => {
    it('merges both hands at a shared step', () => {
        const region = regionWith([
            note({ midi: 60, staff: 'upper', eventIndex: 0, annotatedFinger: 1 }),
            note({ midi: 48, staff: 'lower', eventIndex: 0, annotatedFinger: 5 }),
            note({ midi: 62, staff: 'upper', eventIndex: 1 }),
        ]);
        const indices = mergedEventIndices(region);
        expect(indices).toEqual([0, 1]);
        const seqs = buildSequences(region);
        const pressed = pressedAtIndex(seqs, 0);
        expect(pressed).toEqual([
            { midi: 48, finger: 5, hand: 'L' },
            { midi: 60, finger: 1, hand: 'R' },
        ]);
        expect(pressedAtIndex(seqs, 1)).toEqual([{ midi: 62, finger: null, hand: 'R' }]);
    });
});
