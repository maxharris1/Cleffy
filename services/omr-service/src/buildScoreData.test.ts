import { describe, expect, it } from 'vitest';

import { buildScoreData } from './buildScoreData.js';
import { JobError } from './errors.js';
import type { MusicalScore } from './musicxml.js';
import type { OmrGeometry } from './omrGeometry.js';

const musical: MusicalScore = {
    notes: [
        { t: 0, d: 480, p: 60, h: 0 },
        { t: 480, d: 480, p: 48, h: 1 },
    ],
    measures: [
        { n: 1, tick: 0, dTicks: 1920 },
        { n: 2, tick: 1920, dTicks: 1920 },
    ],
    timeSignatures: [{ tick: 0, num: 4, den: 4 }],
    defaultBpm: 88,
    totalTicks: 3840,
    warnings: ['repeats_ignored'],
};

const geometry: OmrGeometry = {
    sheets: [
        {
            pageIndex: 0,
            widthPx: 1000,
            heightPx: 1000,
            systems: [
                {
                    y0: 0.1,
                    y1: 0.3,
                    stacks: [
                        { x0: 0.1, x1: 0.5 },
                        { x0: 0.5, x1: 0.9 },
                    ],
                },
            ],
        },
    ],
};

describe('buildScoreData', () => {
    it('zips measures with geometry and carries warnings/bpm through', () => {
        const score = buildScoreData(musical, geometry);
        expect(score.measures[0]).toEqual({ n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0.1, x1: 0.5 });
        expect(score.measures[1]).toMatchObject({ sys: 0, x0: 0.5, x1: 0.9 });
        expect(score.systems).toEqual([{ page: 0, y0: 0.1, y1: 0.3 }]);
        expect(score.defaultBpm).toBe(88);
        expect(score.warnings).toContain('repeats_ignored');
    });

    it('degrades to geometry-less measures when the .omr is unusable', () => {
        const score = buildScoreData(musical, null);
        expect(score.measures.every((m) => m.sys === -1 && m.page === -1)).toBe(true);
        expect(score.warnings).toContain('no_geometry');
    });

    it('geometry count mismatch degrades the tail, not the whole score', () => {
        const short: OmrGeometry = {
            sheets: [
                {
                    pageIndex: 0,
                    widthPx: 1000,
                    heightPx: 1000,
                    systems: [{ y0: 0.1, y1: 0.3, stacks: [{ x0: 0.1, x1: 0.5 }] }],
                },
            ],
        };
        const score = buildScoreData(musical, short);
        expect(score.measures[0]?.sys).toBe(0);
        expect(score.measures[1]?.sys).toBe(-1);
        expect(score.warnings).toContain('measure_geometry_mismatch');
    });

    it('rejects a score with nothing playable', () => {
        expect(() => buildScoreData({ ...musical, notes: [] }, geometry)).toThrowError(JobError);
    });
});
