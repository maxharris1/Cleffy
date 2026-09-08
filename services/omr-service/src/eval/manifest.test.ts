import { describe, expect, it } from 'vitest';

import { loadCorpusEntry } from './manifest.js';

describe('loadCorpusEntry', () => {
    it('loads the moonlight corpus with three meters', () => {
        const entry = loadCorpusEntry('moonlight');
        expect(entry.movements).toHaveLength(3);
        expect(entry.movements.map((m) => [m.meter.num, m.meter.den])).toEqual([
            [2, 2],
            [3, 4],
            [4, 4],
        ]);
        expect(entry.reference.sha256).toHaveLength(64);
        expect(entry.movements[1]?.pickupQuarters).toBe(1);
    });
});
