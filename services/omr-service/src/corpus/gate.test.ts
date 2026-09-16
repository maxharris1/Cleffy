import { describe, expect, it } from 'vitest';

import { corpusGate, needsReviewError } from './gate.js';
import type { ScoreData } from '../scoreData.js';

/**
 * Staff-band counts and warnings are the ones the seeded corpus actually
 * produced: Mutopia piano scores report two bands on every system, the
 * Internet Archive organ transcription of Op.57 reports one to three, its
 * string-quintet cello part reports one, and the OpenScore string quartet
 * reports four.
 */
const score = (over: Partial<ScoreData> = {}): ScoreData =>
    ({
        version: 5,
        ticksPerQuarter: 480,
        defaultBpm: 90,
        timeSignatures: [{ tick: 0, num: 4, den: 4 }],
        keySignatures: [{ tick: 0, fifths: 0 }],
        totalTicks: 1920,
        notes: [{ t: 0, d: 480, p: 60, h: 0 }],
        measures: [
            { n: 1, tick: 0, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 0.5, srcIndex: 0 },
            { n: 2, tick: 480, dTicks: 480, page: 0, sys: 0, x0: 0.5, x1: 1, srcIndex: 1 },
        ],
        systems: [
            {
                page: 0,
                y0: 0,
                y1: 1,
                staves: [
                    { y0: 0, y1: 0.4 },
                    { y0: 0.6, y1: 1 },
                ],
            },
        ],
        warnings: [],
        ...over,
    }) as ScoreData;

const withStaves = (counts: readonly number[]): ScoreData =>
    score({
        systems: counts.map((count, page) => ({
            page,
            y0: 0,
            y1: 1,
            staves: Array.from({ length: count }, (_, i) => ({ y0: i / count, y1: (i + 1) / count })),
        })),
    });

describe('corpusGate', () => {
    it('promotes a two-staff keyboard score', () => {
        expect(corpusGate({ tier: 'omr', score: score() })).toEqual({ promoted: true });
        expect(corpusGate({ tier: 'omr', score: withStaves([2, 2, 2, 2]) })).toEqual({ promoted: true });
    });

    it('holds back a score whose systems are not two staves', () => {
        // The IA organ transcription filed as Piano Sonata No.23, Op.57.
        expect(corpusGate({ tier: 'omr', score: withStaves([3, 3, 2, 1, 3]) })).toEqual({
            promoted: false,
            reason: 'staves',
        });
        // The OpenScore string quartet full score.
        expect(corpusGate({ tier: 'omr', score: withStaves([4, 4, 4]) })).toEqual({
            promoted: false,
            reason: 'staves',
        });
        // The IA string-quintet cello part.
        expect(corpusGate({ tier: 'omr', score: withStaves([1, 1, 1]) })).toEqual({
            promoted: false,
            reason: 'staves',
        });
    });

    it('holds back a score the parser called single-staff even when geometry is absent', () => {
        expect(
            corpusGate({
                tier: 'omr',
                score: score({ systems: [], warnings: ['single_staff_all_rh'] } as Partial<ScoreData>),
            }),
        ).toEqual({ promoted: false, reason: 'staves' });
    });

    it('passes a payload that carries no staff bands at all (v1-v4 caches)', () => {
        expect(
            corpusGate({ tier: 'omr', score: score({ systems: [{ page: 0, y0: 0, y1: 1 }] } as Partial<ScoreData>) }),
        ).toEqual({ promoted: true });
    });

    it('never gates a symbolic accept: the candidate already aligned onto this PDF', () => {
        expect(corpusGate({ tier: 'symbolic', score: withStaves([4, 4]), siblingPrintedBars: [900] })).toEqual({
            promoted: true,
        });
    });

    it('holds back a score whose bar count no sibling edition comes close to', () => {
        // 2 printed bars against a 105-bar edition of the same movement.
        expect(corpusGate({ tier: 'omr', score: score(), siblingPrintedBars: [105] })).toEqual({
            promoted: false,
            reason: 'bars',
        });
    });

    it('accepts a sibling within the tolerance, and any sibling agreeing is enough', () => {
        expect(corpusGate({ tier: 'omr', score: score(), siblingPrintedBars: [4] })).toEqual({ promoted: true });
        expect(corpusGate({ tier: 'omr', score: score(), siblingPrintedBars: [105, 3] })).toEqual({ promoted: true });
    });

    it('says nothing when there are no siblings or no printed bars to compare', () => {
        expect(corpusGate({ tier: 'omr', score: score(), siblingPrintedBars: [] })).toEqual({ promoted: true });
        expect(corpusGate({ tier: 'omr', score: score({ measures: [] }), siblingPrintedBars: [105] })).toEqual({
            promoted: true,
        });
    });

    it('names the ledger reason', () => {
        expect(needsReviewError('staves')).toBe('needs_review:staves');
        expect(needsReviewError('bars')).toBe('needs_review:bars');
    });
});
