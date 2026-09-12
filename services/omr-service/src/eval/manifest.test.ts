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
        expect(entry.reference.source).toBe('mutopia');
        if (entry.reference.source === 'mutopia') {
            expect(entry.reference.sha256).toHaveLength(64);
        }
        expect(entry.movements[1]?.pickupQuarters).toBe(1);
        expect(entry.pdf.sha256).toBeUndefined();
    });

    it('rejects a path-traversal slug before reading a file', () => {
        expect(() => loadCorpusEntry('../../package')).toThrow(/kebab-case|Invalid corpus slug/);
    });

    it('loads the toy fixture corpus', () => {
        const entry = loadCorpusEntry('toy');
        expect(entry.reference.source).toBe('fixture');
        expect(entry.movements[0]?.midi).toBe('toy.mid');
    });

    it('loads the short Mutopia pins used for MIDI verification', () => {
        const anna = loadCorpusEntry('anna-magdalena-04');
        expect(anna.pdf.pages).toBe(1);
        expect(anna.pdf.sha256).toHaveLength(64);
        expect(anna.movements[0]?.printedBars).toBe(32);
        expect(anna.movements[0]?.performedBars).toBe(64);
        expect(anna.movements[0]?.repeatsUnfoldedInMidi).toBe(false);

        const prelude = loadCorpusEntry('wtk1-prelude1');
        expect(prelude.pdf.pages).toBe(2);
        expect(prelude.pdf.sha256).toHaveLength(64);
        expect(prelude.movements[0]?.printedBars).toBe(35);
        expect(prelude.movements[0]?.repeatsUnfoldedInMidi).toBe(false);
    });
});
