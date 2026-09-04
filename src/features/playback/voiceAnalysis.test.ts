import { describe, expect, it } from 'vitest';

import { tinyScore } from '@/features/playback/fixtures/tinyScore';
import { analyzeVoices, handOfVoice, voiceKey } from '@/features/playback/voiceAnalysis';
import type { ScoreData, ScoreNote } from '@/types/scoreData';

const FOUR_FOUR = [{ tick: 0, num: 4, den: 4 }];

/** A score of `bars` 4/4 measures over the given notes; the notes must be tick-sorted. */
const scoreOf = (notes: ScoreNote[], bars: number): ScoreData => ({
    ...tinyScore,
    timeSignatures: FOUR_FOUR,
    totalTicks: bars * 1920,
    notes,
    measures: Array.from({ length: bars }, (_, i) => ({
        n: i + 1,
        tick: i * 1920,
        dTicks: 1920,
        page: 0,
        sys: 0,
        x0: 0.1,
        x1: 0.9,
    })),
});

/** Plain-gated duration, as the service writes it. */
const plain = (written: number): number => Math.round(written * 0.9);

const sortNotes = (notes: ScoreNote[]): ScoreNote[] => [...notes].sort((a, b) => a.t - b.t || a.h - b.h || a.p - b.p);

/** Alberti bass C–G–E–G in eighths, one bar, starting at `bar`. */
const alberti = (bar: number): ScoreNote[] =>
    [48, 55, 52, 55, 48, 55, 52, 55].map((p, i) => ({ t: bar * 1920 + i * 240, d: plain(240), p, h: 1 as const }));

/** A stepwise RH tune in quarters, one bar. */
const tune = (bar: number, pitches: number[], vc?: number): ScoreNote[] =>
    pitches.map((p, i) => ({
        t: bar * 1920 + i * 480,
        d: plain(480),
        p,
        h: 0 as const,
        ...(vc !== undefined ? { vc } : {}),
    }));

describe('voiceKey', () => {
    it('separates hands, and slots within a hand, and reads a missing slot as 0', () => {
        expect(voiceKey({ t: 0, d: 1, p: 60, h: 0 })).toBe(voiceKey({ t: 0, d: 1, p: 60, h: 0, vc: 0 }));
        expect(voiceKey({ t: 0, d: 1, p: 60, h: 0, vc: 1 })).not.toBe(voiceKey({ t: 0, d: 1, p: 60, h: 0 }));
        expect(voiceKey({ t: 0, d: 1, p: 60, h: 1 })).not.toBe(voiceKey({ t: 0, d: 1, p: 60, h: 0, vc: 7 }));
        expect(handOfVoice(voiceKey({ t: 0, d: 1, p: 60, h: 1, vc: 3 }))).toBe(1);
        expect(handOfVoice(voiceKey({ t: 0, d: 1, p: 60, h: 0, vc: 7 }))).toBe(0);
    });
});

describe('analyzeVoices', () => {
    it('is index-aligned with the notes', () => {
        const analysis = analyzeVoices(tinyScore);
        for (const field of [
            analysis.voiceOf,
            analysis.nextInVoice,
            analysis.legato,
            analysis.accompaniment,
            analysis.phraseStart,
        ]) {
            expect(field).toHaveLength(tinyScore.notes.length);
        }
        expect(analysis.melodyVoiceByBar).toHaveLength(tinyScore.measures.length);
    });

    it('finds the successor within a voice, sharing it across a chord', () => {
        const notes = sortNotes([
            { t: 0, d: 432, p: 72, h: 0, vc: 0 },
            { t: 0, d: 864, p: 60, h: 0, vc: 1 },
            { t: 480, d: 432, p: 74, h: 0, vc: 0 },
            { t: 480, d: 432, p: 77, h: 0, vc: 0 },
            { t: 960, d: 432, p: 76, h: 0, vc: 0 },
            { t: 960, d: 864, p: 62, h: 0, vc: 1 },
        ]);
        const analysis = analyzeVoices(scoreOf(notes, 1));
        const at = (t: number, p: number): number => notes.findIndex((n) => n.t === t && n.p === p);
        expect(analysis.nextInVoice[at(0, 72)]).toBe(at(480, 74));
        expect(analysis.nextInVoice[at(480, 74)]).toBe(at(960, 76));
        expect(analysis.nextInVoice[at(480, 77)]).toBe(at(960, 76));
        expect(analysis.nextInVoice[at(0, 60)]).toBe(at(960, 62));
        expect(analysis.nextInVoice[at(960, 76)]).toBe(-1);
        expect(analysis.nextInVoice[at(960, 62)]).toBe(-1);
    });

    it('treats a v4 score as one voice per hand', () => {
        const analysis = analyzeVoices(tinyScore);
        const rh = tinyScore.notes.map((n, i) => (n.h === 0 ? analysis.voiceOf[i] : null)).filter((v) => v !== null);
        const lh = tinyScore.notes.map((n, i) => (n.h === 1 ? analysis.voiceOf[i] : null)).filter((v) => v !== null);
        expect(new Set(rh).size).toBe(1);
        expect(new Set(lh).size).toBe(1);
        expect(rh[0]).not.toBe(lh[0]);
    });

    describe('legato', () => {
        it('marks a plain note that runs into the next of its voice', () => {
            const analysis = analyzeVoices(scoreOf(tune(0, [72, 74, 76, 77]), 1));
            expect(analysis.legato).toEqual([true, true, true, false]);
        });

        it('does not mark staccato or portato notes', () => {
            const staccato = tune(0, [72, 74, 76, 77]).map((n) => ({ ...n, d: 240 }));
            const portato = tune(0, [72, 74, 76, 77]).map((n) => ({ ...n, d: 336 }));
            expect(analyzeVoices(scoreOf(staccato, 1)).legato).toEqual([false, false, false, false]);
            expect(analyzeVoices(scoreOf(portato, 1)).legato).toEqual([false, false, false, false]);
        });

        it('does not mark a note followed by a rest in its voice', () => {
            const notes: ScoreNote[] = [
                { t: 0, d: plain(480), p: 72, h: 0 },
                { t: 960, d: plain(480), p: 74, h: 0 },
            ];
            expect(analyzeVoices(scoreOf(notes, 1)).legato).toEqual([false, false]);
        });

        it('never joins two voices, even when they interleave in one hand', () => {
            const notes = sortNotes([
                { t: 0, d: plain(480), p: 72, h: 0, vc: 0 },
                { t: 480, d: plain(480), p: 60, h: 0, vc: 1 },
                { t: 960, d: plain(480), p: 74, h: 0, vc: 0 },
            ]);
            const analysis = analyzeVoices(scoreOf(notes, 1));
            // 72 → 74 is the voice-0 line, with a full beat between: not adjacent.
            expect(analysis.legato).toEqual([false, false, false]);
            expect(analysis.nextInVoice[0]).toBe(2);
        });
    });

    describe('melody voice', () => {
        it('picks the stepwise upper line over an Alberti bass', () => {
            const notes = sortNotes([
                ...tune(0, [72, 74, 76, 77]),
                ...alberti(0),
                ...tune(1, [79, 77, 76, 74]),
                ...alberti(1),
            ]);
            const analysis = analyzeVoices(scoreOf(notes, 2));
            const rh = voiceKey({ t: 0, d: 1, p: 72, h: 0 });
            expect(analysis.melodyVoiceByBar).toEqual([rh, rh]);
        });

        it('lets a walking left-hand tune win over repeated right-hand chords', () => {
            const chords: ScoreNote[] = [];
            const bass: ScoreNote[] = [];
            const line = [48, 50, 52, 53, 55, 53, 52, 50];
            for (let bar = 0; bar < 2; bar++) {
                for (let beat = 0; beat < 4; beat++) {
                    const t = bar * 1920 + beat * 480;
                    chords.push(
                        { t, d: plain(480), p: 64, h: 0 },
                        { t, d: plain(480), p: 67, h: 0 },
                        { t, d: plain(480), p: 72, h: 0 },
                    );
                    bass.push({ t, d: plain(480), p: line[bar * 4 + beat] ?? 48, h: 1 });
                }
            }
            const analysis = analyzeVoices(scoreOf(sortNotes([...chords, ...bass]), 2));
            const lh = voiceKey({ t: 0, d: 1, p: 48, h: 1 });
            expect(analysis.melodyVoiceByBar).toEqual([lh, lh]);
        });

        it('keeps the tune through a bar it is held across, and marks an empty stretch -1', () => {
            const notes = sortNotes([
                { t: 0, d: 3840 - 192, p: 81, h: 0 }, // two bars, gated
                ...alberti(0),
                ...alberti(1),
            ]);
            const analysis = analyzeVoices(scoreOf(notes, 4));
            const rh = voiceKey({ t: 0, d: 1, p: 81, h: 0 });
            expect(analysis.melodyVoiceByBar.slice(0, 2)).toEqual([rh, rh]);
            // Bar 2 still sees bar 1; bar 3 sees nothing at all.
            expect(analysis.melodyVoiceByBar[3]).toBe(-1);
        });

        it('follows an inner voice when the slots say the tune moved there', () => {
            // Voice 1 walks stepwise inside the hand; voice 0 holds a pedal tone above it.
            const notes = sortNotes([
                { t: 0, d: 1920 - 192, p: 84, h: 0, vc: 0 },
                { t: 1920, d: 1920 - 192, p: 84, h: 0, vc: 0 },
                ...tune(0, [72, 74, 76, 77], 1),
                ...tune(1, [79, 77, 76, 74], 1),
            ]);
            const analysis = analyzeVoices(scoreOf(notes, 2));
            const inner = voiceKey({ t: 0, d: 1, p: 72, h: 0, vc: 1 });
            expect(analysis.melodyVoiceByBar).toEqual([inner, inner]);
        });
    });

    describe('accompaniment', () => {
        it('flags a bass that repeats last bar\u2019s figure under the tune, from its second bar on', () => {
            const notes = sortNotes([
                ...tune(0, [72, 74, 76, 77]),
                ...alberti(0),
                ...tune(1, [79, 77, 76, 74]),
                ...alberti(1),
            ]);
            const analysis = analyzeVoices(scoreOf(notes, 2));
            const flagged = notes
                .map((n, i) => (analysis.accompaniment[i] ? `${n.h}@${n.t}` : null))
                .filter((v) => v !== null);
            expect(flagged).toEqual(alberti(1).map((n) => `1@${n.t}`));
        });

        it('does not flag the figure when it is the only voice sounding', () => {
            const analysis = analyzeVoices(scoreOf(sortNotes([...alberti(0), ...alberti(1)]), 2));
            expect(analysis.accompaniment.some(Boolean)).toBe(false);
        });

        it('does not flag a bass whose intervals changed with the harmony', () => {
            const moved = alberti(1).map((n, i) => ({ ...n, p: [50, 57, 54, 57, 50, 57, 54, 57][i] ?? n.p }));
            const shuffled = alberti(1).map((n, i) => ({ ...n, p: [50, 53, 57, 62, 50, 53, 57, 62][i] ?? n.p }));
            const same = analyzeVoices(
                scoreOf(
                    sortNotes([...tune(0, [72, 74, 76, 77]), ...alberti(0), ...tune(1, [79, 77, 76, 74]), ...moved]),
                    2,
                ),
            );
            const differ = analyzeVoices(
                scoreOf(
                    sortNotes([...tune(0, [72, 74, 76, 77]), ...alberti(0), ...tune(1, [79, 77, 76, 74]), ...shuffled]),
                    2,
                ),
            );
            // Transposed figure: identical intervals, still accompaniment.
            expect(same.accompaniment.filter(Boolean)).toHaveLength(8);
            // Different shape: not the same figure.
            expect(differ.accompaniment.some(Boolean)).toBe(false);
        });
    });

    describe('phraseStart', () => {
        it('marks the first note of a voice and the first after a rest of a beat or more', () => {
            const notes: ScoreNote[] = [
                { t: 0, d: plain(480), p: 72, h: 0 },
                { t: 480, d: plain(480), p: 74, h: 0 },
                { t: 1440, d: plain(480), p: 76, h: 0 }, // after a one-beat rest
                { t: 1920, d: plain(480), p: 77, h: 0 },
            ];
            expect(analyzeVoices(scoreOf(notes, 2)).phraseStart).toEqual([true, false, true, false]);
        });

        it('does not read a long note\u2019s articulation gap as a rest', () => {
            const notes: ScoreNote[] = [
                { t: 0, d: plain(7680), p: 72, h: 0 }, // four tied bars; 768 ticks of gap
                { t: 7680, d: plain(480), p: 74, h: 0 },
            ];
            expect(analyzeVoices(scoreOf(notes, 5)).phraseStart).toEqual([true, false]);
        });

        it('marks every member of a chord the same way', () => {
            const notes: ScoreNote[] = [
                { t: 0, d: plain(480), p: 72, h: 0 },
                { t: 960, d: plain(480), p: 72, h: 0 },
                { t: 960, d: plain(480), p: 76, h: 0 },
            ];
            expect(analyzeVoices(scoreOf(notes, 1)).phraseStart).toEqual([true, true, true]);
        });
    });

    it('is deterministic', () => {
        const notes = sortNotes([
            ...tune(0, [72, 74, 76, 77]),
            ...alberti(0),
            ...tune(1, [79, 77, 76, 74]),
            ...alberti(1),
        ]);
        const score = scoreOf(notes, 2);
        expect(analyzeVoices(score)).toEqual(analyzeVoices(score));
    });
});
