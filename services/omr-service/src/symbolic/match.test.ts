import { describe, expect, it } from 'vitest';

import { fetchCorpus } from '../eval/fetch.js';
import { loadCorpusEntry } from '../eval/manifest.js';
import { falseMatchFixtures, matchCandidateForPin, midiForPin, pdfSignalsForEntry, runSymbolicEval, SYMBOLIC_BENCH_SLUGS } from './evalRun.js';
import { decideSymbolic, symbolicMatchScore } from './match.js';
import { synthQuantizedMidi } from './midiSynth.js';
import {
    candidateFromMidi,
    fifthsFromMidi,
    isPerformanceMidi,
    pdfSignalsFromPin,
    printedBarCountFromMeasures,
} from './signals.js';
import { workKeyFromText } from './workKey.js';

/**
 * Bench pdfSignals come from the pinned PDF (layout + text), not from the
 * candidate MIDI. Opening is omitted unless an OMR artifact is cached.
 */
describe('symbolicMatchScore — 16 bench', () => {
    it('accepts every pinned piece against its own MIDI', async () => {
        for (const slug of SYMBOLIC_BENCH_SLUGS) {
            const entry = loadCorpusEntry(slug);
            const workKey = workKeyFromText(entry.title);
            expect(workKey, slug).toBeTruthy();
            const midi = midiForPin(entry);
            expect(isPerformanceMidi(midi), `${slug} quantized`).toBe(false);
            const pdf = await pdfSignalsForEntry(entry);
            const cand = matchCandidateForPin(entry, midi, workKey!);
            const result = symbolicMatchScore(pdf, cand);
            expect(result.parts.meter + result.parts.fifths + result.parts.barCount + result.parts.opening + result.parts.catalog, `${slug} parts sum`).toBeCloseTo(result.score, 5);
            expect(result.band, `${slug} band score=${result.score} reason=${result.reason} layout=${pdf.layoutBars} pin=${entry.movements[0]?.printedBars} catalog=${JSON.stringify(pdf.workKey)}`).toBe('accept');
            expect(result.score, slug).toBeGreaterThanOrEqual(85);
        }
    }, 180_000);
});

describe('symbolicMatchScore — false-match set', () => {
    it('never accepts an attack fixture', async () => {
        const rows = await falseMatchFixtures();
        expect(rows.length).toBe(5);
        for (const row of rows) {
            expect(row.band, `${row.id} ${row.reason} ${row.score}`).not.toBe('accept');
            expect(['reject', 'ambiguous']).toContain(row.band);
        }
    });

    it('hard-rejects performance MIDI of BWV 846', async () => {
        const row = (await falseMatchFixtures()).find((r) => r.id === 'bwv846-performance-midi');
        expect(row?.reason).toBe('performance_midi');
        expect(row?.band).toBe('reject');
    });

    it('hard-rejects the BWV 999 duo and the quintet as arrangements', async () => {
        const rows = await falseMatchFixtures();
        const duo = rows.find((r) => r.id === 'bwv999-duo');
        const quintet = rows.find((r) => r.id === 'gnossienne-quintet');
        expect(duo?.reason).toBe('arrangement');
        expect(quintet?.reason).toBe('arrangement');
    });

    it('rejects Schumann 68/2 against a 68/1 PDF', async () => {
        const row = (await falseMatchFixtures()).find((r) => r.id === 'schumann-68-2-vs-1');
        expect(row?.band).toBe('reject');
        expect(row?.reason).toBe('bars');
    });

    it('rejects WTC Prelude 2 against Prelude 1', async () => {
        const row = (await falseMatchFixtures()).find((r) => r.id === 'wtc-prelude-2-vs-1');
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
        const a = matchCandidateForPin(entry, midi, workKey);
        a.format = 'ly';
        a.url = 'https://example.test/a.ly';
        const bMidi = synthQuantizedMidi({
            meter: pdf.meter ?? { num: 4, den: 4 },
            pickupQuarters: pdf.pickupQuarters,
            printedBars: pdf.printedBars,
            fifths: pdf.fifths ?? 0,
            pitches: [72, 76, 79, 84],
        });
        const b = candidateFromMidi(bMidi, {
            source: 'mutopia',
            format: 'mid',
            url: 'https://example.test/b.mid',
            workKey,
            meter: pdf.meter ?? { num: 4, den: 4 },
            fifths: pdf.fifths ?? 0,
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

    it('accepts without opening when meter, bars, key, and catalog agree', () => {
        const entry = loadCorpusEntry('czerny-op821-01');
        const workKey = workKeyFromText(entry.title)!;
        const midi = midiForPin(entry);
        const pdf = pdfSignalsFromPin(entry, midi, workKey);
        pdf.opening = null;
        const cand = matchCandidateForPin(entry, midi, workKey);
        const result = symbolicMatchScore(pdf, cand);
        expect(result.signals.openingSim).toBeNull();
        expect(result.band).toBe('accept');
        expect(result.score).toBeGreaterThanOrEqual(85);
    });

    it('uses low_score for fingerprint-only rejects below 70', () => {
        const entry = loadCorpusEntry('czerny-op821-01');
        const workKey = workKeyFromText(entry.title)!;
        const midi = midiForPin(entry);
        const pdf = pdfSignalsFromPin(entry, midi, workKey);
        const cand = matchCandidateForPin(entry, midi, workKey);
        cand.opening = (pdf.opening ?? []).map(() => []);
        cand.workKey = { composerId: 'other', catalogType: 'Op', catalogN: 1 };
        const result = symbolicMatchScore(pdf, cand);
        expect(result.score).toBeLessThan(70);
        expect(result.band).toBe('reject');
        expect(result.reason).toBe('low_score');
    });

    it('uses ambiguous only for the 70–84 band (not a fingerprint reject)', () => {
        const entry = loadCorpusEntry('czerny-op821-01');
        const workKey = workKeyFromText(entry.title)!;
        const midi = midiForPin(entry);
        const pdf = pdfSignalsFromPin(entry, midi, workKey);
        const cand = matchCandidateForPin(entry, midi, workKey);
        cand.opening = (pdf.opening ?? []).map(() => []);
        const result = symbolicMatchScore(pdf, cand);
        expect(result.score).toBeGreaterThanOrEqual(70);
        expect(result.score).toBeLessThan(85);
        expect(result.band).toBe('ambiguous');
        expect(result.reason).toBe('ambiguous');
    });
});

describe('fifths unknown is omitted', () => {
    const czerny = () => {
        const entry = loadCorpusEntry('czerny-op821-01');
        const workKey = workKeyFromText(entry.title)!;
        const midi = midiForPin(entry);
        const pdf = pdfSignalsFromPin(entry, midi, workKey);
        const cand = matchCandidateForPin(entry, midi, workKey);
        return { pdf, cand };
    };

    it('omits and redistributes when the PDF fifths is null', () => {
        const { pdf, cand } = czerny();
        pdf.fifths = null;
        const result = symbolicMatchScore(pdf, cand);
        expect(result.signals.fifths).toBeNull();
        expect(result.parts.fifths).toBe(0);
        expect(result.band).toBe('accept');
        expect(result.score).toBeGreaterThanOrEqual(85);
    });

    it('omits and redistributes when the candidate fifths is null', () => {
        const { pdf, cand } = czerny();
        cand.fifths = null;
        const result = symbolicMatchScore(pdf, cand);
        expect(pdf.fifths).not.toBeNull();
        expect(result.signals.fifths).toBeNull();
        expect(result.parts.fifths).toBe(0);
        expect(result.band).toBe('accept');
        expect(result.score).toBeGreaterThanOrEqual(85);
    });

    it('omits when both sides are null', () => {
        const { pdf, cand } = czerny();
        pdf.fifths = null;
        cand.fifths = null;
        const result = symbolicMatchScore(pdf, cand);
        expect(result.signals.fifths).toBeNull();
        expect(result.parts.fifths).toBe(0);
        expect(result.band).toBe('accept');
    });

    it('keeps −15 on a known-vs-known disagreement', () => {
        const { pdf, cand } = czerny();
        pdf.fifths = 0;
        cand.fifths = -1;
        const result = symbolicMatchScore(pdf, cand);
        expect(result.signals.fifths).toBe(false);
        expect(result.parts.fifths).toBe(0);
        expect(result.score).toBeCloseTo(85, 5);
    });

    it('reads Mutopia MIDI key meta and treats a missing FF 59 as null', async () => {
        await fetchCorpus(loadCorpusEntry('gymnopedie-2'), { allowNetwork: true, mode: 'midi' });
        await fetchCorpus(loadCorpusEntry('chopin-prelude-4'), { allowNetwork: true, mode: 'midi' });
        const gym = midiForPin(loadCorpusEntry('gymnopedie-2'));
        const chopin = midiForPin(loadCorpusEntry('chopin-prelude-4'));
        expect(fifthsFromMidi(gym)).toBe(0);
        expect(fifthsFromMidi(chopin)).toBe(1);
        const noKey = synthQuantizedMidi({
            meter: { num: 4, den: 4 },
            pickupQuarters: 0,
            printedBars: 2,
            fifths: null,
            pitches: [60],
        });
        expect(fifthsFromMidi(noKey)).toBeNull();
        const cand = candidateFromMidi(noKey, {
            source: 'mutopia',
            format: 'mid',
            url: 'https://example.test/nokey.mid',
            workKey: { composerId: 'bach', catalogType: 'BWV', catalogN: 1 },
            meter: { num: 4, den: 4 },
            fifths: 3,
            pickupQuarters: 0,
            arrangement: false,
        });
        expect(cand.fifths).toBeNull();
    });

    it('scores Chopin against MIDI fifths=1 (E minor), not pin expectedFifths=-1', async () => {
        const entry = loadCorpusEntry('chopin-prelude-4');
        await fetchCorpus(entry, { allowNetwork: true, mode: 'midi' });
        const workKey = workKeyFromText(entry.title)!;
        const midi = midiForPin(entry);
        const cand = matchCandidateForPin(entry, midi, workKey);
        expect(entry.movements[0]?.expectedFifths).toBe(-1);
        expect(cand.fifths).toBe(1);
        const pdf = pdfSignalsFromPin(entry, midi, workKey);
        pdf.fifths = 1;
        const agree = symbolicMatchScore(pdf, cand);
        expect(agree.signals.fifths).toBe(true);
        pdf.fifths = null;
        const omitted = symbolicMatchScore(pdf, cand);
        expect(omitted.signals.fifths).toBeNull();
        expect(omitted.band).toBe('accept');
    });

    it('keeps Gymnopédie fifths:false when OMR is −1 and MIDI is 0', async () => {
        const entry = loadCorpusEntry('gymnopedie-2');
        await fetchCorpus(entry, { allowNetwork: true, mode: 'midi' });
        const workKey = workKeyFromText(entry.title)!;
        const midi = midiForPin(entry);
        const pdf = pdfSignalsFromPin(entry, midi, workKey);
        const cand = matchCandidateForPin(entry, midi, workKey);
        pdf.fifths = -1;
        expect(cand.fifths).toBe(0);
        const result = symbolicMatchScore(pdf, cand);
        expect(result.signals.fifths).toBe(false);
        expect(result.parts.fifths).toBe(0);
    });
});

describe('printed bar count', () => {
    it('dedupes srcIndex (performed repeats do not inflate printed bars)', () => {
        expect(
            printedBarCountFromMeasures([
                { n: 1, srcIndex: 0 },
                { n: 2, srcIndex: 1 },
                { n: 3, srcIndex: 0 },
                { n: 4, srcIndex: 1 },
                { n: 5, srcIndex: 2 },
            ]),
        ).toBe(3);
    });

    it('compares Op. 68 No. 1 against printedBars, not performedBars', () => {
        const entry = loadCorpusEntry('schumann-op68-01');
        const mov = entry.movements[0]!;
        expect(mov.repeatsUnfoldedInMidi).toBe(true);
        expect(mov.printedBars).toBe(20);
        expect(mov.performedBars).toBe(24);
        const workKey = workKeyFromText(entry.title)!;
        const midi = midiForPin(entry);
        const pdf = pdfSignalsFromPin(entry, midi, workKey);
        const cand = matchCandidateForPin(entry, midi, workKey);
        expect(cand.barCount).toBe(mov.printedBars);
        expect(pdf.printedBars).toBe(mov.printedBars);
        const result = symbolicMatchScore(pdf, cand);
        expect(result.signals.barCountCand).toBe(20);
        expect(result.barError).toBe(0);
        expect(result.band).toBe('accept');
    });
});

describe('runSymbolicEval', () => {
    it('prints a clean 16/16 + 0 false accepts report', async () => {
        const report = await runSymbolicEval();
        expect(report.benchTotal).toBe(16);
        expect(report.benchAccept).toBe(16);
        expect(report.falseAccepts).toBe(0);
        expect(report.falseTotal).toBe(5);
        for (const row of report.rows.filter((r) => r.set === 'bench')) {
            expect(row.onGrid, row.id).toBeGreaterThanOrEqual(99);
            expect(row.reason).not.toBe('parser_unusable');
            expect(row.openingSim === null || typeof row.openingSim === 'number', row.id).toBe(true);
        }
        for (const row of report.rows.filter((r) => r.set === 'false-match')) {
            expect(row.onGrid).toBeUndefined();
        }
    }, 180_000);
});
