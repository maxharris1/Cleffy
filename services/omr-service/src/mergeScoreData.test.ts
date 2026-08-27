import { describe, expect, it } from 'vitest';

import {
    mergeScoreDataParts,
    seamIsUnsafe,
    splitSheetRanges,
    splitSheetRangesOverlapping,
} from './mergeScoreData.js';
import { SCORE_DATA_VERSION, TICKS_PER_QUARTER } from './scoreData.js';
import type { ScoreData } from './scoreData.js';

const basePart = (overrides: Partial<ScoreData>): ScoreData => ({
    version: SCORE_DATA_VERSION,
    ticksPerQuarter: TICKS_PER_QUARTER,
    defaultBpm: 120,
    timeSignatures: [{ tick: 0, num: 4, den: 4 }],
    totalTicks: 1920,
    notes: [{ t: 0, d: 480, p: 60, h: 0 }],
    measures: [{ n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0, x1: 1 }],
    systems: [{ page: 0, y0: 0.1, y1: 0.4 }],
    warnings: [],
    ...overrides,
});

describe('splitSheetRanges', () => {
    it('splits evenly across N shards', () => {
        expect(splitSheetRanges(4, 2)).toEqual([
            { from: 1, to: 2 },
            { from: 3, to: 4 },
        ]);
        expect(splitSheetRanges(5, 2)).toEqual([
            { from: 1, to: 3 },
            { from: 4, to: 5 },
        ]);
    });
});

describe('splitSheetRangesOverlapping', () => {
    it('shares one page at the cut for n=2', () => {
        expect(splitSheetRangesOverlapping(5, 2, 1)).toEqual([
            { from: 1, to: 3 },
            { from: 3, to: 5 },
        ]);
        expect(splitSheetRangesOverlapping(4, 2, 1)).toEqual([
            { from: 1, to: 2 },
            { from: 2, to: 4 },
        ]);
    });
});

describe('mergeScoreDataParts', () => {
    it('offsets ticks and remaps pages across sheet ranges', () => {
        const a = basePart({});
        const b = basePart({
            notes: [{ t: 0, d: 480, p: 62, h: 0 }],
            measures: [{ n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0, x1: 1 }],
            systems: [{ page: 0, y0: 0.2, y1: 0.5 }],
            timeSignatures: [],
        });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 3, to: 4 } },
        ]);
        expect(merged.totalTicks).toBe(3840);
        expect(merged.notes.map((n) => n.t)).toEqual([0, 1920]);
        expect(merged.measures.map((m) => m.n)).toEqual([1, 2]);
        expect(merged.measures.map((m) => m.page)).toEqual([0, 2]);
        expect(merged.systems.map((s) => s.page)).toEqual([0, 2]);
        expect(merged.timeSignatures[0]).toEqual({ tick: 0, num: 4, den: 4 });
        expect(merged.warnings).toContain('merged_inherited_time_signature');
    });

    it('drops overlap page from the later part and inherits meter', () => {
        const a = basePart({
            timeSignatures: [{ tick: 0, num: 3, den: 4 }],
            totalTicks: 3840,
            notes: [
                { t: 0, d: 480, p: 60, h: 0 },
                { t: 1920, d: 480, p: 61, h: 0 },
            ],
            measures: [
                { n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0, x1: 1 },
                { n: 2, tick: 1920, dTicks: 1920, page: 1, sys: 1, x0: 0, x1: 1 },
            ],
            systems: [
                { page: 0, y0: 0.1, y1: 0.3 },
                { page: 1, y0: 0.1, y1: 0.3 },
            ],
        });
        const b = basePart({
            timeSignatures: [],
            totalTicks: 3840,
            notes: [
                { t: 0, d: 480, p: 61, h: 0 },
                { t: 1920, d: 480, p: 62, h: 0 },
            ],
            measures: [
                { n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0, x1: 1 },
                { n: 2, tick: 1920, dTicks: 1920, page: 1, sys: 1, x0: 0, x1: 1 },
            ],
            systems: [
                { page: 0, y0: 0.2, y1: 0.4 },
                { page: 1, y0: 0.2, y1: 0.4 },
            ],
        });
        const merged = mergeScoreDataParts([
            { score: a, sheets: { from: 1, to: 2 } },
            { score: b, sheets: { from: 2, to: 3 } },
        ]);
        expect(merged.warnings).toContain('merged_dropped_overlap_page');
        expect(merged.warnings).toContain('merged_inherited_time_signature');
        // Page 0+1 from A, page 2 from B (B's page 1 after drop/rebase)
        expect(merged.measures.map((m) => m.page).sort()).toEqual([0, 1, 2]);
        expect(merged.notes).toHaveLength(3);
        expect(merged.timeSignatures.some((s) => s.num === 3 && s.den === 4)).toBe(true);
    });
});

describe('seamIsUnsafe', () => {
    it('flags open ties on the earlier part', () => {
        const result = seamIsUnsafe([
            { score: basePart({}), sheets: { from: 1, to: 2 }, openTiesAtEnd: 1 },
            { score: basePart({}), sheets: { from: 2, to: 4 }, openTiesAtEnd: 0 },
        ]);
        expect(result.unsafe).toBe(true);
        expect(result.reasons.some((r) => r.startsWith('open_ties'))).toBe(true);
    });

    it('flags explicit meter disagreement at the seam', () => {
        const result = seamIsUnsafe([
            {
                score: basePart({ timeSignatures: [{ tick: 0, num: 3, den: 4 }] }),
                sheets: { from: 1, to: 2 },
            },
            {
                score: basePart({ timeSignatures: [{ tick: 0, num: 4, den: 4 }] }),
                sheets: { from: 2, to: 4 },
            },
        ]);
        expect(result.unsafe).toBe(true);
        expect(result.reasons.some((r) => r.startsWith('meter_seam'))).toBe(true);
    });
});
