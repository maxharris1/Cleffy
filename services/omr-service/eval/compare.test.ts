import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeMidi } from 'midi-file';
import { describe, expect, it } from 'vitest';

import {
    alignBars,
    compareScore,
    referenceBars,
    scoreBars,
    splitAtNumberRestarts,
    type PitchBag,
    type ReferenceBar,
    type ScoreBar,
} from './compare.js';

const bag = (...pitches: number[]): PitchBag => {
    const out: PitchBag = new Map();
    for (const p of pitches) {
        out.set(p, (out.get(p) ?? 0) + 1);
    }
    return out;
};

const ref = (n: number, ...pitches: number[]): ReferenceBar => ({ n, pitches: bag(...pitches) });
const sb = (index: number, ...pitches: number[]): ScoreBar => ({ index, n: index + 1, pitches: bag(...pitches) });

/** A one-track MIDI of quarter notes at 480 ticks per beat: `[tick, pitch]` pairs. */
const midiOf = (events: Array<[number, number]>): Buffer => {
    const sorted = [...events].sort((a, b) => a[0] - b[0]);
    const track: Array<Record<string, unknown>> = [];
    let last = 0;
    for (const [tick, pitch] of sorted) {
        track.push({ deltaTime: tick - last, type: 'noteOn', channel: 0, noteNumber: pitch, velocity: 80 });
        track.push({ deltaTime: 0, type: 'noteOff', channel: 0, noteNumber: pitch, velocity: 0 });
        last = tick;
    }
    track.push({ deltaTime: 0, type: 'endOfTrack', meta: true });
    return Buffer.from(writeMidi({ header: { format: 1, numTracks: 1, ticksPerBeat: 480 }, tracks: [track as never] }));
};

describe('referenceBars', () => {
    it('bins note-ons into bars after an optional pickup', () => {
        const midi = midiOf([
            [0, 60],
            [480, 62],
            [960, 64],
            [1920, 65],
        ]);
        const plain = referenceBars(midi, { beats: 2, pickupBeats: 0 });
        expect(plain.map((b) => [b.n, [...b.pitches.keys()]])).toEqual([
            [1, [60, 62]],
            [2, [64]],
            [3, [65]],
        ]);
        const pickup = referenceBars(midi, { beats: 2, pickupBeats: 1 });
        expect(pickup.map((b) => [b.n, [...b.pitches.keys()]])).toEqual([
            [0, [60]],
            [1, [62, 64]],
            [2, [65]],
        ]);
    });
});

describe('scoreBars', () => {
    it('reads each engraved bar once, ignoring repeat clones', () => {
        const bars = scoreBars({
            notes: [
                { t: 0, d: 100, p: 60, h: 0 },
                { t: 500, d: 100, p: 62, h: 0 },
                { t: 1000, d: 100, p: 60, h: 0 },
            ],
            measures: [
                { n: 1, tick: 0, dTicks: 480, srcIndex: 0, page: 0, sys: 0, x0: 0, x1: 1 },
                { n: 2, tick: 480, dTicks: 480, srcIndex: 1, page: 0, sys: 0, x0: 0, x1: 1 },
                { n: 1, tick: 960, dTicks: 480, srcIndex: 0, page: 0, sys: 0, x0: 0, x1: 1 },
            ],
        });
        expect(bars).toHaveLength(2);
        expect([...(bars[0]?.pitches.keys() ?? [])]).toEqual([60]);
        expect([...(bars[1]?.pitches.keys() ?? [])]).toEqual([62]);
    });

    it('splits where printed numbers restart', () => {
        const segments = splitAtNumberRestarts([sb(0), { ...sb(1), n: 2 }, { ...sb(2), n: 1 }, { ...sb(3), n: 2 }]);
        expect(segments.map((s) => s.length)).toEqual([2, 2]);
    });

    it('does not split when a printed number repeats (69 then 69)', () => {
        const segments = splitAtNumberRestarts([
            { index: 0, n: 68, pitches: bag(60) },
            { index: 1, n: 69, pitches: bag(62) },
            { index: 2, n: 69, pitches: bag(64) },
            { index: 3, n: 1, pitches: bag(65) },
        ]);
        expect(segments.map((s) => s.map((b) => b.n))).toEqual([[68, 69, 69], [1]]);
    });
});

describe('alignBars', () => {
    it('scores a perfect transcription at 100% per bar', () => {
        const { bars } = alignBars([ref(1, 60, 64, 67), ref(2, 62, 65)], [sb(0, 60, 64, 67), sb(1, 62, 65)]);
        expect(bars.map((b) => b.match)).toEqual([1, 1]);
    });

    it('charges a wrong pitch to the bar it is in and nothing else', () => {
        const { bars } = alignBars([ref(1, 60, 64, 67), ref(2, 62, 65)], [sb(0, 60, 63, 67), sb(1, 62, 65)]);
        expect(bars.map((b) => b.match)).toEqual([2 / 3, 1]);
    });

    it('absorbs a merged bar without dragging later bars off', () => {
        // Bars 2 and 3 were read as one; bar 4 must still line up with bar 4.
        const reference = [ref(1, 60), ref(2, 62, 62), ref(3, 64, 64), ref(4, 65, 65, 65)];
        const score = [sb(0, 60), sb(1, 62, 62, 64, 64), sb(2, 65, 65, 65)];
        const { bars, extra } = alignBars(reference, score);
        expect(extra).toBe(0);
        expect(bars.map((b) => b.match)).toEqual([1, 1, 1, 1]);
        expect(bars[1]?.aligned.map((s) => s.index)).toEqual([1]);
        expect(bars[2]?.aligned.map((s) => s.index)).toEqual([1]);
        expect(bars[3]?.aligned.map((s) => s.index)).toEqual([2]);
    });

    it('absorbs a split bar', () => {
        const reference = [ref(1, 60), ref(2, 62, 64), ref(3, 65)];
        const score = [sb(0, 60), sb(1, 62), sb(2, 64), sb(3, 65)];
        const { bars } = alignBars(reference, score);
        expect(bars.map((b) => b.match)).toEqual([1, 1, 1]);
        expect(bars[1]?.aligned.map((s) => s.index)).toEqual([1, 2]);
    });

    it('scores a merge at 100% on pitch-bag union with no onset or duration check', () => {
        const reference = [ref(1, 60, 64), ref(2, 62, 67)];
        const score = [sb(0, 67, 64, 62, 60)];
        const { bars } = alignBars(reference, score);
        expect(bars.map((b) => b.match)).toEqual([1, 1]);
    });

    it('reports a bar the transcription lost entirely as missing', () => {
        const reference = [ref(1, 60), ref(2, 62), ref(3, 64)];
        const score = [sb(0, 60), sb(1, 64)];
        const { bars } = alignBars(reference, score);
        expect(bars.map((b) => b.match)).toEqual([1, 0, 1]);
        expect(bars[1]?.aligned).toEqual([]);
    });
});

describe('compareScore', () => {
    it('aligns movement by movement when the numbers restart between them', () => {
        const first = midiOf([
            [0, 60],
            [480, 62],
        ]);
        const second = midiOf([
            [0, 70],
            [480, 72],
        ]);
        const result = compareScore({
            score: {
                notes: [
                    { t: 0, d: 10, p: 60, h: 0 },
                    { t: 480, d: 10, p: 62, h: 0 },
                    { t: 960, d: 10, p: 70, h: 0 },
                    { t: 1440, d: 10, p: 71, h: 0 },
                ],
                measures: [
                    { n: 1, tick: 0, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 },
                    { n: 2, tick: 480, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 },
                    { n: 1, tick: 960, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 },
                    { n: 2, tick: 1440, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 },
                ],
            },
            movements: [
                { boundary: { name: 'I', midi: 'a', beats: 1, pickupBeats: 0 }, midi: first },
                { boundary: { name: 'II', midi: 'b', beats: 1, pickupBeats: 0 }, midi: second },
            ],
        });
        expect(result.movements.map((m) => [m.name, m.passing, m.bars.length, m.gated])).toEqual([
            ['I', 2, 2, true],
            ['II', 1, 2, true],
        ]);
        expect(result.pass).toBe(false);
    });

    it('does not fail the run on an ungated movement', () => {
        const first = midiOf([
            [0, 60],
            [480, 62],
        ]);
        const second = midiOf([
            [0, 70],
            [480, 72],
        ]);
        const result = compareScore({
            score: {
                notes: [
                    { t: 0, d: 10, p: 60, h: 0 },
                    { t: 480, d: 10, p: 62, h: 0 },
                    { t: 960, d: 10, p: 70, h: 0 },
                    { t: 1440, d: 10, p: 71, h: 0 },
                ],
                measures: [
                    { n: 1, tick: 0, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 },
                    { n: 2, tick: 480, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 },
                    { n: 1, tick: 960, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 },
                    { n: 2, tick: 1440, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 },
                ],
            },
            movements: [
                { boundary: { name: 'I', midi: 'a', beats: 1, pickupBeats: 0, gated: true }, midi: first },
                { boundary: { name: 'II', midi: 'b', beats: 1, pickupBeats: 0, gated: false }, midi: second },
            ],
        });
        expect(result.movements.map((m) => m.gated)).toEqual([true, false]);
        expect(result.pass).toBe(true);
    });

    it('pins movements by lo/hi when printed numbers do not restart', () => {
        const first = midiOf([[0, 60]]);
        const second = midiOf([[0, 70]]);
        const result = compareScore({
            score: {
                notes: [
                    { t: 0, d: 10, p: 60, h: 0 },
                    { t: 480, d: 10, p: 70, h: 0 },
                ],
                measures: [
                    { n: 69, tick: 0, dTicks: 480, srcIndex: 0, page: 0, sys: 0, x0: 0, x1: 1 },
                    { n: 69, tick: 480, dTicks: 480, srcIndex: 1, page: 0, sys: 0, x0: 0, x1: 1 },
                ],
            },
            movements: [
                { boundary: { name: 'I', midi: 'a', beats: 1, pickupBeats: 0, lo: 0, hi: 0 }, midi: first },
                { boundary: { name: 'II', midi: 'b', beats: 1, pickupBeats: 0, lo: 1, hi: 1 }, midi: second },
            ],
        });
        expect(result.movements.map((m) => [m.name, m.passing, m.bars.length])).toEqual([
            ['I', 1, 1],
            ['II', 1, 1],
        ]);
        expect(result.pass).toBe(true);
    });
});

describe('moonlight Mutopia fixtures', () => {
    const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'moonlight');

    it('opens the committed MIDIs and matches the recorded bar counts', () => {
        const boundaries = JSON.parse(readFileSync(join(fixtures, 'boundaries.json'), 'utf8')) as Array<{
            name: string;
            midi: string;
            beats: number;
            pickupBeats: number;
            lo?: number;
            hi?: number;
            gated?: boolean;
        }>;
        expect(boundaries.map((b) => [b.name, b.lo, b.hi, b.gated])).toEqual([
            ['I. Adagio sostenuto', 0, 68, true],
            ['II. Allegretto', 69, 128, false],
            ['III. Presto agitato', 129, 329, false],
        ]);
        const counts = boundaries.map((boundary) =>
            referenceBars(readFileSync(join(fixtures, boundary.midi)), boundary).length,
        );
        expect(counts).toEqual([69, 60, 201]);
    });
});
