import { describe, expect, it } from 'vitest';

import { solve, type DpEvent } from '@/features/fingering/engine/dp';
import { isBlackKey } from '@/features/fingering/model';

const mono = (midis: number[]): DpEvent[] =>
    midis.map((midi) => ({ midis: [midi], blacks: [isBlackKey(midi)] }));

const fingers = (events: DpEvent[], k = 1) => {
    const { assignments, alternativeAssignments } = solve(events, 'standard', { k });
    const primary = assignments.map((a) => a?.[0] ?? null);
    const alts = alternativeAssignments.map((path) => path.map((a) => a?.[0] ?? null));
    return { primary, alts };
};

describe('solve — soft phrase reset', () => {
    it('allows a free restart after an octave-plus leap (5 then 1)', () => {
        // Short ascent ends on 5; +12 leap should restart on 1 rather than stretch.
        const { primary } = fingers([
            ...mono([60, 62, 64, 65, 67]),
            ...mono([79]),
        ]);
        expect(primary[4]).toBe(5);
        expect(primary[5]).toBe(1);
    });
});

describe('solve — monophonic order2 tie-break', () => {
    it('keeps the RH C major one-octave golden', () => {
        const { primary } = fingers(mono([60, 62, 64, 65, 67, 69, 71, 72]));
        expect(primary).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
    });
});

describe('solve — top-k', () => {
    it('returns distinct alternate paths when k>1', () => {
        const { primary, alts } = fingers(mono([60, 62, 64, 65, 67, 69, 71, 72]), 3);
        expect(primary).toEqual([1, 2, 3, 1, 2, 3, 4, 5]);
        // At least one alternate differs somewhere (near-ties on scale endings).
        const distinct = alts.filter((alt) => alt.some((f, i) => f !== primary[i]));
        expect(distinct.length).toBeGreaterThan(0);
    });

    it('with k=1 returns no alternatives', () => {
        const { alts } = fingers(mono([60, 64, 67]), 1);
        expect(alts).toEqual([]);
    });
});
