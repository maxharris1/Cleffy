import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import type { MatchBand, MatchReason, MatchResult, SignalVector } from './match.js';
import type { WorkKey } from './types.js';

export const SYMBOLIC_TIER = 1 as const;

export interface DecisionLogLine {
    uploadId: string;
    pdfSha256: string;
    pageCount: number;
    workKey: WorkKey;
    imslpPageTitle?: string;
    candidate: {
        source: string;
        url: string;
        sha256: string;
        format: string;
    };
    signals: SignalVector;
    score: number;
    band: MatchBand;
    reason: MatchReason;
    engineSkipped: boolean;
    timestamp: string;
    gitSha: string;
    symbolicTier: typeof SYMBOLIC_TIER;
}

export const gitSha = (): string => {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
        return 'unknown';
    }
};

export const emptySignalVector = (): SignalVector => ({
    meter: false,
    fifths: null,
    barCountPdf: 0,
    barCountCand: 0,
    openingSim: null,
    catalogHit: false,
});

export const decisionLogLine = (input: {
    uploadId: string;
    pdfSha256: string;
    pageCount: number;
    workKey: WorkKey;
    imslpPageTitle?: string;
    match: MatchResult | null;
    band: MatchBand;
    reason: MatchReason;
    timestamp?: string;
    gitSha?: string;
}): DecisionLogLine => {
    const cand = input.match?.candidate;
    const line: DecisionLogLine = {
        uploadId: input.uploadId,
        pdfSha256: input.pdfSha256,
        pageCount: input.pageCount,
        workKey: input.workKey,
        candidate: {
            source: cand?.source ?? 'imslp',
            url: cand?.url ?? '',
            sha256: cand?.sha256 ?? '',
            format: cand?.format ?? 'mid',
        },
        signals: input.match?.signals ?? emptySignalVector(),
        score: input.match?.score ?? 0,
        band: input.band,
        reason: input.reason,
        engineSkipped: input.band === 'accept',
        timestamp: input.timestamp ?? new Date().toISOString(),
        gitSha: input.gitSha ?? gitSha(),
        symbolicTier: SYMBOLIC_TIER,
    };
    if (input.imslpPageTitle !== undefined) {
        line.imslpPageTitle = input.imslpPageTitle;
    }
    return line;
};

export const formatDecisionLine = (line: DecisionLogLine): string => JSON.stringify(line);

export const sha256Hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
