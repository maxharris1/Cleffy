import { parseMxlFiles, parseMusicXmlString, type MusicalScore } from '../musicxml.js';
import { TICKS_PER_QUARTER } from '../scoreData.js';
import type { BarNote } from '../eval/compare.js';
import { defaultLyConverter, type LyConverter } from './lyConvert.js';
import { sha256Hex } from './log.js';
import { meterFromMidi, pickupQuartersFromMidi } from './midiMeta.js';
import {
    candidateFromMidi,
    fifthsViaLibrary,
    OPENING_BARS,
    printedBarCountFromMeasures,
    type MatchCandidateInput,
    type Meter,
    type PdfSignals,
} from './signals.js';
import type { RankedCandidate, SymbolicFormat } from './types.js';

const looksLikeZip = (bytes: Buffer): boolean => bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;

const openingFromMusical = (musical: MusicalScore): BarNote[][] => {
    const bars = musical.measures.slice(0, OPENING_BARS);
    return bars.map((measure) =>
        musical.notes
            .filter((n) => n.t >= measure.tick && n.t < measure.tick + measure.dTicks)
            .map((n): BarNote => ({
                onsetQ: (n.t - measure.tick) / TICKS_PER_QUARTER,
                pitch: n.p,
                durQ: n.d / TICKS_PER_QUARTER,
                hand: n.h,
            })),
    );
};

const parseXml = (bytes: Buffer, format: SymbolicFormat): MusicalScore => {
    if (format === 'mxl' || looksLikeZip(bytes)) {
        return parseMxlFiles([bytes]);
    }
    return parseMusicXmlString(bytes.toString('utf8'));
};

const meterOf = (musical: MusicalScore, fallback: Meter): Meter => {
    const ts = musical.timeSignatures[0];
    return ts ? { num: ts.num, den: ts.den } : fallback;
};

const fromXml = (
    ranked: RankedCandidate,
    bytes: Buffer,
    pdf: PdfSignals,
    format: SymbolicFormat,
): MatchCandidateInput => {
    const musical = parseXml(bytes, format);
    const fallback: Meter = pdf.meter ?? { num: 4, den: 4 };
    const ks = musical.keySignatures[0];
    const out: MatchCandidateInput = {
        source: ranked.source,
        format: ranked.format,
        url: ranked.url,
        sha256: sha256Hex(bytes),
        workKey: ranked.workKey,
        meter: meterOf(musical, fallback),
        fifths: ks === undefined ? null : fifthsViaLibrary(ks.fifths),
        barCount: printedBarCountFromMeasures(musical.measures),
        pickupQuarters: pdf.pickupQuarters,
        opening: openingFromMusical(musical),
        arrangement: ranked.arrangement,
    };
    return out;
};

/**
 * Pickup for a MIDI candidate. A known length (pin) wins; otherwise the PDF
 * only flags that a pickup exists and the MIDI's own downbeats give its length.
 */
const pickupOf = (bytes: Buffer, pdf: PdfSignals, meter: Meter): number => {
    if (pdf.pickupQuarters > 0) {
        return pdf.pickupQuarters;
    }
    return pdf.pickupFlagged ? pickupQuartersFromMidi(bytes, meter) : 0;
};

const fromMidi = (ranked: RankedCandidate, bytes: Buffer, pdf: PdfSignals): MatchCandidateInput => {
    // The MIDI's own FF 58 bars it. Copying the PDF's meter made the meter
    // check a no-op for MIDI and barred every text-less scan in 4/4.
    const meter: Meter = meterFromMidi(bytes) ?? pdf.meter ?? { num: 4, den: 4 };
    return candidateFromMidi(bytes, {
        source: ranked.source,
        format: ranked.format,
        url: ranked.url,
        sha256: sha256Hex(bytes),
        workKey: ranked.workKey,
        meter,
        fifths: pdf.fifths ?? 0,
        pickupQuarters: pickupOf(bytes, pdf, meter),
        arrangement: ranked.arrangement,
        // Count bars from the MIDI. Copying pdf.printedBars made every
        // movement of an opus score identically and forced `ambiguous`.
    });
};

/**
 * Cheap fingerprint for a fetched candidate. `.mscz` and unconverted `.ly`
 * return null (not fingerprintable) so discovery continues to MIDI / XML.
 */
export const fingerprintCandidate = (
    ranked: RankedCandidate,
    bytes: Buffer,
    pdf: PdfSignals,
    lyConverter: LyConverter = defaultLyConverter(),
): MatchCandidateInput | null => {
    try {
        switch (ranked.format) {
            case 'mscz':
                return null;
            case 'ly': {
                if (!lyConverter.isAvailable()) {
                    return null;
                }
                return fromXml(ranked, lyConverter.toMusicXml(bytes), pdf, 'xml');
            }
            case 'mid':
                return fromMidi(ranked, bytes, pdf);
            case 'mxl':
            case 'xml':
            case 'user-xml':
                return fromXml(ranked, bytes, pdf, ranked.format);
            default: {
                const exhaustive: never = ranked.format;
                throw new Error(`unhandled format ${exhaustive}`);
            }
        }
    } catch {
        return null;
    }
};
