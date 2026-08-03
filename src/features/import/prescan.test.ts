import { describe, expect, it } from 'vitest';

import { PRESCAN_SAMPLES, prescanSampleIndices } from '@/features/import/prescan';

describe('prescanSampleIndices', () => {
    it('covers every page of a short score', () => {
        expect(prescanSampleIndices(1)).toEqual([0]);
        expect(prescanSampleIndices(4)).toEqual([0, 1, 2, 3]);
    });

    it('spreads samples across a 30-page score, ends included', () => {
        const indices = prescanSampleIndices(30);
        expect(indices).toHaveLength(PRESCAN_SAMPLES);
        expect(indices[0]).toBe(0);
        expect(indices[indices.length - 1]).toBe(29);
        // Middle movement pages are reachable — no gap larger than a third of the score.
        for (let i = 1; i < indices.length; i++) {
            expect((indices[i] ?? 0) - (indices[i - 1] ?? 0)).toBeLessThanOrEqual(10);
        }
    });

    it('handles the empty document', () => {
        expect(prescanSampleIndices(0)).toEqual([]);
    });
});
