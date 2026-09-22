import { writeMidi } from 'midi-file';
import { describe, expect, it } from 'vitest';

import { concatMidiBuffers, concatParts, concatUrl, isConcatUrl } from './midiConcat.js';

const midiOf = (events: Array<[number, number]>): Buffer => {
    const track: Array<Record<string, unknown>> = [];
    let last = 0;
    for (const [tick, pitch] of events) {
        track.push({ deltaTime: tick - last, type: 'noteOn', channel: 0, noteNumber: pitch, velocity: 80 });
        track.push({ deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: pitch, velocity: 0 });
        last = tick;
    }
    track.push({ deltaTime: 0, type: 'endOfTrack', meta: true });
    return Buffer.from(writeMidi({ header: { format: 1, numTracks: 1, ticksPerBeat: 480 }, tracks: [track as never] }));
};

describe('concatMidiBuffers', () => {
    it('appends the second file after the first', () => {
        const a = midiOf([[0, 60]]);
        const b = midiOf([[0, 72]]);
        const joined = concatMidiBuffers([a, b]);
        expect(joined.length).toBeGreaterThan(a.length);
        expect(concatMidiBuffers([a]).equals(a)).toBe(true);
    });

    it('encodes a fetchable concat URL', () => {
        const url = concatUrl(['https://example.test/a.mid', 'https://example.test/b.mid']);
        expect(isConcatUrl(url)).toBe(true);
        expect(concatParts(url)).toEqual(['https://example.test/a.mid', 'https://example.test/b.mid']);
    });
});
