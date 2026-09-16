import type { MatchBand, MatchReason } from './match.js';
import type { SymbolicFormat, SymbolicSource, WorkKey } from './types.js';
import type { AlignmentMap } from './align.js';
import type { ScoreData } from '../scoreData.js';

export type AnalysisSourceName = 'Mutopia' | 'IMSLP XML' | 'MIDI' | 'You uploaded';

/**
 * Sibling of ScoreData on the job result. Not part of scoreDataSchema.
 * Persisted on `score_analyses.timings` so the client can badge the player
 * without a schema migration.
 */
export interface AnalysisSource {
    tier: 'symbolic' | 'omr';
    format?: SymbolicFormat;
    sourceName?: AnalysisSourceName;
    matchScore?: number;
    band: MatchBand;
    reason: MatchReason;
}

export const sourceNameOf = (source: SymbolicSource, format: SymbolicFormat): AnalysisSourceName => {
    switch (source) {
        case 'mutopia':
            return 'Mutopia';
        case 'user':
            return 'You uploaded';
        case 'asap_eval':
            return 'MIDI';
        case 'imslp': {
            switch (format) {
                case 'mid':
                    return 'MIDI';
                case 'mxl':
                case 'xml':
                case 'ly':
                case 'mscz':
                case 'user-xml':
                    return 'IMSLP XML';
                default: {
                    const exhaustive: never = format;
                    throw new Error(`unhandled format ${exhaustive}`);
                }
            }
        }
        default: {
            const exhaustive: never = source;
            throw new Error(`unhandled source ${exhaustive}`);
        }
    }
};

export const analysisSourceFromDecision = (
    tier: AnalysisSource['tier'],
    band: MatchBand,
    reason: MatchReason,
    matchScore: number | undefined,
    candidate: { source: SymbolicSource; format: SymbolicFormat } | null,
): AnalysisSource => {
    const out: AnalysisSource = { tier, band, reason };
    if (matchScore !== undefined) {
        out.matchScore = Math.round(matchScore);
    }
    if (candidate) {
        out.format = candidate.format;
        out.sourceName = sourceNameOf(candidate.source, candidate.format);
    }
    return out;
};

/** This PDF's identity and layout — the corpus keys a row by them as well as by hash. */
export interface SymbolicLayoutKey {
    workKey: WorkKey;
    printedBars: number;
    pageCount: number;
}

export interface SymbolicAcceptResult {
    kind: 'accept';
    score: ScoreData;
    alignmentMap: AlignmentMap;
    source: AnalysisSource;
    logLine: string;
    layout: SymbolicLayoutKey;
    /** The matched candidate; null when the score came from the corpus layout lookup. */
    candidate: { source: SymbolicSource; format: SymbolicFormat; url: string; sha256: string } | null;
    /** Set when the corpus served this accept instead of discover. */
    corpusHit?: 'layout';
}

export interface SymbolicFallthroughResult {
    kind: 'fallthrough';
    source: AnalysisSource;
    logLine: string;
    /** Absent when the PDF could not be read at all. */
    layout?: SymbolicLayoutKey;
}

export type SymbolicJobResult = SymbolicAcceptResult | SymbolicFallthroughResult;
