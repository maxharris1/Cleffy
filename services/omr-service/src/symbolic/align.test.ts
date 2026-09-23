import { describe, expect, it } from 'vitest';

import { fetchCorpus } from '../eval/fetch.js';
import { loadCorpusEntry } from '../eval/manifest.js';
import { readFileSync } from 'node:fs';
import { TICKS_PER_QUARTER } from '../scoreData.js';
import type { ScoreData } from '../scoreData.js';
import { alignMutopia } from './align.js';
import { pdfLayoutFromBytes } from './pdfLayout.js';
import { scoreDataFromMidi } from './midiScore.js';
import { midiForPin } from './evalRun.js';

const loadLayout = async (slug: string) => {
    const entry = loadCorpusEntry(slug);
    const fetched = await fetchCorpus(entry, { allowNetwork: true, mode: 'all' });
    if (fetched.pdfPath === null) {
        throw new Error(`${slug}: PDF missing`);
    }
    return pdfLayoutFromBytes(new Uint8Array(readFileSync(fetched.pdfPath)));
};

describe('alignMutopia', () => {
    it('covers every printed measure on a 1-page piece (Czerny)', async () => {
        const entry = loadCorpusEntry('czerny-op821-01');
        const layout = await loadLayout('czerny-op821-01');
        const midi = midiForPin(entry);
        const mov = entry.movements[0]!;
        const score = scoreDataFromMidi(midi, {
            meter: mov.meter,
            pickupQuarters: mov.pickupQuarters,
            fifths: mov.expectedFifths,
        });
        const result = alignMutopia(layout, score, 'pdf', 'cand');
        expect(result.ok, result.ok ? '' : result.reason).toBe(true);
        if (!result.ok) {
            return;
        }
        const printed = new Set(score.measures.map((m) => m.srcIndex ?? m.n));
        for (const src of printed) {
            expect(result.map.bySrcIndex[src], `srcIndex ${src}`).toBeTruthy();
        }
        expect(result.map.entries.length).toBe(score.measures.length);
        expect(result.map.bySrcIndex[0]?.page).toBe(0);
    }, 60_000);

    it('rejects alignment_failed when box count and printed measures differ by >1', () => {
        const score: ScoreData = {
            version: 3,
            ticksPerQuarter: TICKS_PER_QUARTER,
            defaultBpm: 80,
            timeSignatures: [{ tick: 0, num: 4, den: 4 }],
            keySignatures: [],
            totalTicks: 4,
            notes: [{ t: 0, d: 480, p: 60, h: 0 }],
            measures: [
                { n: 1, tick: 0, dTicks: 1920, page: -1, sys: -1, x0: 0, x1: 1, srcIndex: 0 },
                { n: 2, tick: 1920, dTicks: 1920, page: -1, sys: -1, x0: 0, x1: 1, srcIndex: 1 },
            ],
            systems: [],
            warnings: [],
        };
        const result = alignMutopia(
            {
                boxes: [
                    { page: 0, system: 0, x0: 0.1, x1: 0.3, y0: 0.1, y1: 0.2 },
                    { page: 0, system: 0, x0: 0.3, x1: 0.5, y0: 0.1, y1: 0.2 },
                    { page: 0, system: 0, x0: 0.5, x1: 0.7, y0: 0.1, y1: 0.2 },
                    { page: 0, system: 0, x0: 0.7, x1: 0.9, y0: 0.1, y1: 0.2 },
                ],
                pickupFlagged: false,
                printedBars: 4,
            },
            score,
            'pdf',
            'cand',
        );
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }
        expect(result.reason).toBe('alignment_failed');
    });
});
