import { describe, expect, it } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import {
    beatsForMeasure,
    countInSpec,
    firstNoteIndexAtOrAfter,
    fractionWithinMeasure,
    measureEndTick,
    measureIndexAtTick,
    measureStartTick,
    secondsPerTick,
    stepMeasure,
    ticksPerBeat,
    timeSigAt,
} from '@/features/playback/scoreTime';
import { parseScoreData } from '@/types/scoreData';

const { measures, notes, timeSignatures } = tinyScore;

describe('tinyScore fixture', () => {
    it('round-trips through parseScoreData', () => {
        expect(parseScoreData(JSON.parse(JSON.stringify(tinyScore)))).toEqual(tinyScore);
    });

    it('is rejected when malformed or future-versioned', () => {
        expect(parseScoreData({ nope: true })).toBeNull();
        expect(parseScoreData({ ...tinyScore, version: 99 })).toBeNull();
    });
});

describe('secondsPerTick / ticksPerBeat', () => {
    it('maps 120 bpm to 480 ticks per half second', () => {
        expect(secondsPerTick(120) * 480).toBeCloseTo(0.5);
    });

    it('derives beat lengths from the denominator', () => {
        expect(ticksPerBeat(4)).toBe(480);
        expect(ticksPerBeat(8)).toBe(240);
        expect(ticksPerBeat(2)).toBe(960);
    });
});

describe('timeSigAt', () => {
    it('returns the signature in effect at a tick', () => {
        expect(timeSigAt(timeSignatures, 0).num).toBe(4);
        expect(timeSigAt(timeSignatures, 8159).num).toBe(4);
        expect(timeSigAt(timeSignatures, 8160).num).toBe(6);
        expect(timeSigAt(timeSignatures, 99999).den).toBe(8);
    });

    it('falls back to 4/4 for an empty list', () => {
        expect(timeSigAt([], 100)).toEqual({ tick: 0, num: 4, den: 4 });
    });
});

describe('measureIndexAtTick', () => {
    it('finds the containing measure at starts, interiors, and boundaries', () => {
        expect(measureIndexAtTick(measures, 0)).toBe(0);
        expect(measureIndexAtTick(measures, 479)).toBe(0);
        expect(measureIndexAtTick(measures, 480)).toBe(1); // barline belongs to the next measure
        expect(measureIndexAtTick(measures, 5000)).toBe(3);
        expect(measureIndexAtTick(measures, 12480)).toBe(8);
    });

    it('clamps out-of-range ticks', () => {
        expect(measureIndexAtTick(measures, -50)).toBe(0);
        expect(measureIndexAtTick(measures, 999999)).toBe(8);
    });

    it('returns -1 for an empty score', () => {
        expect(measureIndexAtTick([], 100)).toBe(-1);
    });
});

describe('fractionWithinMeasure', () => {
    it('interpolates and clamps', () => {
        const m1 = measures[1];
        if (!m1) {
            throw new Error('fixture missing measure');
        }
        expect(fractionWithinMeasure(m1, 480)).toBe(0);
        expect(fractionWithinMeasure(m1, 480 + 960)).toBeCloseTo(0.5);
        expect(fractionWithinMeasure(m1, 99999)).toBe(1);
        expect(fractionWithinMeasure(m1, 0)).toBe(0);
    });
});

describe('stepMeasure', () => {
    it('steps forward to the next barline', () => {
        expect(stepMeasure(measures, 0, 1)).toBe(480);
        expect(stepMeasure(measures, 500, 1)).toBe(2400);
    });

    it('stays on the last measure when stepping past the end', () => {
        expect(stepMeasure(measures, 13000, 1)).toBe(12480);
    });

    it('returns to the current start when >20% in, else the previous measure', () => {
        expect(stepMeasure(measures, 480 + 1000, -1)).toBe(480); // deep into m1 → m1 start
        expect(stepMeasure(measures, 480 + 100, -1)).toBe(0); // near m1 start → m0
        expect(stepMeasure(measures, 100, -1)).toBe(0); // m0 has no predecessor
    });

    it('handles empty measures', () => {
        expect(stepMeasure([], 100, 1)).toBe(0);
    });
});

describe('firstNoteIndexAtOrAfter', () => {
    it('is a lower bound over note start ticks', () => {
        expect(firstNoteIndexAtOrAfter(notes, 0)).toBe(0);
        expect(firstNoteIndexAtOrAfter(notes, 1)).toBe(1);
        expect(firstNoteIndexAtOrAfter(notes, 480)).toBe(1);
        expect(firstNoteIndexAtOrAfter(notes, 999999)).toBe(notes.length);
    });
});

describe('beatsForMeasure', () => {
    it('produces 4 quarter beats in a 4/4 measure', () => {
        const m1 = measures[1];
        if (!m1) {
            throw new Error('fixture missing measure');
        }
        expect(beatsForMeasure(m1, timeSignatures)).toEqual([480, 960, 1440, 1920]);
    });

    it('produces 6 eighth beats in a 6/8 measure', () => {
        const m5 = measures[5];
        if (!m5) {
            throw new Error('fixture missing measure');
        }
        expect(beatsForMeasure(m5, timeSignatures)).toHaveLength(6);
        expect(beatsForMeasure(m5, timeSignatures)[0]).toBe(8160);
    });

    it('truncates beats to a short pickup measure', () => {
        const pickup = measures[0];
        if (!pickup) {
            throw new Error('fixture missing measure');
        }
        expect(beatsForMeasure(pickup, timeSignatures)).toEqual([0]);
    });
});

describe('countInSpec', () => {
    it('is one full measure of the active time signature', () => {
        expect(countInSpec(tinyScore, 0)).toEqual({ beats: 4, beatTicks: 480 });
        expect(countInSpec(tinyScore, 8160)).toEqual({ beats: 6, beatTicks: 240 });
    });
});

describe('measureStartTick / measureEndTick', () => {
    it('clamps indices to the score', () => {
        expect(measureStartTick(measures, 1)).toBe(480);
        expect(measureStartTick(measures, -5)).toBe(0);
        expect(measureStartTick(measures, 99)).toBe(12480);
        expect(measureEndTick(measures, 8)).toBe(13920);
        expect(measureEndTick(measures, 99)).toBe(13920);
    });
});
