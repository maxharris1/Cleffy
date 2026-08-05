import { describe, expect, it } from 'vitest';

import { spanRange, withinPractical } from '@/features/fingering/engine/span';
import { enumerateStates } from '@/features/fingering/engine/chords';
import { suggestFingerings, type EngineInput } from '@/features/fingering/engine/suggest';
import type { Finger, Hand } from '@/features/fingering/model';

/** Melodic input: one note per event. */
const melody = (hand: Hand, midis: number[], pins?: ReadonlyMap<string, Finger>): EngineInput => ({
    hand,
    events: midis.map((midi, i) => ({ index: i, noteIds: [`n${i}`], midis: [midi] })),
    pins,
});

const fingersOf = (input: EngineInput): Array<number | null> =>
    suggestFingerings(input).sequence.events.flatMap((e) => e.notes.map((n) => n.finger));

const chord = (hand: Hand, midis: number[]): EngineInput => ({
    hand,
    events: [{ index: 0, noteIds: midis.map((_, i) => `c${i}`), midis }],
});

describe('golden fingerings — scales', () => {
    it('RH C major, one octave ascending: 1 2 3 1 2 3 4 5', () => {
        expect(fingersOf(melody('R', [60, 62, 64, 65, 67, 69, 71, 72]))).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
    });

    it('RH C major, TWO octaves — the loop crossing, never a pass around 5', () => {
        expect(
            fingersOf(melody('R', [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84])),
        ).toEqual([1, 2, 3, 1, 2, 3, 4, 1, 2, 3, 1, 2, 3, 4, 5]);
    });

    it('LH C major, one octave ascending: 5 4 3 2 1 3 2 1', () => {
        expect(fingersOf(melody('L', [48, 50, 52, 53, 55, 57, 59, 60]))).toEqual([5, 4, 3, 2, 1, 3, 2, 1]);
    });

    it('RH F major keeps the thumb off Bb: 1 2 3 4 1 2 3 4', () => {
        expect(fingersOf(melody('R', [65, 67, 69, 70, 72, 74, 76, 77]))).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
    });

    it('RH Bb major, two octaves — the RCM print, both octaves', () => {
        expect(
            fingersOf(melody('R', [70, 72, 74, 75, 77, 79, 81, 82, 84, 86, 87, 89, 91, 93, 94])),
        ).toEqual([2, 1, 2, 3, 1, 2, 3, 4, 1, 2, 3, 1, 2, 3, 4]);
    });

    it('RH Db major: 2 3 1 2 3 4 1 2 (thumb on C and F only)', () => {
        expect(fingersOf(melody('R', [61, 63, 65, 66, 68, 70, 72, 73]))).toEqual([2, 3, 1, 2, 3, 4, 1, 2]);
    });

    it('RH F# major, two octaves — thumb on B and E# in the loop', () => {
        const fingers = fingersOf(melody('R', [66, 68, 70, 71, 73, 75, 77, 78, 80, 82, 83, 85, 87, 89, 90]));
        // The mid-scale loop is canonical (2 3 4 1 2 3 1 | 2 3 4 1 2 3);
        // only the final two notes may take the terminal-fragment 4-5 ending.
        expect(fingers.slice(0, 13)).toEqual([2, 3, 4, 1, 2, 3, 1, 2, 3, 4, 1, 2, 3]);
    });

    it('LH Bb major: 3 2 1 4 3 2 1 … with the canonical interior across octaves', () => {
        const twoOctaves = fingersOf(melody('L', [34, 36, 38, 39, 41, 43, 45, 46, 48, 50, 51, 53, 55, 57, 58]));
        // Print fingering is 3 2 1 4 3 2 1 3 repeating; the very last note of a
        // terminal fragment may relax to 2 — everything else must be exact.
        expect(twoOctaves.slice(0, 14)).toEqual([3, 2, 1, 4, 3, 2, 1, 3, 2, 1, 4, 3, 2, 1]);
    });

    it('RH C major descending mirrors the ascent: 5 4 3 2 1 3 2 1', () => {
        expect(fingersOf(melody('R', [72, 71, 69, 67, 65, 64, 62, 60]))).toEqual([5, 4, 3, 2, 1, 3, 2, 1]);
    });
});

describe('golden fingerings — chords and arpeggios', () => {
    it('RH C major triad C-E-G: 1-3-5', () => {
        expect(fingersOf(chord('R', [60, 64, 67]))).toEqual([1, 3, 5]);
    });

    it('RH four-note chord C-E-G-C: 1-2-3-5', () => {
        expect(fingersOf(chord('R', [60, 64, 67, 72]))).toEqual([1, 2, 3, 5]);
    });

    it('LH C major triad C-E-G: 5-3-1', () => {
        expect(fingersOf(chord('L', [48, 52, 55]))).toEqual([5, 3, 1]);
    });

    it('flat-key chords still take the thumb on black keys: Bb and Eb = 1-3-5 / 5-3-1', () => {
        // The thumb-on-black rule is for passing motion, not held shapes —
        // penalizing it in chords mis-fingers every flat-key chord (the
        // educator-review bug: Bb major came out 2-4-5).
        expect(fingersOf(chord('R', [70, 74, 77]))).toEqual([1, 3, 5]);
        expect(fingersOf(chord('R', [63, 67, 70]))).toEqual([1, 3, 5]);
        expect(fingersOf(chord('L', [58, 62, 65]))).toEqual([5, 3, 1]);
        expect(fingersOf(chord('L', [47, 50, 53]))).toEqual([5, 3, 1]);
    });

    it('octave chord: 1-5', () => {
        expect(fingersOf(chord('R', [60, 72]))).toEqual([1, 5]);
    });

    it('RH C major arpeggio C-E-G-C: 1 2 3 5', () => {
        expect(fingersOf(melody('R', [60, 64, 67, 72]))).toEqual([1, 2, 3, 5]);
    });

    it('RH G major arpeggio, two octaves: 1 2 3 1 2 3 5', () => {
        expect(fingersOf(melody('R', [67, 71, 74, 79, 83, 86, 91]))).toEqual([1, 2, 3, 1, 2, 3, 5]);
    });

    it('LH Alberti bass anchors the pinky: 5 1 3 1', () => {
        expect(fingersOf(melody('L', [48, 55, 52, 55, 48, 55, 52, 55]))).toEqual([5, 1, 3, 1, 5, 1, 3, 1]);
    });
});

describe('hand size', () => {
    it('a small hand still fingers the common shapes', () => {
        const result = suggestFingerings({
            hand: 'R',
            events: [{ index: 0, noteIds: ['a', 'b', 'c', 'd'], midis: [60, 64, 67, 72] }],
            handSpan: 'small',
        });
        expect(result.sequence.events[0]?.notes.map((n) => n.finger)).toEqual([1, 2, 3, 5]);
    });

    it('is honest about reach: a tenth is unfingerable at standard span, playable at large', () => {
        const tenth = (handSpan: 'small' | 'standard' | 'large') =>
            suggestFingerings({
                hand: 'R',
                events: [{ index: 0, noteIds: ['a', 'b'], midis: [60, 76] }],
                handSpan,
            }).sequence.events[0]?.notes.map((n) => n.finger);
        expect(tenth('standard')).toEqual([null, null]);
        expect(tenth('small')).toEqual([null, null]);
        expect(tenth('large')).toEqual([1, 5]);
    });
});

describe('pins', () => {
    it('respects a playable pinned finger and optimizes around it', () => {
        const pins = new Map<string, Finger>([['n0', 2]]);
        const fingers = fingersOf(melody('R', [60, 62, 64, 65, 67], pins));
        expect(fingers[0]).toBe(2);
        // Still injective per event and playable overall.
        expect(fingers).toHaveLength(5);
        expect(fingers.every((f) => f !== null)).toBe(true);
    });

    it('ignores an unplayable pin combination rather than failing', () => {
        // Pinning both chord notes to finger 1 is impossible (fingers are
        // strictly increasing within a chord).
        const input: EngineInput = {
            hand: 'R',
            events: [{ index: 0, noteIds: ['a', 'b'], midis: [60, 64] }],
            pins: new Map<string, Finger>([
                ['a', 1],
                ['b', 1],
            ]),
        };
        const result = suggestFingerings(input);
        expect(result.ignoredPinNoteIds.sort()).toEqual(['a', 'b']);
        const fingers = result.sequence.events[0]?.notes.map((n) => n.finger);
        expect(fingers?.[0]).not.toBeNull();
        expect(new Set(fingers).size).toBe(2);
    });
});

describe('properties', () => {
    const randomish = (seed: number, count: number, lo: number, hi: number): number[] => {
        // Deterministic LCG so the property test never flakes.
        const out: number[] = [];
        let x = seed;
        for (let i = 0; i < count; i++) {
            x = (x * 48271) % 2147483647;
            out.push(lo + (x % (hi - lo)));
        }
        return out;
    };

    it('fingers within a chord are injective and monotone with pitch', () => {
        for (const hand of ['L', 'R'] as const) {
            const result = suggestFingerings(chord(hand, [55, 59, 62, 67]));
            const notes = result.sequence.events[0]?.notes ?? [];
            const fingers = notes.map((n) => n.finger as Finger);
            expect(new Set(fingers).size).toBe(fingers.length);
            for (let i = 0; i + 1 < fingers.length; i++) {
                // RH: fingers ascend with pitch; LH: descend.
                expect(hand === 'R' ? fingers[i + 1]! > fingers[i]! : fingers[i + 1]! < fingers[i]!).toBe(true);
            }
        }
    });

    it('LH is the mirror of RH on a mirrored line', () => {
        const line = randomish(7, 12, 55, 79);
        const rh = fingersOf(melody('R', line));
        // Reflect around pitch-class E (axis ≡ 124): the one reflection that
        // maps white keys to white and black to black, so key-color costs are
        // identical and the two hands must finger the lines identically.
        const axis = 124;
        const mirrored = line.map((m) => axis - m);
        const lh = fingersOf(melody('L', mirrored));
        expect(lh).toEqual(rh);
    });

    it('every melodic line gets a complete, playable assignment', () => {
        const line = randomish(3, 20, 50, 84);
        const fingers = fingersOf(melody('R', line));
        expect(fingers).toHaveLength(20);
        expect(fingers.every((f) => f !== null && f >= 1 && f <= 5)).toBe(true);
    });

    it('unplayable chords (>5 notes) are left unfingered, neighbors still solved', () => {
        const input: EngineInput = {
            hand: 'R',
            events: [
                { index: 0, noteIds: ['a'], midis: [60] },
                { index: 1, noteIds: ['b0', 'b1', 'b2', 'b3', 'b4', 'b5'], midis: [60, 62, 64, 65, 67, 69] },
                { index: 2, noteIds: ['c'], midis: [64] },
            ],
        };
        const result = suggestFingerings(input);
        const [e0, e1, e2] = result.sequence.events;
        expect(e0?.notes[0]?.finger).not.toBeNull();
        expect(e1?.notes.every((n) => n.finger === null)).toBe(true);
        expect(e2?.notes[0]?.finger).not.toBeNull();
    });
});

describe('span table sanity', () => {
    it('is symmetric in lookup and monotone in practicality', () => {
        expect(spanRange(2, 1)).toEqual(spanRange(1, 2));
        expect(withinPractical(1, 2, 10)).toBe(true);
        expect(withinPractical(1, 2, 11)).toBe(false);
        expect(withinPractical(1, 3, -4)).toBe(true); // crossed thumb
        expect(withinPractical(3, 4, 5)).toBe(false);
    });

    it('enumerates only playable chord shapes', () => {
        // C-E-G: every returned combo must satisfy adjacent + outer spans.
        const states = enumerateStates([60, 64, 67]);
        expect(states.length).toBeGreaterThan(0);
        expect(states).toContainEqual([1, 3, 5]);
        // An octave-plus-a-sixth double is beyond every pair — no states.
        expect(enumerateStates([60, 81])).toHaveLength(0);
    });
});
