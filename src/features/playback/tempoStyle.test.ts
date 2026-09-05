import { describe, expect, it } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import { buildTempoMap, secondsAtTick } from '@/features/playback/scoreTime';
import {
    EXPRESSIVE_FINAL_RIT_FACTOR,
    expressiveTempoCurve,
    PHRASE_AGOGIC_FACTOR,
    SECTION_BROADENING_FACTOR,
} from '@/features/playback/tempoStyle';
import type { ScoreData, ScoreMeasure, ScoreNote } from '@/types/scoreData';

const bar = (n: number, tick: number, dTicks: number, srcIndex: number): ScoreMeasure => ({
    n,
    tick,
    dTicks,
    page: 0,
    sys: 0,
    x0: 0,
    x1: 1,
    srcIndex,
});

/** A 4/4 score of `bars` full bars at 120, with no notes unless given. */
const fourFour = (bars: number, over: Partial<ScoreData> = {}): ScoreData => ({
    ...tinyScore,
    defaultBpm: 120,
    totalTicks: bars * 1920,
    timeSignatures: [{ tick: 0, num: 4, den: 4 }],
    tempos: [{ tick: 0, bpm: 120 }],
    holds: undefined,
    measures: Array.from({ length: bars }, (_, i) => bar(i + 1, i * 1920, 1920, i)),
    notes: [],
    ...over,
});

/** The factor in force at `tick` under a step curve. */
const factorAt = (curve: ReadonlyArray<{ tick: number; factor: number }>, tick: number): number => {
    let factor = 1;
    for (const point of curve) {
        if (point.tick > tick) {
            break;
        }
        factor = point.factor;
    }
    return factor;
};

describe('expressiveTempoCurve: final ritardando', () => {
    it('eases the last two bars beat by beat from 1.0 to 0.75', () => {
        const curve = expressiveTempoCurve(fourFour(4));
        // Eight beats from 3840: the first is unbent so has no point of its own.
        expect(factorAt(curve, 3840)).toBe(1);
        expect(factorAt(curve, 3839)).toBe(1);
        for (let k = 1; k < 8; k++) {
            expect(factorAt(curve, 3840 + 480 * k)).toBeCloseTo(1 + (EXPRESSIVE_FINAL_RIT_FACTOR - 1) * (k / 7), 10);
        }
        expect(factorAt(curve, 7200)).toBe(EXPRESSIVE_FINAL_RIT_FACTOR);
        // Closed at the end, so nothing leaks past the score.
        expect(curve[curve.length - 1]).toEqual({ tick: 7680, factor: 1 });
    });

    it('takes four bars in a long piece', () => {
        const curve = expressiveTempoCurve(fourFour(64));
        const start = 60 * 1920;
        expect(factorAt(curve, start - 1)).toBe(1);
        expect(factorAt(curve, start + 480)).toBeLessThan(1);
        expect(factorAt(curve, 64 * 1920 - 480)).toBe(EXPRESSIVE_FINAL_RIT_FACTOR);
    });

    it('defers to a printed ramp in the closing bars, leaving only the end broadening', () => {
        const curve = expressiveTempoCurve(
            fourFour(4, {
                tempos: [
                    { tick: 0, bpm: 120 },
                    { tick: 6000, bpm: 90, src: 'ramp' },
                ],
            }),
        );
        expect(factorAt(curve, 5760)).toBe(1);
        expect(factorAt(curve, 6720)).toBe(1);
        expect(factorAt(curve, 7200)).toBe(SECTION_BROADENING_FACTOR);
    });

    it('defers to a fermata in the last bar, but still broadens into it', () => {
        const curve = expressiveTempoCurve(fourFour(4, { holds: [{ tick: 7200, beats: 2 }] }));
        expect(factorAt(curve, 5760)).toBe(1);
        expect(factorAt(curve, 6240)).toBe(1);
        // The beat before the fermata, and the beat before the end.
        expect(factorAt(curve, 6720)).toBe(SECTION_BROADENING_FACTOR);
        expect(factorAt(curve, 7200)).toBe(SECTION_BROADENING_FACTOR);
    });

    it('adds nothing for a hold engraved past the end of the score', () => {
        const plain = expressiveTempoCurve(fourFour(4));
        const beyond = expressiveTempoCurve(fourFour(4, { holds: [{ tick: 7680 + 960, beats: 2 }] }));
        expect(beyond).toEqual(plain);
        expect(beyond.every((point) => point.tick <= 7680)).toBe(true);
    });

    it('closes each movement of a two-movement score', () => {
        const curve = expressiveTempoCurve(
            fourFour(4, {
                measures: [bar(1, 0, 1920, 0), bar(2, 1920, 1920, 1), bar(1, 3840, 1920, 2), bar(2, 5760, 1920, 3)],
            }),
        );
        expect(factorAt(curve, 3360)).toBe(EXPRESSIVE_FINAL_RIT_FACTOR);
        expect(factorAt(curve, 3840)).toBe(1); // the second movement starts in tempo
        expect(factorAt(curve, 7200)).toBe(EXPRESSIVE_FINAL_RIT_FACTOR);
    });
});

describe('expressiveTempoCurve: section broadening', () => {
    it('broadens the beat before a repeat seam', () => {
        // Bars 1-2 played twice: srcIndex goes 0,1,0,1 so the seam is at 3840.
        const curve = expressiveTempoCurve(
            fourFour(4, {
                measures: [bar(1, 0, 1920, 0), bar(2, 1920, 1920, 1), bar(1, 3840, 1920, 0), bar(2, 5760, 1920, 1)],
            }),
        );
        expect(factorAt(curve, 3360)).toBe(SECTION_BROADENING_FACTOR);
        expect(factorAt(curve, 2880)).toBe(1);
        expect(factorAt(curve, 3840)).toBe(1); // the reprise starts in tempo…
        expect(factorAt(curve, 4320)).toBeLessThan(1); // …and the final rit bends from its second beat
    });

    it('does not double up where the final ritardando is already slowing', () => {
        const curve = expressiveTempoCurve(fourFour(4));
        // The score's end is a boundary, but its last beat belongs to the rit.
        expect(factorAt(curve, 7200)).toBe(EXPRESSIVE_FINAL_RIT_FACTOR);
    });
});

describe('expressiveTempoCurve: phrase-initial agogic', () => {
    // One melody voice: bars 1-2 stepwise, a whole-bar rest in bar 3, then it
    // re-enters on the downbeat of bar 4 of an eight-bar piece.
    const melody: ScoreNote[] = [];
    for (let i = 0; i < 8; i++) {
        melody.push({ t: 480 * i, d: 480, p: 72 + (i % 4), h: 0, vc: 0 });
    }
    for (let i = 0; i < 8; i++) {
        melody.push({ t: 5760 + 480 * i, d: 480, p: 72 + (i % 4), h: 0, vc: 0 });
    }
    const breathing = fourFour(8, { notes: melody });

    it('takes a little time on the downbeat where the melody re-enters after a rest', () => {
        const curve = expressiveTempoCurve(breathing);
        expect(factorAt(curve, 5760)).toBe(PHRASE_AGOGIC_FACTOR);
        expect(factorAt(curve, 6240)).toBe(1);
        // Not on the very first note: nothing to breathe after.
        expect(factorAt(curve, 0)).toBe(1);
    });

    it('does not treat a note that merely follows another as a phrase start', () => {
        const curve = expressiveTempoCurve(breathing);
        expect(factorAt(curve, 1920)).toBe(1);
    });
});

describe('expressiveTempoCurve through the tempo map', () => {
    it('makes the last beat 1/0.75 as long as a strict one', () => {
        const score = fourFour(4);
        const strict = buildTempoMap(score, 1, 120);
        const expressive = buildTempoMap(score, 1, 120, expressiveTempoCurve(score));
        const strictBeat = secondsAtTick(strict, 3840) - secondsAtTick(strict, 3360);
        const lastBeat = secondsAtTick(expressive, 7680) - secondsAtTick(expressive, 7200);
        expect(strictBeat).toBeCloseTo(0.5, 9);
        expect(lastBeat).toBeCloseTo(0.5 / EXPRESSIVE_FINAL_RIT_FACTOR, 9);
        // Everything before the rit is untouched.
        expect(secondsAtTick(expressive, 3840)).toBeCloseTo(secondsAtTick(strict, 3840), 9);
    });

    it('is deterministic', () => {
        expect(expressiveTempoCurve(tinyScore)).toEqual(expressiveTempoCurve(tinyScore));
    });
});
