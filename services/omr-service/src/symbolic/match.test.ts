import { describe, expect, it } from 'vitest';

import { loadCorpusEntry } from '../eval/manifest.js';
import { falseMatchFixtures, midiForPin, runSymbolicEval, SYMBOLIC_BENCH_SLUGS } from './evalRun.js';
import { decideSymbolic, symbolicMatchScore } from './match.js';
import { synthQuantizedMidi } from './midiSynth.js';
import { candidateFromMidi, isPerformanceMidi, pdfSignalsFromPin } from './signals.js';
import { workKeyFromText } from './workKey.js';

/**
 * No PDF read exists yet. pdfSignals take meters / pickup / printedBars from
 * the corpus pin and the opening pitch bag from the same MIDI used as the
 * candidate (cached Mutopia bytes when present and not unfolded, otherwise a
 * quantized stand-in generated in-process).
 */
describe('symbolicMatchScore — 16 bench', () => {
    it('accepts every pinned piece against its own MIDI', () => {
        for (const slug of SYMBOLIC_BENCH_SLUGS) {
            const entry = loadCorpusEntry(slug);
            const workKey = workKeyFromText(entry.title);
            expect(workKey, slug).toBeTruthy();
            const midi = midiForPin(entry);
            expect(isPerformanceMidi(midi), `${slug} quantized`).toBe(false);
            const pdf = pdfSignalsFromPin(entry, midi, workKey!);
            const cand = candidateFromMidi(midi, {
                source: 'mutopia',
                format: 'mid',
                url: entry.reference.source === 'mutopia' ? entry.reference.url : '',
                workKey: workKey!,
                meter: pdf.meter,
                fifths: pdf.fifths,
                pickupQuarters: pdf.pickupQuarters,
                arrangement: false,
            });
            const result = symbolicMatchScore(pdf, cand);
            expect(result.parts.meter + result.parts.fifths + result.parts.barCount + result.parts.opening + result.parts.catalog, `${slug} parts sum`).toBeCloseTo(result.score, 5);
            expect(result.band, `${slug} band score=${result.score} reason=${result.reason}`).toBe('accept');
            expect(result.score, slug).toBeGreaterThanOrEqual(85);
        }
    });
});

describe('symbolicMatchScore — false-match set', () => {
    it('never accepts an attack fixture', () => {
        const rows = falseMatchFixtures();
        expect(rows.length).toBe(5);
        for (const row of rows) {
            expect(row.band, `${row.id} ${row.reason} ${row.score}`).not.toBe('accept');
            expect(['reject', 'ambiguous']).toContain(row.band);
        }
    });

    it('hard-rejects performance MIDI of BWV 846', () => {
        const row = falseMatchFixtures().find((r) => r.id === 'bwv846-performance-midi');
        expect(row?.reason).toBe('performance_midi');
        expect(row?.band).toBe('reject');
    });

    it('hard-rejects the BWV 999 duo and the quintet as arrangements', () => {
        const duo = falseMatchFixtures().find((r) => r.id === 'bwv999-duo');
        const quintet = falseMatchFixtures().find((r) => r.id === 'gnossienne-quintet');
        expect(duo?.reason).toBe('arrangement');
        expect(quintet?.reason).toBe('arrangement');
    });

    it('rejects Schumann 68/2 against a 68/1 PDF', () => {
        const row = falseMatchFixtures().find((r) => r.id === 'schumann-68-2-vs-1');
        expect(row?.band).toBe('reject');
        expect(row?.reason).toBe('meter');
    });

    it('rejects WTC Prelude 2 against Prelude 1', () => {
        const row = falseMatchFixtures().find((r) => r.id === 'wtc-prelude-2-vs-1');
        expect(row?.band).toBe('reject');
        expect(row?.reason).toBe('bars');
    });
});

describe('decideSymbolic', () => {
    it('marks two accept-level candidates within 3 points as ambiguous', () => {
        const entry = loadCorpusEntry('czerny-op821-01');
        const workKey = workKeyFromText(entry.title)!;
        const midi = midiForPin(entry);
        const pdf = pdfSignalsFromPin(entry, midi, workKey);
        const a = candidateFromMidi(midi, {
            source: 'mutopia',
            format: 'ly',
            url: 'https://example.test/a.ly',
            workKey,
            meter: pdf.meter,
            fifths: pdf.fifths,
            pickupQuarters: pdf.pickupQuarters,
            arrangement: false,
        });
        const bMidi = synthQuantizedMidi({
            meter: pdf.meter,
            pickupQuarters: pdf.pickupQuarters,
            printedBars: pdf.printedBars,
            fifths: pdf.fifths,
            pitches: [72, 76, 79, 84],
        });
        const b = candidateFromMidi(bMidi, {
            source: 'mutopia',
            format: 'mid',
            url: 'https://example.test/b.mid',
            workKey,
            meter: pdf.meter,
            fifths: pdf.fifths,
            pickupQuarters: pdf.pickupQuarters,
            arrangement: false,
        });
        // Force a near-twin: copy opening so scores land within 3.
        b.opening = a.opening.map((bar) => bar.map((n) => ({ ...n })));
        const decision = decideSymbolic(pdf, [a, b]);
        expect(decision.best?.score ?? 0).toBeGreaterThanOrEqual(85);
        expect(decision.band).toBe('ambiguous');
        expect(decision.reason).toBe('ambiguous');
    });

    it('returns no_candidate when the list is empty', () => {
        const entry = loadCorpusEntry('czerny-op821-01');
        const workKey = workKeyFromText(entry.title)!;
        const midi = midiForPin(entry);
        const pdf = pdfSignalsFromPin(entry, midi, workKey);
        const decision = decideSymbolic(pdf, []);
        expect(decision.reason).toBe('no_candidate');
        expect(decision.band).toBe('reject');
    });
});

describe('runSymbolicEval', () => {
    it('prints a clean 16/16 + 0 false accepts report', () => {
        const report = runSymbolicEval();
        expect(report.benchTotal).toBe(16);
        expect(report.benchAccept).toBe(16);
        expect(report.falseAccepts).toBe(0);
        expect(report.falseTotal).toBe(5);
    });
});
