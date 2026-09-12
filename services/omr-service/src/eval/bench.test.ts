import { describe, expect, it } from 'vitest';

import { BENCH_SUITE, formatBench, type BenchReport } from './bench.js';
import { loadCorpusEntry } from './manifest.js';
import { defaultLimits } from './playAlong.js';

/**
 * These run without network, Audiveris, or the MIDI cache. They guard the shape
 * of the suite, not its scores — `bench` itself is the accuracy measurement and
 * CI must not run it.
 */
describe('bench suite', () => {
    it('has no duplicate slugs', () => {
        expect(new Set(BENCH_SUITE).size).toBe(BENCH_SUITE.length);
    });

    it('every entry loads and is fully pinned', () => {
        for (const slug of BENCH_SUITE) {
            const entry = loadCorpusEntry(slug);
            expect(entry.slug, slug).toBe(slug);
            // Without both hashes `bench` cannot claim a re-run is the same input.
            expect(entry.pdf.sha256, `${slug} pdf.sha256`).toMatch(/^[0-9a-f]{64}$/);
            expect(entry.reference.source, `${slug} reference.source`).toBe('mutopia');
            if (entry.reference.source === 'mutopia') {
                expect(entry.reference.sha256, `${slug} reference.sha256`).toMatch(/^[0-9a-f]{64}$/);
            }
            expect(entry.editionNotes.length, `${slug} editionNotes`).toBeGreaterThan(0);
        }
    });

    it('every movement declares the fields the gate reads', () => {
        for (const slug of BENCH_SUITE) {
            for (const mov of loadCorpusEntry(slug).movements) {
                const where = `${slug} ${mov.name}`;
                expect(mov.printedBars, where).toBeGreaterThan(0);
                expect(mov.expectedHolds, where).toBeGreaterThanOrEqual(0);
                expect(mov.expectedExtraNotes, where).toBeGreaterThanOrEqual(0);
                expect(mov.expectedTempo.min, where).toBeLessThan(mov.expectedTempo.max);
                // A performed length below the printed one is never a repeat.
                if (mov.performedBars !== undefined) {
                    expect(mov.performedBars, where).toBeGreaterThanOrEqual(mov.printedBars);
                }
                // An unfolded reference IS the performance, so it has to say how
                // long that is or refBarsMatch silently falls back to printedBars.
                if (mov.repeatsUnfoldedInMidi) {
                    expect(mov.performedBars, `${where} unfolded needs performedBars`).toBeDefined();
                }
            }
        }
    });

    it('covers a spread of meters, keys, pickups and repeat shapes', () => {
        const movements = BENCH_SUITE.flatMap((slug) => loadCorpusEntry(slug).movements);
        const meters = new Set(movements.map((m) => `${m.meter.num}/${m.meter.den}`));
        expect(meters.size, [...meters].join(' ')).toBeGreaterThanOrEqual(4);
        expect(new Set(movements.map((m) => m.expectedFifths)).size).toBeGreaterThanOrEqual(3);
        expect(movements.filter((m) => m.pickupQuarters > 0).length).toBeGreaterThanOrEqual(2);
        // Pieces whose performance is longer than the page, i.e. real repeats.
        expect(
            movements.filter((m) => m.performedBars !== undefined && m.performedBars > m.printedBars).length,
        ).toBeGreaterThanOrEqual(3);
        expect(movements.filter((m) => m.repeatsUnfoldedInMidi).length).toBeGreaterThanOrEqual(1);
        expect(movements.filter((m) => m.expectedHolds > 0).length).toBeGreaterThanOrEqual(2);
        expect(movements.filter((m) => m.expectedExtraNotes > 0).length).toBeGreaterThanOrEqual(2);
    });

    it('weights the suite total by reference notes, not by piece', () => {
        const piece = (slug: string, refNotes: number, onGrid: number) => ({
            slug,
            title: slug,
            pages: 1,
            pdfSha256: null,
            referenceSha256: null,
            artifactHash: null,
            refNotes,
            pitchMatch: onGrid,
            exact: onGrid,
            onGrid,
            missing: 0,
            extra: 0,
            composite: onGrid,
            pass: true,
            failures: [],
        });
        const report: BenchReport = {
            generatedAt: '2026-09-12T00:00:00.000Z',
            engineVersion: 'test',
            audiverisVersion: null,
            audiverisOptions: '',
            limits: defaultLimits(),
            totals: { pieces: 2, piecesPassed: 2, refNotes: 1000, pitchMatch: 0, exact: 0, onGrid: 91, missing: 0, extra: 0 },
            pieces: [piece('big', 900, 100), piece('small', 100, 10)],
        };
        // A 900-note piece at 100% and a 100-note piece at 10% is 91%, not 55%.
        const text = formatBench(report);
        expect(text).toContain('91.0%');
        expect(text).toContain('2/2 pieces pass');
    });
});
