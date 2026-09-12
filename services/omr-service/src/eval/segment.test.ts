import { describe, expect, it } from 'vitest';

import type { ScoreData } from '../scoreData.js';
import { SCORE_DATA_VERSION, TICKS_PER_QUARTER } from '../scoreData.js';
import type { CorpusEntry } from './manifest.js';
import { segmentMovements } from './segment.js';

const entry = (meters: Array<{ num: number; den: number }>): CorpusEntry => ({
    slug: 't',
    title: 't',
    pdf: { url: 'https://example.test/t.pdf', pages: 1 },
    reference: {
        source: 'mutopia',
        url: 'https://example.test/t.zip',
        sha256: '0'.repeat(64),
        license: 'CC',
    },
    movements: meters.map((meter, i) => ({
        name: `M${i + 1}`,
        midi: `m${i + 1}.mid`,
        meter,
        pickupQuarters: 0,
        printedBars: 8,
        expectedFifths: 0,
        expectedTempo: { min: 60, max: 120 },
        repeatsUnfoldedInMidi: false,
    })),
    editionNotes: [],
});

const score = (sigs: Array<{ tick: number; num: number; den: number }>, totalTicks = 10_000): ScoreData => ({
    version: SCORE_DATA_VERSION,
    ticksPerQuarter: TICKS_PER_QUARTER,
    defaultBpm: 100,
    timeSignatures: sigs,
    totalTicks,
    notes: [{ t: 0, d: 480, p: 60, h: 0 }],
    measures: [{ n: 1, tick: 0, dTicks: 1920, page: 0, sys: 0, x0: 0, x1: 1 }],
    systems: [],
    warnings: [],
});

describe('segmentMovements', () => {
    it('splits three concatenated movements on matching meters', () => {
        const result = segmentMovements(
            score([
                { tick: 0, num: 2, den: 2 },
                { tick: 1000, num: 3, den: 4 },
                { tick: 2000, num: 4, den: 4 },
            ]),
            entry([
                { num: 2, den: 2 },
                { num: 3, den: 4 },
                { num: 4, den: 4 },
            ]),
        );
        expect(result.movementCountOk).toBe(true);
        expect(result.metersOk).toBe(true);
        expect(result.slices.map((s) => [s.lo, s.hi])).toEqual([
            [0, 1000],
            [1000, 2000],
            [2000, 10_000],
        ]);
    });

    it('reports a meter mismatch without throwing', () => {
        const result = segmentMovements(
            score([{ tick: 0, num: 4, den: 4 }]),
            entry([
                { num: 2, den: 2 },
                { num: 3, den: 4 },
            ]),
        );
        expect(result.movementCountOk).toBe(false);
        expect(result.metersOk).toBe(false);
        expect(result.slices.every((s) => !s.meterOk)).toBe(true);
    });

    it('does not bind a later movement to a meter flicker inside an earlier one', () => {
        const result = segmentMovements(
            score([
                { tick: 0, num: 2, den: 2 },
                { tick: 500, num: 4, den: 4 },
                { tick: 3000, num: 3, den: 4 },
                { tick: 8000, num: 4, den: 4 },
            ]),
            entry([
                { num: 2, den: 2 },
                { num: 3, den: 4 },
                { num: 4, den: 4 },
            ]),
        );
        expect(result.movementCountOk).toBe(false);
        expect(result.metersOk).toBe(true);
        expect(result.slices.map((s) => [s.lo, s.hi])).toEqual([
            [0, 3000],
            [3000, 8000],
            [8000, 10_000],
        ]);
    });

    it('prefers tempo-heading seams when extra 4/4 signatures would steal a later 4/4 movement', () => {
        const result = segmentMovements(
            {
                ...score(
                    [
                        { tick: 0, num: 4, den: 4 },
                        { tick: 500, num: 4, den: 4 },
                        { tick: 8000, num: 4, den: 4 },
                    ],
                    12_000,
                ),
                tempos: [
                    { tick: 0, bpm: 66, src: 'word' },
                    { tick: 8000, bpm: 172, src: 'word' },
                ],
            },
            entry([
                { num: 4, den: 4 },
                { num: 4, den: 4 },
            ]),
        );
        expect(result.movementCountOk).toBe(false);
        expect(result.metersOk).toBe(true);
        expect(result.slices.map((s) => [s.lo, s.hi])).toEqual([
            [0, 8000],
            [8000, 12_000],
        ]);
    });
});
