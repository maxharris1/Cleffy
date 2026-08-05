import { describe, expect, it } from 'vitest';

import {
    BLACK_KEY_W,
    layoutKeyboard,
    snapRange,
    WHITE_KEY_W,
} from '@/features/fingering/diagram/keyboardLayout';
import { isBlackKey } from '@/features/fingering/model';

describe('layoutKeyboard', () => {
    it('lays out one octave C4–C5 with 8 whites and 5 blacks', () => {
        const geom = layoutKeyboard(60, 72);
        expect(geom.keys.filter((k) => !k.isBlack)).toHaveLength(8);
        expect(geom.keys.filter((k) => k.isBlack)).toHaveLength(5);
        expect(geom.width).toBe(8 * WHITE_KEY_W);
    });

    it('extends black-key endpoints outward to white keys', () => {
        const geom = layoutKeyboard(61, 70); // C#4..A#4
        const midis = geom.keys.map((k) => k.midi);
        expect(Math.min(...midis)).toBe(60); // C4
        expect(Math.max(...midis)).toBe(71); // B4
    });

    it('straddles black keys over the boundary between neighboring whites', () => {
        const geom = layoutKeyboard(60, 64);
        const cSharp = geom.keys.find((k) => k.midi === 61);
        // Boundary between C (x=0..24) and D (x=24..48) is x=24.
        expect(cSharp?.x).toBe(WHITE_KEY_W - BLACK_KEY_W / 2);
    });

    it('handles reversed and clamped input', () => {
        const geom = layoutKeyboard(72, 60);
        expect(geom.keys[0]?.midi).toBe(60);
        const edge = layoutKeyboard(0, 22);
        expect(Math.min(...edge.keys.map((k) => k.midi))).toBe(21);
    });
});

describe('snapRange', () => {
    it('lands endpoints on white keys', () => {
        const range = snapRange(61, 70);
        expect(isBlackKey(range.min)).toBe(false);
        expect(isBlackKey(range.max)).toBe(false);
        expect(range.min).toBeLessThanOrEqual(61);
        expect(range.max).toBeGreaterThanOrEqual(70);
    });

    it('widens tiny ranges to at least an octave', () => {
        const range = snapRange(60, 60);
        expect(range.max - range.min).toBeGreaterThanOrEqual(12);
    });

    it('never leaves the piano', () => {
        expect(snapRange(21, 22).min).toBe(21);
        expect(snapRange(107, 108).max).toBe(108);
    });
});
