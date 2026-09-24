import { describe, expect, it } from 'vitest';

import { fingerprintCandidate } from './fingerprint.js';
import { symbolicMatchScore } from './match.js';
import { synthQuantizedMidi } from './midiSynth.js';
import type { PdfSignals } from './signals.js';
import type { RankedCandidate, WorkKey } from './types.js';

const workKey: WorkKey = { composerId: 'beethoven', catalogType: 'Op', catalogN: 13 };

const pdf = (printedBars: number): PdfSignals => ({
    meter: { num: 4, den: 4 },
    fifths: 0,
    printedBars,
    pickupQuarters: 0,
    opening: null,
    workKey,
    pageCount: 4,
    pickupFlagged: false,
    layoutBars: printedBars,
    barBoxes: [],
});

const ranked = (url: string): RankedCandidate => ({
    source: 'mutopia',
    format: 'mid',
    url,
    workKey,
    arrangement: false,
    priority: 3,
});

describe('fingerprintCandidate MIDI bar count', () => {
    it('uses the MIDI bar count instead of the PDF printedBars', () => {
        const shortMidi = synthQuantizedMidi({
            meter: { num: 4, den: 4 },
            pickupQuarters: 0,
            printedBars: 12,
            fifths: 0,
            pitches: [60],
        });
        const longMidi = synthQuantizedMidi({
            meter: { num: 4, den: 4 },
            pickupQuarters: 0,
            printedBars: 40,
            fifths: 0,
            pitches: [64],
        });
        const signals = pdf(12);
        const short = fingerprintCandidate(ranked('https://example.test/m1.mid'), shortMidi, signals);
        const long = fingerprintCandidate(ranked('https://example.test/m2.mid'), longMidi, signals);
        expect(short?.barCount).toBe(12);
        expect(long?.barCount).toBe(40);
        expect(long?.barCount).not.toBe(signals.printedBars);
    });
});

/** Same bytes with the FF 58 time signature turned into an ignored FF 7F meta. */
const withoutTimeSignature = (midi: Buffer): Buffer => {
    const out = Buffer.from(midi);
    const at = out.indexOf(Buffer.from([0xff, 0x58, 0x04]));
    out[at + 1] = 0x7f;
    return out;
};

const waltz = (pickupQuarters = 0): Buffer =>
    synthQuantizedMidi({
        meter: { num: 3, den: 4 },
        pickupQuarters,
        printedBars: 12,
        fifths: 0,
        pitches: [60, 64, 67],
    });

describe('fingerprintCandidate MIDI meter', () => {
    it('bars a MIDI by its own time signature when the PDF has no meter', () => {
        const cand = fingerprintCandidate(ranked('https://example.test/waltz.mid'), waltz(), {
            ...pdf(12),
            meter: null,
        });
        expect(cand?.meter).toEqual({ num: 3, den: 4 });
        expect(cand?.barCount).toBe(12);
    });

    it('keeps the MIDI meter against a disagreeing PDF, so the meter check rejects it', () => {
        const eighths = synthQuantizedMidi({
            meter: { num: 3, den: 8 },
            pickupQuarters: 0,
            printedBars: 12,
            fifths: 0,
            pitches: [60],
        });
        const signals: PdfSignals = { ...pdf(12), meter: { num: 2, den: 4 } };
        const cand = fingerprintCandidate(ranked('https://example.test/other.mid'), eighths, signals);
        expect(cand?.meter).toEqual({ num: 3, den: 8 });
        if (!cand) {
            return;
        }
        const scored = symbolicMatchScore(signals, cand);
        expect(scored.signals.meter).toBe(false);
        expect(scored.reason).toBe('meter');
    });

    it('falls back to the PDF meter, then 4/4, only when the MIDI has no time signature', () => {
        const bare = withoutTimeSignature(waltz());
        const fromPdf = fingerprintCandidate(ranked('https://example.test/bare.mid'), bare, {
            ...pdf(12),
            meter: { num: 3, den: 4 },
        });
        const fromDefault = fingerprintCandidate(ranked('https://example.test/bare.mid'), bare, {
            ...pdf(12),
            meter: null,
        });
        expect(fromPdf?.meter).toEqual({ num: 3, den: 4 });
        expect(fromDefault?.meter).toEqual({ num: 4, den: 4 });
    });
});

describe('fingerprintCandidate MIDI pickup', () => {
    it('sizes a flagged pickup from the MIDI downbeats', () => {
        const cand = fingerprintCandidate(ranked('https://example.test/minuet.mid'), waltz(1), {
            ...pdf(12),
            meter: { num: 3, den: 4 },
            pickupFlagged: true,
        });
        expect(cand?.pickupQuarters).toBe(1);
    });

    it('keeps pickup 0 when the PDF does not flag one', () => {
        const cand = fingerprintCandidate(ranked('https://example.test/minuet.mid'), waltz(1), {
            ...pdf(12),
            meter: { num: 3, den: 4 },
        });
        expect(cand?.pickupQuarters).toBe(0);
    });

    it('a known pickup length (pin) wins over the MIDI estimate', () => {
        const cand = fingerprintCandidate(ranked('https://example.test/minuet.mid'), waltz(1), {
            ...pdf(12),
            meter: { num: 3, den: 4 },
            pickupFlagged: true,
            pickupQuarters: 2,
        });
        expect(cand?.pickupQuarters).toBe(2);
    });
});
