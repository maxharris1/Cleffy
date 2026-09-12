import { describe, expect, it } from 'vitest';

import type { ScoreData } from '../scoreData.js';
import { SCORE_DATA_VERSION, TICKS_PER_QUARTER } from '../scoreData.js';
import { compareScore, pitchSim, ALIGN_SKIP_COST } from './compare.js';
import type { CorpusEntry } from './manifest.js';
import type { RefNote } from './midiRef.js';
import { segmentMovements } from './segment.js';

const entry: CorpusEntry = {
    slug: 'toy',
    title: 'Toy',
    pdf: { url: 'https://example.test/t.pdf', pages: 1 },
    reference: {
        source: 'mutopia',
        url: 'https://example.test/t.zip',
        sha256: '0'.repeat(64),
        license: 'CC',
    },
    movements: [
        {
            name: 'I',
            midi: 'i.mid',
            meter: { num: 4, den: 4 },
            pickupQuarters: 0,
            printedBars: 3,
            expectedFifths: 0,
            expectedTempo: { min: 90, max: 110 },
            repeatsUnfoldedInMidi: false,
            performedBars: 3,
        },
    ],
    editionNotes: [],
};

const ref = (bar: number, onsetQ: number, pitch: number, hand: 0 | 1 = 0, durQ = 1): RefNote => ({
    bar,
    onsetQ,
    durQ,
    pitch,
    hand,
});

const scoreOf = (notes: Array<{ t: number; p: number; h?: 0 | 1 }>, dTicks: number[] = [1920, 1920, 1920]): ScoreData => {
    let tick = 0;
    const measures = dTicks.map((d, i) => {
        const m = { n: i + 1, tick, dTicks: d, page: 0, sys: 0, x0: 0, x1: 1, srcIndex: i };
        tick += d;
        return m;
    });
    return {
        version: SCORE_DATA_VERSION,
        ticksPerQuarter: TICKS_PER_QUARTER,
        defaultBpm: 100,
        timeSignatures: [{ tick: 0, num: 4, den: 4 }],
        keySignatures: [{ tick: 0, fifths: 0 }],
        tempos: [{ tick: 0, bpm: 100, src: 'word' }],
        totalTicks: tick,
        notes: notes.map((n) => ({ t: n.t, d: 480, p: n.p, h: n.h ?? 0 })),
        measures,
        systems: [],
        warnings: [],
    };
};

describe('compareScore', () => {
    it('counts one missing note, one semitone, and one merged bar', () => {
        const refs: RefNote[] = [
            ref(1, 0, 60),
            ref(1, 1, 62),
            ref(2, 0, 64),
            ref(2, 1, 65),
            ref(3, 0, 67),
            ref(3, 1, 69),
        ];
        // Bar 1: 62 → 63 (semitone). Bar 2+3 merged into one 3840-tick measure; 69 dropped.
        const score = scoreOf(
            [
                { t: 0, p: 60 },
                { t: 480, p: 63 },
                { t: 1920, p: 64 },
                { t: 2400, p: 65 },
                { t: 3840, p: 67 },
            ],
            [1920, 3840],
        );
        const segmented = segmentMovements(score, entry);
        const result = compareScore(score, entry, [refs], segmented);
        const mov = result.movements[0];
        expect(mov).toBeDefined();
        expect(mov?.missing).toBe(1);
        expect(mov?.semitone).toBe(1);
        expect(mov?.merge2).toBe(1);
        expect(mov?.refNotes).toBe(6);
        expect(mov?.pitchMatch).toBeCloseTo((4 / 6) * 100, 5);
        expect(mov?.barsAtCorrectLength ?? 99).toBeLessThanOrEqual(mov?.omrPrintedBars ?? 0);
    });

    it('pitchSim is 1 for identical multisets', () => {
        const notes = [
            { onsetQ: 0, pitch: 60, hand: 0 as const },
            { onsetQ: 1, pitch: 64, hand: 0 as const },
        ];
        expect(pitchSim(notes, notes)).toBe(1);
        expect(pitchSim(notes, [{ onsetQ: 0, pitch: 61, hand: 0 }])).toBe(0);
    });

    it('skip is strictly dearer than a zero-similarity match', () => {
        expect(ALIGN_SKIP_COST).toBeGreaterThan(1);
    });
});
