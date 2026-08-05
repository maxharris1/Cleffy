import { describe, expect, it } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import {
    beatsForMeasure,
    clickBeatTicks,
    countInClicks,
    firstNoteIndexAtOrAfter,
    fractionWithinMeasure,
    measureEndTick,
    measureIndexAtTick,
    measureStartTick,
    secondsPerTick,
    stepMeasure,
    ticksPerBeat,
    timeSigAt,
    xAtTickInMeasure,
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

describe('xAtTickInMeasure', () => {
    const withSlots = {
        n: 1,
        tick: 1000,
        dTicks: 1920,
        page: 0,
        sys: 0,
        x0: 0.2,
        x1: 0.4,
        sl: [
            { x: 0.22, t: 0 },
            { x: 0.3, t: 1440 },
        ],
    };

    it('rides the engraved chord columns, not linear time', () => {
        expect(xAtTickInMeasure(withSlots, 1000)).toBe(0.22); // on the first chord
        expect(xAtTickInMeasure(withSlots, 1000 + 720)).toBeCloseTo(0.26, 6); // halfway to the 2nd column
        expect(xAtTickInMeasure(withSlots, 1000 + 1440)).toBe(0.3);
        // Linear interpolation would put tick 720/1920 at x = 0.275 — the dotted
        // rhythm's engraving says 0.26. That difference is the whole point.
        expect(xAtTickInMeasure(withSlots, 1000 + 720)).not.toBeCloseTo(0.275, 3);
    });

    it('sweeps from the last column to the barline', () => {
        expect(xAtTickInMeasure(withSlots, 1000 + 1680)).toBeCloseTo(0.35, 6); // halfway of the tail
        expect(xAtTickInMeasure(withSlots, 1000 + 1920)).toBeCloseTo(0.4, 6);
    });

    it('falls back to linear interpolation without slot data', () => {
        const plain = { ...withSlots, sl: undefined };
        expect(xAtTickInMeasure(plain, 1000 + 960)).toBeCloseTo(0.3, 6);
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
    it('produces 4 quarter beats in a 4/4 measure, downbeat accented', () => {
        const m1 = measures[1];
        if (!m1) {
            throw new Error('fixture missing measure');
        }
        expect(beatsForMeasure(m1, timeSignatures)).toEqual([
            { tick: 480, accent: true },
            { tick: 960, accent: false },
            { tick: 1440, accent: false },
            { tick: 1920, accent: false },
        ]);
    });

    it('feels 6/8 in two dotted-quarter beats, not six eighths', () => {
        const m5 = measures[5];
        if (!m5) {
            throw new Error('fixture missing measure');
        }
        expect(clickBeatTicks({ tick: 0, num: 6, den: 8 })).toBe(720);
        expect(beatsForMeasure(m5, timeSignatures)).toEqual([
            { tick: 8160, accent: true },
            { tick: 8880, accent: false },
        ]);
    });

    it('gives a pickup its beat but never a downbeat accent', () => {
        const pickup = measures[0];
        if (!pickup) {
            throw new Error('fixture missing measure');
        }
        expect(beatsForMeasure(pickup, timeSignatures)).toEqual([{ tick: 0, accent: false }]);
    });
});

describe('countInClicks', () => {
    it('is one plain bar when entering on a downbeat', () => {
        expect(countInClicks(tinyScore, 480)).toEqual([
            { offsetTicks: 1920, accent: true },
            { offsetTicks: 1440, accent: false },
            { offsetTicks: 960, accent: false },
            { offsetTicks: 480, accent: false },
        ]);
    });

    it('counts a full bar plus the lead-in beats for a pickup entry', () => {
        // 1-beat pickup in 4/4: "ONE two three four, ONE two three" → enter on 4.
        const clicks = countInClicks(tinyScore, 0);
        expect(clicks.map((c) => c.offsetTicks)).toEqual([3360, 2880, 2400, 1920, 1440, 960, 480]);
        expect(clicks.filter((c) => c.accent).map((c) => c.offsetTicks)).toEqual([3360, 1440]);
    });

    it('counts compound meter in dotted-quarter clicks', () => {
        expect(countInClicks(tinyScore, 8160)).toEqual([
            { offsetTicks: 1440, accent: true },
            { offsetTicks: 720, accent: false },
        ]);
    });

    it('leads into a mid-measure entry on the beat grid', () => {
        // Entering on beat 3 of m1: one bar + beats 1-2 of the entry bar.
        const clicks = countInClicks(tinyScore, 480 + 960);
        expect(clicks.map((c) => c.offsetTicks)).toEqual([2880, 2400, 1920, 1440, 960, 480]);
        expect(clicks.filter((c) => c.accent).map((c) => c.offsetTicks)).toEqual([2880, 960]);
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
