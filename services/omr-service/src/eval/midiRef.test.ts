import { describe, expect, it } from 'vitest';

import type { CorpusMovement } from './manifest.js';
import { notesFromMidi, parseSmfForTest } from './midiRef.js';

const vlq = (n: number): number[] => {
    const bytes: number[] = [n & 0x7f];
    let rest = n >> 7;
    while (rest > 0) {
        bytes.unshift((rest & 0x7f) | 0x80);
        rest >>= 7;
    }
    return bytes;
};

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

const track = (events: number[]): number[] => {
    const body = [...events, 0, 0xff, 0x2f, 0];
    return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
};

const smf = (tpq: number, tracks: number[][]): Buffer => {
    const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(tpq)];
    return Buffer.from([...header, ...tracks.flat()]);
};

const nameEvent = (name: string): number[] => [0, 0xff, 0x03, name.length, ...Buffer.from(name, 'ascii')];
const on = (delta: number, pitch: number, vel = 80): number[] => [...vlq(delta), 0x90, pitch, vel];
const off = (delta: number, pitch: number): number[] => [...vlq(delta), 0x80, pitch, 0];

const MOVEMENT: CorpusMovement = {
    name: 'test',
    midi: 't.mid',
    meter: { num: 3, den: 4 },
    pickupQuarters: 1,
    printedBars: 3,
    expectedFifths: 0,
    expectedTempo: { min: 60, max: 120 },
    repeatsUnfoldedInMidi: false,
    expectedHolds: 0,
    expectedExtraNotes: 0,
};

describe('midiRef', () => {
    it('parses running status and track names', () => {
        const tpq = 96;
        const buf = smf(tpq, [
            track([
                ...nameEvent('up'),
                ...on(0, 60),
                48,
                62,
                80,
                ...off(48, 60),
                ...off(0, 62),
            ]),
            track([...nameEvent('down'), ...on(0, 48), ...off(tpq, 48)]),
        ]);
        const parsed = parseSmfForTest(buf);
        expect(parsed.tpq).toBe(96);
        expect(parsed.trackNames).toEqual(['up', 'down']);
        expect(parsed.notes).toEqual([
            { tick: 0, dur: 96, pitch: 60, hand: 0 },
            { tick: 48, dur: 48, pitch: 62, hand: 0 },
            { tick: 0, dur: 96, pitch: 48, hand: 1 },
        ]);
    });

    it('places a pickup note in bar 0 and the next beat in bar 1', () => {
        const tpq = 480;
        const buf = smf(tpq, [
            track([
                ...nameEvent('up'),
                ...on(0, 72),
                ...off(tpq, 72),
                ...on(0, 74),
                ...off(tpq * 3, 74),
            ]),
        ]);
        const notes = notesFromMidi(buf, MOVEMENT);
        expect(notes).toHaveLength(2);
        expect(notes[0]).toMatchObject({ bar: 0, onsetQ: 2, pitch: 72, hand: 0 });
        expect(notes[1]).toMatchObject({ bar: 1, onsetQ: 0, pitch: 74, hand: 0 });
    });
});
