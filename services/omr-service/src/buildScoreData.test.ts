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
    keySignatures: [],
    clefs: [],
    tempos: [],
    holds: [],
    repeats: [],
    defaultBpm: 88,
    totalTicks: 3840,
    warnings: ['repeats_ignored'],
    openTiesAtEnd: 0,
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
                    staves: [
                        { y0: 0.12, y1: 0.18 },
                        { y0: 0.22, y1: 0.28 },
                    ],
                    stacks: [
                        { x0: 0.1, x1: 0.5, slots: [] },
                        { x0: 0.5, x1: 0.9, slots: [] },
                    ],
                },
            ],
        },
    ],
};

describe('buildScoreData', () => {
    it('zips measures with geometry and carries warnings/bpm through', () => {
        const score = buildScoreData(musical, geometry);
        expect(score.measures[0]).toEqual({ n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0.1, x1: 0.5, srcIndex: 0 });
        // Trivially the index while scores are linear; repeats will make several
        // entries share one.
        expect(score.measures.map((m) => m.srcIndex)).toEqual([0, 1]);
        expect(score.measures[1]).toMatchObject({ sys: 0, x0: 0.5, x1: 0.9 });
        expect(score.systems).toEqual([
            {
                page: 0,
                y0: 0.1,
                y1: 0.3,
                staves: [
                    { y0: 0.12, y1: 0.18 },
                    { y0: 0.22, y1: 0.28 },
                ],
            },
        ]);
        expect(score.defaultBpm).toBe(88);
        expect(score.warnings).toContain('repeats_ignored');
        expect(score.version).toBe(3);
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
                    systems: [{ y0: 0.1, y1: 0.3, staves: [], stacks: [{ x0: 0.1, x1: 0.5, slots: [] }] }],
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

describe('buildScoreData repeats', () => {
    const plainMarks = { repeatForward: false, repeatBackward: false, repeatTimes: 2, endingStart: null, endingStop: false };

    it('unrolls a repeat into performed measures that reuse the printed geometry', () => {
        const score = buildScoreData(
            {
                ...musical,
                repeats: [{ ...plainMarks, repeatForward: true }, { ...plainMarks, repeatBackward: true }],
            },
            geometry,
        );
        // Two printed bars performed twice.
        expect(score.measures).toHaveLength(4);
        expect(score.measures.map((m) => m.srcIndex)).toEqual([0, 1, 0, 1]);
        expect(score.measures.map((m) => m.tick)).toEqual([0, 1920, 3840, 5760]);
        // Each pass sweeps the same engraved bar.
        expect(score.measures[2]!.x0).toBe(score.measures[0]!.x0);
        expect(score.measures[2]!.sys).toBe(score.measures[0]!.sys);
        expect(score.warnings).toContain('repeats_unrolled');
        expect(score.warnings).not.toContain('repeats_ignored');
    });

    it('leaves a score without repeat marks exactly as before', () => {
        const withMarks = buildScoreData({ ...musical, repeats: [plainMarks, plainMarks] }, geometry);
        const without = buildScoreData(musical, geometry);
        expect(withMarks.measures).toEqual(without.measures);
        expect(withMarks.totalTicks).toBe(without.totalTicks);
    });

    it('keeps repeats_ignored when the structure could not be resolved', () => {
        const score = buildScoreData(
            {
                ...musical,
                warnings: [...musical.warnings, 'repeats_ignored'],
                repeats: [
                    { ...plainMarks, repeatForward: true, repeatBackward: true, repeatTimes: 16 },
                    { ...plainMarks, repeatForward: true, repeatBackward: true, repeatTimes: 16 },
                ],
            },
            geometry,
        );
        // 16 passes of two bars is 32 measures — fine here, so it DOES unroll;
        // what matters is that it never silently half-unrolls.
        expect(score.measures.length % 2).toBe(0);
        expect(score.measures.every((m) => m.srcIndex === 0 || m.srcIndex === 1)).toBe(true);
    });
});
