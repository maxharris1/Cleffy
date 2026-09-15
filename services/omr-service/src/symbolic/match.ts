import { metersEqual } from '../eval/segment.js';
import { workKeysEqual } from './types.js';
import { isPerformanceMidi, openingSim, type MatchCandidateInput, type PdfSignals } from './signals.js';

export type MatchBand = 'accept' | 'ambiguous' | 'reject';

export type MatchReason =
    | 'accept'
    | 'ambiguous'
    | 'low_score'
    | 'meter'
    | 'bars'
    | 'arrangement'
    | 'performance_midi'
    | 'no_candidate'
    | 'parser_unusable';

export interface ScoreParts {
    meter: number;
    fifths: number;
    barCount: number;
    opening: number;
    catalog: number;
}

export interface SignalVector {
    meter: boolean;
    fifths: boolean;
    barCountPdf: number;
    barCountCand: number;
    openingSim: number;
    catalogHit: boolean;
}

export interface MatchResult {
    parts: ScoreParts;
    score: number;
    band: MatchBand;
    reason: MatchReason;
    signals: SignalVector;
    barError: number;
    candidate: MatchCandidateInput;
}

const WEIGHTS = {
    meter: 20,
    fifths: 15,
    barCount: 25,
    opening: 30,
    catalog: 10,
} as const;

const barCountPart = (error: number): number => {
    if (error <= 1) {
        return WEIGHTS.barCount;
    }
    if (error === 2) {
        return 12;
    }
    return 0;
};

const bandFor = (
    score: number,
    meterOk: boolean,
    barError: number,
    arrangement: boolean,
    performanceMidi: boolean,
): { band: MatchBand; reason: MatchReason } => {
    if (performanceMidi) {
        return { band: 'reject', reason: 'performance_midi' };
    }
    if (arrangement) {
        return { band: 'reject', reason: 'arrangement' };
    }
    if (!meterOk) {
        return { band: 'reject', reason: 'meter' };
    }
    if (barError > 2) {
        return { band: 'reject', reason: 'bars' };
    }
    if (score >= 85 && barError <= 1 && meterOk) {
        return { band: 'accept', reason: 'accept' };
    }
    if (score >= 70) {
        return { band: 'ambiguous', reason: 'ambiguous' };
    }
    return { band: 'reject', reason: 'low_score' };
};

/**
 * Cheap PDF-vs-candidate fingerprint. Returns parts, not just the sum.
 * Does not call playAlongGate / compareScore.
 */
export const symbolicMatchScore = (pdf: PdfSignals, candidate: MatchCandidateInput): MatchResult => {
    const performanceMidi = candidate.midi !== undefined && isPerformanceMidi(candidate.midi);
    const meterOk = metersEqual(pdf.meter, candidate.meter);
    const fifthsOk = pdf.fifths === candidate.fifths;
    const barError = Math.abs(pdf.printedBars - candidate.barCount);
    const sim = openingSim(pdf.opening, candidate.opening);
    const catalogHit = workKeysEqual(pdf.workKey, candidate.workKey);
    const parts: ScoreParts = {
        meter: meterOk ? WEIGHTS.meter : 0,
        fifths: fifthsOk ? WEIGHTS.fifths : 0,
        barCount: barCountPart(barError),
        opening: Math.round(WEIGHTS.opening * sim * 1000) / 1000,
        catalog: catalogHit ? WEIGHTS.catalog : 0,
    };
    const score = parts.meter + parts.fifths + parts.barCount + parts.opening + parts.catalog;
    const { band, reason } = bandFor(score, meterOk, barError, candidate.arrangement, performanceMidi);
    return {
        parts,
        score,
        band,
        reason,
        barError,
        candidate,
        signals: {
            meter: meterOk,
            fifths: fifthsOk,
            barCountPdf: pdf.printedBars,
            barCountCand: candidate.barCount,
            openingSim: sim,
            catalogHit,
        },
    };
};

export interface Decision {
    band: MatchBand;
    reason: MatchReason;
    best: MatchResult | null;
    results: MatchResult[];
}

/**
 * Apply the locked thresholds across a ranked candidate list. A second
 * survivor within 3 points of an otherwise-accept score is ambiguous.
 */
export const decideSymbolic = (pdf: PdfSignals, candidates: readonly MatchCandidateInput[]): Decision => {
    if (candidates.length === 0) {
        return { band: 'reject', reason: 'no_candidate', best: null, results: [] };
    }
    const results = candidates.map((c) => symbolicMatchScore(pdf, c)).sort((a, b) => b.score - a.score);
    const best = results[0];
    if (!best) {
        return { band: 'reject', reason: 'no_candidate', best: null, results };
    }
    const second = results[1];
    if (best.band === 'accept' && second && Math.abs(best.score - second.score) <= 3) {
        return { band: 'ambiguous', reason: 'ambiguous', best, results };
    }
    return { band: best.band, reason: best.reason, best, results };
};
