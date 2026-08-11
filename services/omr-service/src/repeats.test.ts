import { describe, expect, it } from 'vitest';

import { planRepeats, unrollRepeats } from './repeats.js';
import type { MeasureRepeatMarks } from './musicxml.js';

const LIMITS = { maxMeasures: 2000 };

const bar = (over: Partial<MeasureRepeatMarks> = {}): MeasureRepeatMarks => ({
    repeatForward: false,
    repeatBackward: false,
    repeatTimes: 2,
    endingStart: null,
    endingStop: false,
    ...over,
});

const plan = (marks: MeasureRepeatMarks[], limits = LIMITS, isPickup?: (i: number) => boolean) =>
    planRepeats(marks, limits, isPickup);

describe('planRepeats', () => {
    it('leaves a score with no repeat marks alone', () => {
        const result = plan([bar(), bar(), bar()]);
        expect(result).toEqual({ order: [0, 1, 2], degraded: false });
    });

    it('plays |: A B :| as A B A B', () => {
        const result = plan([bar({ repeatForward: true }), bar({ repeatBackward: true })]);
        expect(result.order).toEqual([0, 1, 0, 1]);
        expect(result.degraded).toBe(false);
    });

    it('takes first and second endings in turn', () => {
        // |: A |1. B :|2. C |
        const result = plan([
            bar({ repeatForward: true }),
            bar({ endingStart: [1], endingStop: true, repeatBackward: true }),
            bar({ endingStart: [2], endingStop: true }),
        ]);
        expect(result.order).toEqual([0, 1, 0, 2]);
        expect(result.degraded).toBe(false);
    });

    it('returns to the top when a backward repeat has no forward partner', () => {
        const result = plan([bar(), bar(), bar({ repeatBackward: true })]);
        expect(result.order).toEqual([0, 1, 2, 0, 1, 2]);
    });

    it('does not replay a pickup on the way round', () => {
        // Bar 0 is a pickup: played once on the way in, never again.
        const result = plan([bar(), bar(), bar({ repeatBackward: true })], LIMITS, (i) => i === 0);
        expect(result.order).toEqual([0, 1, 2, 1, 2]);
    });

    it('honours an explicit repeat count', () => {
        const result = plan([bar({ repeatForward: true }), bar({ repeatBackward: true, repeatTimes: 3 })]);
        expect(result.order).toEqual([0, 1, 0, 1, 0, 1]);
    });

    it('lets a second forward repeat take over as the return point', () => {
        // |: A |: B :|  — the nearer forward wins, which is the reading engravers mean.
        const result = plan([
            bar({ repeatForward: true }),
            bar({ repeatForward: true }),
            bar({ repeatBackward: true }),
        ]);
        expect(result.order).toEqual([0, 1, 2, 1, 2]);
    });

    it('skips a volta whose pass does not match', () => {
        // |: A |1. B :| |3. C |  — pass 2 matches neither bracket.
        const result = plan([
            bar({ repeatForward: true }),
            bar({ endingStart: [1], endingStop: true, repeatBackward: true }),
            bar({ endingStart: [3], endingStop: true }),
        ]);
        // Bar 2 is never reached, so the structure was not fully understood.
        expect(result.order).toEqual([0, 1, 0]);
        expect(result.degraded).toBe(true);
    });

    it('reads a multi-pass volta bracket', () => {
        const result = plan([
            bar({ repeatForward: true }),
            bar({ endingStart: [1, 2], endingStop: true, repeatBackward: true, repeatTimes: 3 }),
            bar({ endingStart: [3], endingStop: true }),
        ]);
        expect(result.order).toEqual([0, 1, 0, 1, 0, 2]);
        expect(result.degraded).toBe(false);
    });

    it('degrades to linear rather than exceeding the measure cap', () => {
        // 40 passes of a 10-bar section would blow a 100-measure ceiling.
        const marks = [bar({ repeatForward: true }), ...Array.from({ length: 8 }, () => bar())];
        marks.push(bar({ repeatBackward: true, repeatTimes: 16 }));
        const result = plan(marks, { maxMeasures: 100 });
        expect(result.degraded).toBe(true);
        expect(result.order).toEqual(marks.map((_, i) => i));
    });

    it('degrades to linear on a structure it cannot resolve', () => {
        // A backward repeat inside a volta that never matches: no progress.
        const marks = Array.from({ length: 6 }, () =>
            bar({ repeatForward: true, repeatBackward: true, repeatTimes: 16 }),
        );
        const result = plan(marks, { maxMeasures: 20 });
        expect(result.degraded).toBe(true);
        expect(result.order).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('always terminates, whatever the marks say', () => {
        // Every combination of flags on three bars must return, not hang.
        const flags = [false, true];
        for (const f0 of flags)
            for (const b0 of flags)
                for (const f1 of flags)
                    for (const b1 of flags)
                        for (const e of [null, [1], [2], [1, 2]]) {
                            const marks = [
                                bar({ repeatForward: f0, repeatBackward: b0 }),
                                bar({ repeatForward: f1, repeatBackward: b1, endingStart: e, endingStop: !!e }),
                                bar(),
                            ];
                            const result = plan(marks, { maxMeasures: 50 });
                            expect(result.order.length).toBeGreaterThan(0);
                            expect(result.order.length).toBeLessThanOrEqual(50);
                        }
    });
});

describe('unrollRepeats', () => {
    /** Three 480-tick bars, one note each, geometry that must survive cloning. */
    const linear = {
        measures: [
            { tick: 0, dTicks: 480, srcIndex: 0, page: 0, sys: 0, x0: 0.1, x1: 0.3, sl: [{ x: 0.15, t: 0 }] },
            { tick: 480, dTicks: 480, srcIndex: 1, page: 0, sys: 0, x0: 0.3, x1: 0.5, sl: [{ x: 0.35, t: 0 }] },
            { tick: 960, dTicks: 480, srcIndex: 2, page: 0, sys: 0, x0: 0.5, x1: 0.7, sl: [{ x: 0.55, t: 0 }] },
        ],
        notes: [
            { t: 0, d: 480, p: 60, h: 0 as const },
            { t: 480, d: 480, p: 62, h: 0 as const },
            { t: 960, d: 480, p: 64, h: 0 as const },
        ],
        timeSignatures: [{ tick: 0, num: 4, den: 4 }],
        totalTicks: 1440,
    };

    it('clones a repeated bar with its geometry intact at a new tick', () => {
        const out = unrollRepeats(linear, [0, 1, 0, 1, 2]);
        expect(out.measures.map((m) => m.tick)).toEqual([0, 480, 960, 1440, 1920]);
        expect(out.measures.map((m) => m.srcIndex)).toEqual([0, 1, 0, 1, 2]);
        // The page position is what makes the playhead sweep the same bar twice.
        const [first, , second] = out.measures;
        expect({ page: second!.page, sys: second!.sys, x0: second!.x0, x1: second!.x1, sl: second!.sl }).toEqual({
            page: first!.page,
            sys: first!.sys,
            x0: first!.x0,
            x1: first!.x1,
            sl: first!.sl,
        });
        expect(out.totalTicks).toBe(2400);
    });

    it('re-emits the notes of every pass', () => {
        const out = unrollRepeats(linear, [0, 1, 0, 1, 2]);
        expect(out.notes.map((n) => [n.t, n.p])).toEqual([
            [0, 60],
            [480, 62],
            [960, 60],
            [1440, 62],
            [1920, 64],
        ]);
    });

    it('clips a note held across a jump but not one across a continuous seam', () => {
        const held = {
            ...linear,
            notes: [
                { t: 0, d: 480, p: 60, h: 0 as const },
                // Bar 1's note rings two bars — legitimate inside a run, but it
                // cannot ring past the repeat's backward jump.
                { t: 480, d: 960, p: 62, h: 0 as const },
                { t: 960, d: 480, p: 64, h: 0 as const },
            ],
        };
        const out = unrollRepeats(held, [0, 1, 0, 1, 2]);
        const long = out.notes.filter((n) => n.p === 62);
        // First pass jumps back after bar 1 → clipped to the bar.
        expect(long[0]!.d).toBe(480);
        // Second pass continues into bar 2 → keeps its full length.
        expect(long[1]!.d).toBe(960);
    });

    it('re-emits the state in force at a jump target', () => {
        const withSigs = {
            ...linear,
            timeSignatures: [
                { tick: 0, num: 4, den: 4 },
                { tick: 960, num: 3, den: 4 },
            ],
        };
        // Perform bar 2 (3/4), then jump back to bar 0 (4/4).
        const out = unrollRepeats(withSigs, [2, 0, 1]);
        expect(out.timeSignatures).toEqual([
            { tick: 0, num: 3, den: 4 },
            { tick: 480, num: 4, den: 4 },
        ]);
    });

    it('duplicates a fermata that falls inside a repeated bar', () => {
        const out = unrollRepeats({ ...linear, holds: [{ tick: 480, beats: 2 }] }, [0, 1, 0, 1, 2]);
        expect(out.holds).toEqual([
            { tick: 480, beats: 2 },
            { tick: 1440, beats: 2 },
        ]);
    });

    it('leaves a linear order completely unchanged', () => {
        const out = unrollRepeats(linear, [0, 1, 2]);
        expect(out.measures).toEqual(linear.measures);
        expect(out.notes).toEqual(linear.notes);
        expect(out.totalTicks).toBe(linear.totalTicks);
    });
});
