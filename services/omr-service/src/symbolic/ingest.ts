import { OVERFULL_WARNING } from '../eval/compare.js';
import { buildScoreData } from '../buildScoreData.js';
import { parseMxlFiles, parseMusicXmlString, type MusicalScore } from '../musicxml.js';
import { scoreDataSchema, type ScoreData } from '../scoreData.js';
import { decisionLogLine, formatDecisionLine, sha256Hex } from './log.js';
import { defaultLyConverter, type LyConverter } from './lyConvert.js';
import type { Decision, MatchBand, MatchReason } from './match.js';
import { scoreDataFromMidi } from './midiScore.js';
import type { MatchCandidateInput } from './signals.js';
import type { SymbolicFormat } from './types.js';

export interface SymbolicSourceMeta {
    tier: 'symbolic';
    format: SymbolicFormat;
    sha256: string;
    url?: string;
    matchScore: number;
}

export type IngestOk = {
    ok: true;
    score: ScoreData;
    source: SymbolicSourceMeta;
};

export type IngestReject = {
    ok: false;
    band: MatchBand;
    reason: MatchReason;
    score: null;
};

export type IngestResult = IngestOk | IngestReject;

export interface IngestOptions {
    lyConverter?: LyConverter;
    log?: (line: string) => void;
}

const looksLikeZip = (bytes: Buffer): boolean => bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;

const musicalToScore = (musical: MusicalScore): ScoreData =>
    buildScoreData(musical, null, { autoPedal: false });

const ingestMusicXml = (bytes: Buffer, format: SymbolicFormat): ScoreData => {
    if (format === 'mxl' || looksLikeZip(bytes)) {
        return musicalToScore(parseMxlFiles([bytes]));
    }
    return musicalToScore(parseMusicXmlString(bytes.toString('utf8')));
};

const ingestLy = (bytes: Buffer, converter: LyConverter): ScoreData => {
    if (!converter.isAvailable()) {
        throw new Error(`${converter.name} is not available`);
    }
    return ingestMusicXml(converter.toMusicXml(bytes), 'xml');
};

export const isUnusableScore = (score: ScoreData): boolean => {
    if (score.notes.length === 0 || score.measures.length === 0) {
        return true;
    }
    if (score.warnings.includes(OVERFULL_WARNING)) {
        return true;
    }
    return !scoreDataSchema.safeParse(score).success;
};

const reject = (band: MatchBand, reason: MatchReason): IngestReject => ({
    ok: false,
    band,
    reason,
    score: null,
});

const logParserUnusable = (decision: Decision, bytes: Buffer, log?: (line: string) => void): void => {
    const sink = log ?? ((line: string) => process.stderr.write(`${line}\n`));
    const match = decision.best;
    const line = decisionLogLine({
        uploadId: 'ingest',
        pdfSha256: match?.candidate.sha256 ?? sha256Hex(bytes),
        pageCount: 0,
        workKey: match?.candidate.workKey ?? { composerId: 'unknown', catalogType: 'Op', catalogN: 0 },
        match,
        band: 'reject',
        reason: 'parser_unusable',
    });
    sink(formatDecisionLine(line));
};

const parseAccepted = (
    format: SymbolicFormat,
    bytes: Buffer,
    candidate: MatchCandidateInput,
    converter: LyConverter,
): ScoreData => {
    switch (format) {
        case 'mxl':
        case 'xml':
        case 'user-xml':
            return ingestMusicXml(bytes, format);
        case 'mid':
            return scoreDataFromMidi(bytes, {
                meter: candidate.meter,
                pickupQuarters: candidate.pickupQuarters,
                fifths: candidate.fifths,
                ...(candidate.partialBars !== undefined ? { partialBars: candidate.partialBars } : {}),
            });
        case 'ly':
            return ingestLy(bytes, converter);
        case 'mscz':
            throw new Error('mscz ingest is not supported');
        default: {
            const exhaustive: never = format;
            throw new Error(`unhandled format ${exhaustive}`);
        }
    }
};

/**
 * Accepted candidates only (`band === 'accept'`). Anything else returns a
 * typed reject without parsing. Parser failures log `parser_unusable`.
 */
export const ingestSymbolic = (
    decision: Decision,
    candidateBytes: Buffer,
    options: IngestOptions = {},
): IngestResult => {
    if (decision.band !== 'accept' || decision.best === null) {
        return reject(decision.band, decision.reason);
    }
    const converter = options.lyConverter ?? defaultLyConverter();
    try {
        const score = parseAccepted(decision.best.candidate.format, candidateBytes, decision.best.candidate, converter);
        if (isUnusableScore(score)) {
            logParserUnusable(decision, candidateBytes, options.log);
            return reject('reject', 'parser_unusable');
        }
        const source: SymbolicSourceMeta = {
            tier: 'symbolic',
            format: decision.best.candidate.format,
            sha256: decision.best.candidate.sha256 ?? sha256Hex(candidateBytes),
            matchScore: decision.best.score,
        };
        if (decision.best.candidate.url !== '') {
            source.url = decision.best.candidate.url;
        }
        return { ok: true, score, source };
    } catch {
        logParserUnusable(decision, candidateBytes, options.log);
        return reject('reject', 'parser_unusable');
    }
};
