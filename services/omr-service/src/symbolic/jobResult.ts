import type { MatchBand, MatchReason } from './match.js';
import type { SymbolicFormat, SymbolicSource } from './types.js';
import type { AlignmentMap } from './align.js';

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

export interface SymbolicAcceptResult {
    kind: 'accept';
    score: import('../scoreData.js').ScoreData;
    alignmentMap: AlignmentMap;
    source: AnalysisSource;
    logLine: string;
}

export interface SymbolicFallthroughResult {
    kind: 'fallthrough';
    source: AnalysisSource;
    logLine: string;
}

export type SymbolicJobResult = SymbolicAcceptResult | SymbolicFallthroughResult;
