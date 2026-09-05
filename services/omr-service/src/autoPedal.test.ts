import { describe, expect, it } from 'vitest';

import { inferAutoPedal, MAX_SET_CHANGES_PER_BEAT, UNPEDALLED_GAP_BARS, type AutoPedalScore } from './autoPedal.js';
import { MAX_PEDAL_EDGES } from './caps.js';
import type { Era } from './era.js';
import type { ScoreNote, ScorePedal } from './scoreData.js';

const BAR = 1920;
const BEAT = 480;

const score = (notes: ScoreNote[], bars: number, pedals: ScorePedal[] = []): AutoPedalScore => ({
    notes: [...notes].sort((a, b) => a.t - b.t),
    measures: Array.from({ length: bars }, (_, i) => ({ tick: i * BAR, dTicks: BAR })),
    timeSignatures: [{ tick: 0, num: 4, den: 4 }],
    pedals,
    totalTicks: bars * BAR,
});

/** A block chord in the right hand over a bass note, sounding a full beat. */
const chord = (t: number, pitches: number[], bass: number, d = BEAT): ScoreNote[] => [
    ...pitches.map((p) => ({ t, d, p, h: 0 as const, vc: 0 })),
    { t, d, p: bass, h: 1 as const, vc: 0 },
];

const C = [60, 64, 67];
const F = [65, 69, 72];
const G = [67, 71, 74];

const edges = (result: { pedals: ScorePedal[] }): string[] => result.pedals.map((p) => `${p.k}@${p.tick}`);

describe('inferAutoPedal: harmony', () => {
    it('takes the pedal on the first chord and changes it where the harmony changes', () => {
        const s = score(
            [...chord(0, C, 48), ...chord(BEAT, C, 48), ...chord(2 * BEAT, F, 53), ...chord(3 * BEAT, F, 53)],
            1,
        );
        const result = inferAutoPedal(s, 'romantic');
        expect(result.inferred).toBe(true);
        expect(edges(result)).toEqual(['down@0', 'up@960', 'down@960', `up@${BAR}`]);
        expect(result.pedals.every((p) => p.src === 'inferred')).toBe(true);
    });

    it('does not clear for a note already ringing under the pedal', () => {
        // C major with the melody walking through its own chord tones.
        const s = score(
            [
                ...chord(0, C, 48),
                { t: BEAT, d: BEAT, p: 64, h: 0, vc: 0 },
                { t: 2 * BEAT, d: BEAT, p: 67, h: 0, vc: 0 },
                { t: 3 * BEAT, d: BEAT, p: 72, h: 0, vc: 0 },
            ],
            1,
        );
        expect(edges(inferAutoPedal(s, 'romantic'))).toEqual(['down@0', `up@${BAR}`]);
    });

    it('leaves a note held across the beat alone', () => {
        const s = score([...chord(0, C, 48, 2 * BEAT), ...chord(2 * BEAT, G, 55, 2 * BEAT)], 1);
        expect(edges(inferAutoPedal(s, 'romantic'))).toEqual(['down@0', 'up@960', 'down@960', `up@${BAR}`]);
    });
});

describe('inferAutoPedal: lifts', () => {
    it('lifts for a rest of a beat and takes the pedal again at the next note', () => {
        const s = score([...chord(0, C, 48), ...chord(BEAT, C, 48), ...chord(BAR, F, 53, BAR)], 2);
        expect(edges(inferAutoPedal(s, 'romantic'))).toEqual(['down@0', 'up@960', `down@${BAR}`, `up@${2 * BAR}`]);
    });

    it('stays dry through a staccato passage', () => {
        // Quarters gated to half their length: a staccato dot's gate.
        const staccato = [0, 1, 2, 3].map((i) => ({ t: i * BEAT, d: BEAT / 2, p: 60 + i, h: 0 as const, vc: 0 }));
        const legato = chord(BAR, C, 48, BAR);
        const s = score([...staccato, ...legato], 2);
        expect(edges(inferAutoPedal(s, 'romantic'))).toEqual([`down@${BAR}`, `up@${2 * BAR}`]);
    });

    it('does not mistake a plain note before a rest for a staccato one', () => {
        // A plain quarter (0.9 gate) with a quarter rest after it, then the next
        // chord: short relative to its gap, but not a dot's half.
        const s = score([...chord(0, C, 48, 432), ...chord(2 * BEAT, F, 53, 432), ...chord(3 * BEAT, F, 53, 432)], 1);
        expect(edges(inferAutoPedal(s, 'romantic'))).toEqual(['down@0', 'up@480', 'down@960', `up@${BAR}`]);
    });

    it('lifts when the harmony churns faster than a foot can follow', () => {
        // Four different pitch classes inside one beat: three changes.
        const run = [60, 62, 64, 65].map((p, i) => ({ t: (i * BEAT) / 4, d: BEAT / 4, p, h: 0 as const, vc: 0 }));
        expect(run.length - 1).toBeGreaterThan(MAX_SET_CHANGES_PER_BEAT);
        const s = score([...run, ...chord(BEAT, C, 48, 3 * BEAT)], 1);
        expect(edges(inferAutoPedal(s, 'romantic'))).toEqual(['down@480', `up@${BAR}`]);
    });

    it('lifts mid-phrase for a dry beat and re-takes after it', () => {
        const dry = [0, 1, 2, 3].map((i) => ({
            t: BEAT + (i * BEAT) / 4,
            d: BEAT / 8,
            p: 60 + i,
            h: 0 as const,
            vc: 0,
        }));
        const s = score([...chord(0, C, 48), ...dry, ...chord(2 * BEAT, C, 48, 2 * BEAT)], 1);
        expect(edges(inferAutoPedal(s, 'romantic'))).toEqual(['down@0', 'up@480', 'down@960', `up@${BAR}`]);
    });
});

describe('inferAutoPedal: eras', () => {
    const upperVoiceMoves = score([...chord(0, C, 48), ...chord(BEAT, G, 48), ...chord(2 * BEAT, F, 53)], 1);

    it('plays Baroque music dry', () => {
        const result = inferAutoPedal(upperVoiceMoves, 'baroque');
        expect(result.inferred).toBe(false);
        expect(result.pedals).toEqual([]);
    });

    it('Classical pedalling changes only when the bass moves', () => {
        // G over a C bass at beat 2: no change; F over an F bass at beat 3:
        // change. The silent fourth beat lifts.
        expect(edges(inferAutoPedal(upperVoiceMoves, 'classical'))).toEqual([
            'down@0',
            'up@960',
            'down@960',
            'up@1440',
        ]);
    });

    it('Romantic and modern pedalling change for any new pitch class', () => {
        const romantic = edges(inferAutoPedal(upperVoiceMoves, 'romantic'));
        expect(romantic).toEqual(['down@0', 'up@480', 'down@480', 'up@960', 'down@960', 'up@1440']);
        expect(edges(inferAutoPedal(upperVoiceMoves, 'modern'))).toEqual(romantic);
    });

    it('covers every era', () => {
        const eras: Era[] = ['baroque', 'classical', 'romantic', 'modern'];
        for (const era of eras) {
            expect(() => inferAutoPedal(upperVoiceMoves, era)).not.toThrow();
        }
    });
});

describe('inferAutoPedal: engraved pedalling', () => {
    const bars = UNPEDALLED_GAP_BARS + 4;
    const notes = Array.from({ length: bars * 4 }, (_, i) =>
        chord(i * BEAT, i % 2 === 0 ? C : F, i % 2 === 0 ? 48 : 53),
    ).flat();

    it('leaves a marked-up score alone when its gaps are short', () => {
        const printed: ScorePedal[] = [
            { tick: 0, k: 'down' },
            { tick: 2 * BAR, k: 'up' },
            { tick: 6 * BAR, k: 'down' },
            { tick: bars * BAR - 1, k: 'up' },
        ];
        const result = inferAutoPedal(score(notes, bars, printed), 'romantic');
        expect(result.inferred).toBe(false);
        expect(result.pedals).toEqual(printed);
    });

    it('fills only a long unpedalled gap, handing back to the printed depression', () => {
        const printed: ScorePedal[] = [
            { tick: 0, k: 'down' },
            { tick: 2 * BAR, k: 'up' },
            { tick: (2 + UNPEDALLED_GAP_BARS) * BAR, k: 'down' },
            { tick: bars * BAR - 1, k: 'up' },
        ];
        const result = inferAutoPedal(score(notes, bars, printed), 'romantic');
        expect(result.inferred).toBe(true);
        const inferred = result.pedals.filter((p) => !printed.includes(p));
        expect(inferred.length).toBeGreaterThan(0);
        for (const edge of inferred) {
            expect(edge.tick).toBeGreaterThanOrEqual(2 * BAR);
            expect(edge.tick).toBeLessThanOrEqual((2 + UNPEDALLED_GAP_BARS) * BAR);
            expect(edge.src).toBe('inferred');
        }
        // Printed edges keep their identity so the client can tell the two apart.
        expect(result.pedals.filter((p) => p.src === undefined)).toEqual(printed);
        // The gap closes with a lift, and the printed depression on that tick follows it.
        const seam = (2 + UNPEDALLED_GAP_BARS) * BAR;
        const atSeam = result.pedals.filter((p) => p.tick === seam).map((p) => p.k);
        expect(atSeam).toEqual(['up', 'down']);
        // Tick order throughout.
        for (let i = 1; i < result.pedals.length; i++) {
            expect(result.pedals[i]?.tick ?? 0).toBeGreaterThanOrEqual(result.pedals[i - 1]?.tick ?? 0);
        }
    });
});

describe('inferAutoPedal: the ceiling', () => {
    it('coarsens to a change per bar when beat-level changes would breach the cap', () => {
        // Two harmonies a bar, the pair alternating by bar: 70 bars → 140
        // beat-level changes → 282 edges, over the ceiling. Per bar the union
        // still alternates, so a change per bar remains.
        const bars = 70;
        const Dm = [62, 65, 69];
        const notes = Array.from({ length: bars * 4 }, (_, i) => {
            const bar = Math.floor(i / 4);
            const second = i % 4 >= 2;
            const pitches = bar % 2 === 0 ? (second ? F : C) : second ? Dm : G;
            const bass = bar % 2 === 0 ? (second ? 53 : 48) : second ? 50 : 55;
            return chord(i * BEAT, pitches, bass);
        }).flat();
        const result = inferAutoPedal(score(notes, bars), 'romantic');
        expect(result.inferred).toBe(true);
        expect(result.pedals.length).toBeLessThanOrEqual(MAX_PEDAL_EDGES);
        expect(result.pedals.length).toBe(2 + 2 * (bars - 1));
        for (const edge of result.pedals) {
            expect(edge.tick % BAR).toBe(0);
        }
        expect(result.pedals[0]).toEqual({ tick: 0, k: 'down', src: 'inferred' });
        expect(result.pedals[result.pedals.length - 1]).toEqual({ tick: bars * BAR, k: 'up', src: 'inferred' });
    });
});
