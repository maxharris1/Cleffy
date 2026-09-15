import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fetchCorpus } from '../eval/fetch.js';
import { loadCorpusEntry } from '../eval/manifest.js';
import { pdfLayoutFromBytes } from './pdfLayout.js';
import { pdfSignalsFromArtifact, pdfSignalsFromPdf } from './pdfRead.js';
import { fifthsFromPdfLayout, workKeyFromPdfLayout } from './pdfText.js';
import { packageRoot } from '../eval/paths.js';
import { join } from 'node:path';

const loadPinnedPdf = async (slug: string): Promise<Buffer> => {
    const entry = loadCorpusEntry(slug);
    const fetched = await fetchCorpus(entry, { allowNetwork: true, mode: 'all' });
    if (fetched.pdfPath === null) {
        throw new Error(`${slug}: PDF not cached and fetch failed`);
    }
    return readFileSync(fetched.pdfPath);
};

describe('pdfSignalsFromPdf — layout bar count', () => {
    const cases: Array<{ slug: string; pin: number; pickup: boolean }> = [
        { slug: 'czerny-op821-01', pin: 8, pickup: false },
        { slug: 'anna-magdalena-04', pin: 32, pickup: false },
        { slug: 'burgmuller-op100-02', pin: 33, pickup: false },
        { slug: 'gymnopedie-2', pin: 65, pickup: false },
    ];

    it('matches pin printedBars ±1 on four Mutopia PDFs', async () => {
        for (const row of cases) {
            const bytes = await loadPinnedPdf(row.slug);
            const signals = await pdfSignalsFromPdf(bytes);
            const delta = Math.abs(signals.layoutBars - row.pin);
            expect(delta, `${row.slug} layout=${signals.layoutBars} pin=${row.pin}`).toBeLessThanOrEqual(1);
            expect(signals.pickupFlagged, `${row.slug} pickup`).toBe(row.pickup);
            expect(signals.opening).toBeNull();
        }
    }, 120_000);

    it('flags pickup when the first bar is narrower (Für Elise)', async () => {
        const entry = loadCorpusEntry('fur-elise-mutopia');
        const bytes = await loadPinnedPdf('fur-elise-mutopia');
        const signals = await pdfSignalsFromPdf(bytes);
        expect(entry.movements[0]?.pickupQuarters).toBeGreaterThan(0);
        expect(signals.pickupFlagged).toBe(true);
    }, 60_000);
});

describe('pdfSignalsFromPdf — WorkKey from Mutopia header', () => {
    it('reads BWV 772 from the Invention 1 PDF', async () => {
        const bytes = await loadPinnedPdf('bach-invention-01');
        const layout = await pdfLayoutFromBytes(new Uint8Array(bytes));
        expect(workKeyFromPdfLayout(layout)).toMatchObject({
            composerId: 'bach',
            catalogType: 'BWV',
            catalogN: 772,
        });
    }, 60_000);

    it('reads WoO 59 from the Für Elise PDF', async () => {
        const bytes = await loadPinnedPdf('fur-elise-mutopia');
        const layout = await pdfLayoutFromBytes(new Uint8Array(bytes));
        expect(workKeyFromPdfLayout(layout)).toMatchObject({
            composerId: 'beethoven',
            catalogType: 'WoO',
            catalogN: 59,
        });
        expect(fifthsFromPdfLayout(layout)).toBe(0);
    }, 60_000);
});

describe('pdfSignalsFromArtifact', () => {
    it('reads meter, fifths, measures, and an opening bag from a MusicXML artifact', () => {
        const dir = join(packageRoot(), 'test/fixtures');
        const art = pdfSignalsFromArtifact(dir);
        expect(art.meter.num).toBeGreaterThan(0);
        expect(art.measureCount).toBeGreaterThan(0);
        expect(art.opening.length).toBeGreaterThan(0);
        expect(art.opening[0]?.length).toBeGreaterThan(0);
    });
});
