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
    // Whatever the parser could not do. Nothing structural: what a score's
    // repeats and jumps cost the reader is decided here, not upstream.
    warnings: ['grace_notes_skipped'],
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
        expect(score.measures[0]).toEqual({
            n: 1,
            tick: 0,
            dTicks: 1920,
            page: 0,
            sys: 0,
            x0: 0.1,
            x1: 0.5,
            srcIndex: 0,
        });
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
        expect(score.warnings).toContain('grace_notes_skipped');
        expect(score.version).toBe(3);
        expect(score.era).toBe('classical');
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

    it('keeps the parser\u2019s articulation gates to itself', () => {
        const gated: MusicalScore = {
            ...musical,
            notes: musical.notes.map((n) => ({ ...n, gate: 0.5 })),
        };
        const score = buildScoreData(gated, geometry);
        expect(score.notes.length).toBe(musical.notes.length);
        for (const n of score.notes) {
            expect(n).not.toHaveProperty('gate');
        }
    });

    it('rejects a score with nothing playable', () => {
        expect(() => buildScoreData({ ...musical, notes: [] }, geometry)).toThrowError(JobError);
    });

    it('a merged bar in one system does not shift later systems', () => {
        // Three systems: 2+2+2 measures. The middle system has an extra stack
        // (Audiveris split a bar). Positional zip would hand that leftover to
        // the next system's first bar and slide everything after it.
        const bars = 6;
        const score = buildScoreData(
            {
                ...musical,
                notes: Array.from({ length: bars }, (_, i) => ({ t: i * 1920, d: 480, p: 60, h: 0 as const })),
                measures: Array.from({ length: bars }, (_, i) => ({
                    n: i + 1,
                    tick: i * 1920,
                    dTicks: 1920,
                    ...(i === 2 || i === 4 ? { sysBreak: true } : {}),
                })),
                totalTicks: bars * 1920,
                warnings: [],
            },
            {
                sheets: [
                    {
                        pageIndex: 0,
                        widthPx: 1000,
                        heightPx: 1000,
                        systems: [
                            {
                                y0: 0.05,
                                y1: 0.2,
                                staves: [],
                                stacks: [
                                    { x0: 0.1, x1: 0.4, slots: [] },
                                    { x0: 0.4, x1: 0.8, slots: [] },
                                ],
                            },
                            {
                                y0: 0.25,
                                y1: 0.4,
                                staves: [],
                                stacks: [
                                    { x0: 0.1, x1: 0.3, slots: [] },
                                    { x0: 0.3, x1: 0.55, slots: [] },
                                    { x0: 0.55, x1: 0.9, slots: [] },
                                ],
                            },
                            {
                                y0: 0.45,
                                y1: 0.6,
                                staves: [],
                                stacks: [
                                    { x0: 0.1, x1: 0.45, slots: [] },
                                    { x0: 0.45, x1: 0.85, slots: [] },
                                ],
                            },
                        ],
                    },
                ],
            },
        );
        expect(score.measures.map((m) => ({ n: m.n, sys: m.sys, page: m.page, x0: m.x0, x1: m.x1 }))).toEqual([
            { n: 1, sys: 0, page: 0, x0: 0.1, x1: 0.4 },
            { n: 2, sys: 0, page: 0, x0: 0.4, x1: 0.8 },
            { n: 3, sys: 1, page: 0, x0: 0.1, x1: 0.3 },
            { n: 4, sys: 1, page: 0, x0: 0.3, x1: 0.9 },
            { n: 5, sys: 2, page: 0, x0: 0.1, x1: 0.45 },
            { n: 6, sys: 2, page: 0, x0: 0.45, x1: 0.85 },
        ]);
        expect(score.warnings).toContain('measure_geometry_mismatch');
    });

    it('a movement-seam sysBreak keeps the next file on its own systems', () => {
        // Two "files": 2 measures then 2, with a forced break at the join.
        // Movement 1's last system has a leftover stack; that must not become
        // movement 2 bar 1.
        const score = buildScoreData(
            {
                ...musical,
                notes: [
                    { t: 0, d: 480, p: 60, h: 0 },
                    { t: 1920, d: 480, p: 62, h: 0 },
                    { t: 3840, d: 480, p: 64, h: 0 },
                    { t: 5760, d: 480, p: 65, h: 0 },
                ],
                measures: [
                    { n: 1, tick: 0, dTicks: 1920 },
                    { n: 2, tick: 1920, dTicks: 1920 },
                    { n: 1, tick: 3840, dTicks: 1920, sysBreak: true },
                    { n: 2, tick: 5760, dTicks: 1920 },
                ],
                totalTicks: 7680,
                warnings: [],
            },
            {
                sheets: [
                    {
                        pageIndex: 0,
                        widthPx: 1000,
                        heightPx: 1000,
                        systems: [
                            {
                                y0: 0.1,
                                y1: 0.3,
                                staves: [],
                                stacks: [
                                    { x0: 0.1, x1: 0.4, slots: [] },
                                    { x0: 0.4, x1: 0.65, slots: [] },
                                    { x0: 0.65, x1: 0.95, slots: [] },
                                ],
                            },
                        ],
                    },
                    {
                        pageIndex: 1,
                        widthPx: 1000,
                        heightPx: 1000,
                        systems: [
                            {
                                y0: 0.1,
                                y1: 0.3,
                                staves: [],
                                stacks: [
                                    { x0: 0.12, x1: 0.5, slots: [] },
                                    { x0: 0.5, x1: 0.88, slots: [] },
                                ],
                            },
                        ],
                    },
                ],
            },
        );
        expect(score.measures[0]).toMatchObject({ n: 1, page: 0, sys: 0, x0: 0.1, x1: 0.4 });
        expect(score.measures[1]).toMatchObject({ n: 2, page: 0, sys: 0, x0: 0.4, x1: 0.95 });
        expect(score.measures[2]).toMatchObject({ n: 1, page: 1, sys: 1, x0: 0.12, x1: 0.5 });
        expect(score.measures[3]).toMatchObject({ n: 2, page: 1, sys: 1, x0: 0.5, x1: 0.88 });
        expect(score.warnings).toContain('measure_geometry_mismatch');
    });
});

describe('buildScoreData auto-pedal', () => {
    it('pedals an unmarked score by its era and says so', () => {
        const score = buildScoreData(musical, geometry, { era: 'romantic' });
        expect(score.warnings).toContain('pedal_inferred');
        expect(score.pedals?.[0]).toEqual({ tick: 0, k: 'down', src: 'inferred' });
        expect(score.pedals?.[score.pedals.length - 1]?.k).toBe('up');
    });

    it('defaults to Classical pedalling when no era is given', () => {
        expect(buildScoreData(musical, geometry).pedals).toEqual(
            buildScoreData(musical, geometry, { era: 'classical' }).pedals,
        );
    });

    it('leaves Baroque music dry, with no disclosure', () => {
        const score = buildScoreData(musical, geometry, { era: 'baroque' });
        expect(score.pedals).toBeUndefined();
        expect(score.warnings).not.toContain('pedal_inferred');
    });

    it('does not second-guess engraved pedalling, including a long dry middle', () => {
        const pedalled: MusicalScore = {
            ...musical,
            pedals: [
                { tick: 0, k: 'down' },
                { tick: 3839, k: 'up' },
            ],
        };
        const score = buildScoreData(pedalled, geometry, { era: 'romantic' });
        expect(score.pedals).toEqual(pedalled.pedals);
        expect(score.warnings).not.toContain('pedal_inferred');
        expect(score.era).toBe('romantic');
    });

    it('leaves a shard unpedalled and undisclosed when asked, for the merge to pedal whole', () => {
        const score = buildScoreData(musical, geometry, { era: 'romantic', autoPedal: false });
        expect(score.pedals).toBeUndefined();
        expect(score.warnings).not.toContain('pedal_inferred');
        // Engraved edges still travel.
        const pedalled: MusicalScore = {
            ...musical,
            pedals: [
                { tick: 0, k: 'down' },
                { tick: 3839, k: 'up' },
            ],
        };
        expect(buildScoreData(pedalled, geometry, { era: 'romantic', autoPedal: false }).pedals).toEqual(
            pedalled.pedals,
        );
    });
});

describe('buildScoreData structure', () => {
    const plainMarks = {
        repeatForward: false,
        repeatBackward: false,
        repeatTimes: 2,
        endingStart: null,
        endingStop: false,
    };

    it('unrolls a repeat into performed measures that reuse the printed geometry', () => {
        const score = buildScoreData(
            {
                ...musical,
                repeats: [
                    { ...plainMarks, repeatForward: true },
                    { ...plainMarks, repeatBackward: true },
                ],
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

    it('says nothing about a `|:` with no `:|` to send anyone back to it', () => {
        // The old false positive: a forward repeat alone is performed exactly as
        // a linear read performs it, so the reader has lost nothing to warn about.
        const score = buildScoreData(
            { ...musical, repeats: [{ ...plainMarks, repeatForward: true }, plainMarks] },
            geometry,
        );
        expect(score.measures).toHaveLength(2);
        expect(score.warnings).not.toContain('repeats_ignored');
        expect(score.warnings).not.toContain('repeats_unrolled');
    });

    it('discloses a printed repeat whose structure did not resolve', () => {
        const score = buildScoreData(
            {
                ...musical,
                repeats: [
                    { ...plainMarks, repeatForward: true },
                    // A volta that belongs to a third pass this repeat never makes.
                    { ...plainMarks, repeatBackward: true, endingStart: [3] },
                ],
            },
            geometry,
        );
        expect(score.measures).toHaveLength(2);
        expect(score.warnings).toContain('repeats_ignored');
    });

    it('does not claim a repeat it went on to decline', () => {
        // The `:|` IS retaken on the way through, and then a volta belonging to
        // a pass that never comes leaves a bar unplayed. Half-understood, so
        // nothing is performed — and the disclosure has to agree with that.
        const threeBar = {
            ...musical,
            measures: [...musical.measures, { n: 3, tick: 3840, dTicks: 1920 }],
            totalTicks: 5760,
            repeats: [
                { ...plainMarks, repeatForward: true },
                { ...plainMarks, repeatBackward: true },
                { ...plainMarks, endingStart: [3] },
            ],
        };
        const score = buildScoreData(threeBar, null);
        expect(score.measures).toHaveLength(3);
        expect(score.warnings).toContain('repeats_ignored');
        expect(score.warnings).not.toContain('repeats_unrolled');
    });

    it('performs a D.C. al Fine, sweeping the engraved bars again on the way back', () => {
        const score = buildScoreData(
            {
                ...musical,
                repeats: [
                    { ...plainMarks, fine: true },
                    { ...plainMarks, jump: { kind: 'dc', al: 'fine' } },
                ],
            },
            geometry,
        );
        expect(score.measures.map((m) => m.srcIndex)).toEqual([0, 1, 0]);
        expect(score.measures.map((m) => m.tick)).toEqual([0, 1920, 3840]);
        expect(score.measures[2]!.x0).toBe(score.measures[0]!.x0);
        expect(score.measures[2]!.sys).toBe(score.measures[0]!.sys);
        expect(score.warnings).toContain('jumps_performed');
        expect(score.warnings).not.toContain('jumps_ignored');
        expect(score.warnings).not.toContain('repeats_unrolled');
    });

    it('performs the coda diversion a <sound>-only export leaves the words off', () => {
        // <sound dalsegno>/<sound tocoda>/<sound coda> carry no "al Coda" text —
        // MusicXML has no attribute for it — so the pair is the whole instruction.
        const fourBar: MusicalScore = {
            ...musical,
            notes: [
                { t: 0, d: 480, p: 60, h: 0 },
                { t: 1920, d: 480, p: 62, h: 0 },
                { t: 3840, d: 480, p: 64, h: 0 },
                { t: 5760, d: 480, p: 65, h: 0 },
            ],
            measures: [
                { n: 1, tick: 0, dTicks: 1920 },
                { n: 2, tick: 1920, dTicks: 1920 },
                { n: 3, tick: 3840, dTicks: 1920 },
                { n: 4, tick: 5760, dTicks: 1920 },
            ],
            totalTicks: 7680,
            repeats: [
                { ...plainMarks, segno: true },
                { ...plainMarks, toCoda: true },
                { ...plainMarks, jump: { kind: 'ds', al: null } },
                { ...plainMarks, codaTarget: true },
            ],
        };
        const score = buildScoreData(fourBar, null);
        // Back to the segno, out at the To Coda, into the coda section — not the
        // straight replay a jump with no target would have given.
        expect(score.measures.map((m) => m.srcIndex)).toEqual([0, 1, 2, 0, 1, 3]);
        expect(score.warnings).toContain('jumps_performed');
        expect(score.warnings).not.toContain('jumps_ignored');
    });

    it('plays straight through, and says so, when a jump does not add up', () => {
        const score = buildScoreData(
            { ...musical, repeats: [plainMarks, { ...plainMarks, jump: { kind: 'ds', al: null } }] },
            geometry,
        );
        // A D.S. with no segno above it: refused whole rather than guessed at.
        expect(score.measures.map((m) => m.srcIndex)).toEqual([0, 1]);
        expect(score.warnings).toContain('jumps_ignored');
        expect(score.warnings).not.toContain('repeats_ignored');
    });

    it('holds its tongue about a segno with no jump to use it', () => {
        const score = buildScoreData({ ...musical, repeats: [{ ...plainMarks, segno: true }, plainMarks] }, geometry);
        expect(score.warnings).not.toContain('jumps_ignored');
        expect(score.warnings).not.toContain('jumps_performed');
    });

    it('carries pedal edges to the client, re-timed for every pass of a repeat', () => {
        const score = buildScoreData(
            {
                ...musical,
                pedals: [
                    { tick: 0, k: 'down' },
                    { tick: 1900, k: 'up' },
                ],
                repeats: [
                    { ...plainMarks, repeatForward: true },
                    { ...plainMarks, repeatBackward: true },
                ],
            },
            geometry,
        );
        // Moments, not state in force: both halves of the span come back on the
        // second pass rather than the release being inherited from the first.
        expect(score.pedals).toEqual([
            { tick: 0, k: 'down' },
            { tick: 1900, k: 'up' },
            { tick: 3840, k: 'down' },
            { tick: 5740, k: 'up' },
        ]);
    });

    it('thins a tempo map the repeat multiplied past the schema ceiling', () => {
        const ramp = Array.from({ length: 300 }, (_, i) => ({ tick: i, bpm: 100 + (i % 20), src: 'ramp' as const }));
        const score = buildScoreData(
            {
                ...musical,
                tempos: ramp,
                repeats: [
                    { ...plainMarks, repeatForward: true },
                    { ...plainMarks, repeatBackward: true },
                ],
            },
            geometry,
        );
        // Both passes carry the ramp, which alone would breach the cap of 512
        // and throw the whole score away in the self-check.
        expect(score.measures).toHaveLength(4);
        expect(score.tempos!.length).toBeLessThanOrEqual(512);
        // Thinned across the whole performance, not truncated at the front.
        expect(score.tempos!.at(-1)!.tick).toBeGreaterThan(score.totalTicks / 2);
    });

    it('swings eighths on the linear score so unrolled copies inherit the long–short', () => {
        const score = buildScoreData(
            {
                ...musical,
                swing: true,
                notes: [
                    { t: 0, d: 216, p: 60, h: 0 },
                    { t: 240, d: 216, p: 62, h: 0 },
                    { t: 480, d: 480, p: 48, h: 1 },
                ],
                repeats: [
                    { ...plainMarks, repeatForward: true },
                    { ...plainMarks, repeatBackward: true },
                ],
            },
            geometry,
        );
        const swung = score.notes.filter((n) => n.p === 60 || n.p === 62);
        expect(swung).toEqual([
            { t: 0, d: 296, p: 60, h: 0 },
            { t: 320, d: 136, p: 62, h: 0 },
            { t: 3840, d: 296, p: 60, h: 0 },
            { t: 4160, d: 136, p: 62, h: 0 },
        ]);
        expect(score.warnings).toContain('swing_applied');
        expect(score.warnings).toContain('repeats_unrolled');
    });

    it('swings each hand independently on a two-hand bar of eighths', () => {
        const score = buildScoreData(
            {
                ...musical,
                swing: true,
                notes: [
                    { t: 0, d: 216, p: 60, h: 0 },
                    { t: 0, d: 216, p: 48, h: 1 },
                    { t: 240, d: 216, p: 62, h: 0 },
                    { t: 240, d: 216, p: 50, h: 1 },
                ],
            },
            geometry,
        );
        const rh = score.notes.filter((n) => n.h === 0);
        const lh = score.notes.filter((n) => n.h === 1);
        expect(rh).toEqual([
            { t: 0, d: 296, p: 60, h: 0 },
            { t: 320, d: 136, p: 62, h: 0 },
        ]);
        expect(lh).toEqual([
            { t: 0, d: 296, p: 48, h: 1 },
            { t: 320, d: 136, p: 50, h: 1 },
        ]);
    });
});
