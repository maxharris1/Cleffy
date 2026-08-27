import { describe, expect, it } from 'vitest';

import { activeTimeSigAt, compareScoreDataAtSeam } from './seamCompare.js';
import { SCORE_DATA_VERSION, TICKS_PER_QUARTER } from './scoreData.js';
import type { ScoreData } from './scoreData.js';

const score = (overrides: Partial<ScoreData>): ScoreData => ({
    version: SCORE_DATA_VERSION,
    ticksPerQuarter: TICKS_PER_QUARTER,
    defaultBpm: 100,
    timeSignatures: [{ tick: 0, num: 3, den: 4 }],
    totalTicks: 3840,
    notes: [
        { t: 0, d: 480, p: 60, h: 0 },
        { t: 1440, d: 960, p: 62, h: 0 }, // crosses into page 1 at tick 1920 if seam there
    ],
    measures: [
        { n: 1, tick: 0, dTicks: 1440, page: 0, sys: 0, x0: 0, x1: 1 },
        { n: 2, tick: 1440, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 },
        { n: 3, tick: 1920, dTicks: 1440, page: 1, sys: 1, x0: 0, x1: 1 },
        { n: 4, tick: 3360, dTicks: 480, page: 1, sys: 1, x0: 0, x1: 1 },
    ],
    systems: [
        { page: 0, y0: 0.1, y1: 0.4 },
        { page: 1, y0: 0.1, y1: 0.4 },
    ],
    warnings: [],
    ...overrides,
});

describe('activeTimeSigAt', () => {
    it('returns the last sig at or before tick', () => {
        const sigs = [
            { tick: 0, num: 4, den: 4 },
            { tick: 1920, num: 3, den: 4 },
        ];
        expect(activeTimeSigAt(sigs, 100)?.num).toBe(4);
        expect(activeTimeSigAt(sigs, 1920)?.num).toBe(3);
    });
});

describe('compareScoreDataAtSeam', () => {
    it('passes when seam measure lengths and crossing notes match', () => {
        const full = score({});
        const merged = score({});
        expect(compareScoreDataAtSeam(full, merged, 1).ok).toBe(true);
    });

    it('fails on seam dTicks mismatch', () => {
        const full = score({});
        const merged = score({
            measures: [
                { n: 1, tick: 0, dTicks: 1440, page: 0, sys: 0, x0: 0, x1: 1 },
                { n: 2, tick: 1440, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 },
                { n: 3, tick: 1920, dTicks: 1920, page: 1, sys: 1, x0: 0, x1: 1 }, // wrong 4/4 bar
                { n: 4, tick: 3840, dTicks: 480, page: 1, sys: 1, x0: 0, x1: 1 },
            ],
            totalTicks: 4320,
        });
        const result = compareScoreDataAtSeam(full, merged, 1);
        expect(result.ok).toBe(false);
        expect(result.reasons.some((r) => r.startsWith('seam_measure_dTicks'))).toBe(true);
    });

    it('fails when a crossing note duration is truncated in merged', () => {
        const full = score({});
        const merged = score({
            notes: [
                { t: 0, d: 480, p: 60, h: 0 },
                { t: 1440, d: 480, p: 62, h: 0 }, // truncated across seam
            ],
        });
        const result = compareScoreDataAtSeam(full, merged, 1);
        expect(result.ok).toBe(false);
        expect(result.reasons.some((r) => r.includes('crossing_note_duration'))).toBe(true);
    });
});
