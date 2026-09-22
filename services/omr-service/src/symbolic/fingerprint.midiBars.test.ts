import { describe, expect, it } from 'vitest';

import { fingerprintCandidate } from './fingerprint.js';
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
