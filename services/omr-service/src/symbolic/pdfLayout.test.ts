import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

    it('flags Chopin Op. 28/4 pickup and counts the anacrusis as the extra box', async () => {
        const entry = loadCorpusEntry('chopin-prelude-4');
        const bytes = await loadPinnedPdf('chopin-prelude-4');
        const signals = await pdfSignalsFromPdf(bytes);
        expect(entry.movements[0]?.pickupQuarters).toBe(1);
        expect(signals.pickupFlagged).toBe(true);
        expect(Math.abs(signals.layoutBars - (entry.movements[0]?.printedBars ?? 0))).toBe(1);
    }, 60_000);

    it('counts Schumann Op. 68/5 anacrusis as ±1 vs pin even when the first box is not narrow', async () => {
        const entry = loadCorpusEntry('schumann-op68-05');
        const bytes = await loadPinnedPdf('schumann-op68-05');
        const signals = await pdfSignalsFromPdf(bytes);
        expect(entry.movements[0]?.pickupQuarters).toBe(3);
        expect(Math.abs(signals.layoutBars - (entry.movements[0]?.printedBars ?? 0))).toBe(1);
        expect(signals.pickupFlagged).toBe(false);
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
        expect(art.fifths).toBe(1);
    });

    it('returns null fifths when the MusicXML has no key element', () => {
        const dir = join(tmpdir(), `cleffy-nokey-${process.pid}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, 'nokey.musicxml'),
            `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"/></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>4</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`,
        );
        const art = pdfSignalsFromArtifact(dir);
        expect(art.fifths).toBeNull();
        expect(art.meter).toEqual({ num: 4, den: 4 });
    });
});
