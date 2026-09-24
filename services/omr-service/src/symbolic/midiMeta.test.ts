import { describe, expect, it } from 'vitest';

import { meterFromMidi, pickupQuartersFromMidi, timeSignaturesFromMidi } from './midiMeta.js';
import { synthQuantizedMidi } from './midiSynth.js';

describe('timeSignaturesFromMidi', () => {
    it('reads the FF 58 meter the file was written in', () => {
        const midi = synthQuantizedMidi({
            meter: { num: 6, den: 8 },
            pickupQuarters: 0,
            printedBars: 4,
            fifths: 0,
            pitches: [60],
        });
        expect(timeSignaturesFromMidi(midi)).toEqual([{ tick: 0, num: 6, den: 8 }]);
        expect(meterFromMidi(midi)).toEqual({ num: 6, den: 8 });
    });

    it('returns nothing for bytes that are not a Standard MIDI File', () => {
        expect(timeSignaturesFromMidi(Buffer.from('%PDF-1.4'))).toEqual([]);
        expect(meterFromMidi(Buffer.from('%PDF-1.4'))).toBeNull();
    });
});

describe('pickupQuartersFromMidi', () => {
    it.each([
        [{ num: 3, den: 8 }, 0.5],
        [{ num: 3, den: 4 }, 1],
        [{ num: 4, den: 4 }, 3],
        [{ num: 2, den: 2 }, 1],
        [{ num: 4, den: 4 }, 0],
    ])('recovers a %o pickup of %d quarters', (meter, pickupQuarters) => {
        const midi = synthQuantizedMidi({ meter, pickupQuarters, printedBars: 10, fifths: 0, pitches: [60, 64] });
        expect(pickupQuartersFromMidi(midi, meter)).toBe(pickupQuarters);
    });
});
