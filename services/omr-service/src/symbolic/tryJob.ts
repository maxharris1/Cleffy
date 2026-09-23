import { alignMutopia } from './align.js';
import {
    createNetworkBytesFetcher,
    createNetworkSymbolicClient,
    type SymbolicJobClient,
} from './candidateClient.js';
import { fingerprintCandidate } from './fingerprint.js';
import { createNetworkFetcher, rateLimitedFetcher } from './http.js';
import { ingestSymbolic } from './ingest.js';
import { analysisSourceFromDecision, type SymbolicJobResult, type SymbolicLayoutKey } from './jobResult.js';
import { decisionLogLine, formatDecisionLine, sha256Hex } from './log.js';
import { decideSymbolic, type Decision, type MatchReason, type MatchResult } from './match.js';
import { isConcatUrl } from './midiConcat.js';
import { pdfSignalsFromPdf } from './pdfRead.js';
import type { MatchCandidateInput, PdfSignals } from './signals.js';
import type { RankedCandidate, WorkKey } from './types.js';
import {
    createGeminiCallerFromEnv,
    createVisionWorkKeyProvider,
    hydrateGeminiKeyFromFiles,
} from './visionId.js';
import { pdfTextWorkKeyProvider, pickWorkKey, type WorkKeyProvider } from './workKeyProvider.js';
import type { CorpusHit } from '../corpus/store.js';

export interface TrySymbolicContext {
    uploadId: string;
    pageCount: number;
    imslpPageTitle?: string;
    filename?: string;
}

export interface TrySymbolicDeps {
    client: SymbolicJobClient;
    pdfSignals?: (bytes: Buffer) => Promise<PdfSignals>;
    fingerprint?: typeof fingerprintCandidate;
    ingest?: typeof ingestSymbolic;
    align?: typeof alignMutopia;
    log?: (line: string) => void;
    workKeyProvider?: WorkKeyProvider;
    /**
     * Corpus layout lookup (another edition of the same work, exact printed
     * bars + page count). Injected by the job only when CLEFFY_CORPUS_LOOKUP
     * is on; a unique hit accepts without discover, anything else discovers.
     */
    corpusLayout?: (workKey: WorkKey, printedBars: number, pageCount: number) => Promise<CorpusHit | null>;
}

let cachedDefaultClient: SymbolicJobClient | null = null;

export const defaultSymbolicClient = (): SymbolicJobClient => {
    if (cachedDefaultClient === null) {
        cachedDefaultClient = createNetworkSymbolicClient(
            rateLimitedFetcher(createNetworkFetcher()),
            createNetworkBytesFetcher(),
        );
    }
    return cachedDefaultClient;
};

export const defaultSymbolicDeps = (): TrySymbolicDeps => {
    hydrateGeminiKeyFromFiles();
    return {
        client: defaultSymbolicClient(),
        workKeyProvider: createVisionWorkKeyProvider(createGeminiCallerFromEnv()),
    };
};

const emptyDecision = (): Decision => ({ band: 'reject', reason: 'no_candidate', best: null, results: [] });

const unknownWorkKey = (): WorkKey => ({ composerId: 'unknown', catalogType: 'Op', catalogN: 0 });

/** Same-work Mutopia/CC MIDI we already fetched. Bar-count misses still play. */
const isFoundSameWorkMidi = (row: MatchResult): boolean => {
    if (!row.signals.catalogHit || row.candidate.arrangement || row.candidate.format !== 'mid') {
        return false;
    }
    switch (row.reason) {
        case 'arrangement':
        case 'performance_midi':
        case 'meter':
        case 'no_candidate':
        case 'parser_unusable':
            return false;
        case 'accept':
        case 'ambiguous':
        case 'bars':
        case 'low_score':
        case 'alignment_failed':
            return true;
        default: {
            const exhaustive: never = row.reason;
            throw new Error(`unhandled match reason ${exhaustive}`);
        }
    }
};

const choosePlaybackCandidate = (decision: Decision): MatchResult | null => {
    if (decision.best !== null && decision.band === 'accept') {
        return decision.best;
    }
    if (decision.reason !== 'bars' && decision.reason !== 'ambiguous') {
        return null;
    }
    const playable = decision.results.filter(isFoundSameWorkMidi);
    if (playable.length === 0) {
        return null;
    }
    const concat = playable.filter((row) => isConcatUrl(row.candidate.url));
    const pool = concat.length > 0 ? concat : playable;
    const unknownPrint = pool.every((row) => row.signals.barCountPdf <= 0);
    const ranked = [...pool].sort((a, b) => {
        if (unknownPrint) {
            return b.signals.barCountCand - a.signals.barCountCand || b.score - a.score;
        }
        return a.barError - b.barError || b.score - a.score;
    });
    return ranked[0] ?? null;
};

const emit = (deps: TrySymbolicDeps, line: string): void => {
    if (deps.log) {
        deps.log(line);
        return;
    }
    process.stderr.write(`${line}\n`);
};

const layoutKeyOf = (pdf: PdfSignals, workKey: WorkKey): SymbolicLayoutKey => ({
    workKey,
    printedBars: pdf.printedBars,
    pageCount: pdf.pageCount,
});

const fallthrough = (
    ctx: TrySymbolicContext,
    pdfSha256: string,
    workKey: WorkKey,
    decision: Decision,
    reason: MatchReason,
    deps: TrySymbolicDeps,
    layout?: SymbolicLayoutKey,
): SymbolicJobResult => {
    const band = reason === 'parser_unusable' || reason === 'alignment_failed' ? 'reject' : decision.band;
    const line = decisionLogLine({
        uploadId: ctx.uploadId,
        pdfSha256,
        pageCount: ctx.pageCount,
        workKey,
        ...(ctx.imslpPageTitle !== undefined ? { imslpPageTitle: ctx.imslpPageTitle } : {}),
        match: decision.best,
        band,
        reason,
    });
    const text = formatDecisionLine(line);
    emit(deps, text);
    return {
        kind: 'fallthrough',
        source: analysisSourceFromDecision(
            'omr',
            band,
            reason,
            decision.best?.score,
            decision.best
                ? { source: decision.best.candidate.source, format: decision.best.candidate.format }
                : null,
        ),
        logLine: text,
        ...(layout !== undefined ? { layout } : {}),
    };
};

const fetchAndFingerprint = async (
    ranked: readonly RankedCandidate[],
    pdf: PdfSignals,
    client: SymbolicJobClient,
    fingerprint: typeof fingerprintCandidate,
): Promise<MatchCandidateInput[]> => {
    const inputs: MatchCandidateInput[] = [];
    for (const cand of ranked) {
        let bytes: Buffer;
        try {
            bytes = await client.fetchBytes(cand.url);
        } catch {
            continue;
        }
        const input = fingerprint(cand, bytes, pdf);
        if (input === null) {
            continue;
        }
        if (cand.format === 'mid') {
            input.midi = bytes;
        }
        inputs.push(input);
    }
    return inputs;
};

/**
 * Discover → score → ingest → align. Accept skips Audiveris. Anything else
 * (ambiguous, reject, network, parser, alignment) is a fallthrough that keeps
 * the decision log; the caller must not re-score after OMR.
 */
export const trySymbolicJob = async (
    pdfBytes: Buffer,
    ctx: TrySymbolicContext,
    deps: TrySymbolicDeps,
): Promise<SymbolicJobResult> => {
    const pdfSha256 = sha256Hex(pdfBytes);
    const readPdf = deps.pdfSignals ?? pdfSignalsFromPdf;
    const fingerprint = deps.fingerprint ?? fingerprintCandidate;
    const ingest = deps.ingest ?? ingestSymbolic;
    const align = deps.align ?? alignMutopia;
    const workKeyProvider = deps.workKeyProvider ?? pdfTextWorkKeyProvider;

    let pdf: PdfSignals;
    try {
        pdf = await readPdf(pdfBytes);
    } catch {
        return fallthrough(ctx, pdfSha256, unknownWorkKey(), emptyDecision(), 'no_candidate', deps);
    }

    const hits = await workKeyProvider.identify({
        pdfBytes,
        pdfTextWorkKey: pdf.workKey,
        ...(ctx.imslpPageTitle !== undefined
            ? { imslpTitle: ctx.imslpPageTitle, imslpPageTitle: ctx.imslpPageTitle }
            : {}),
        ...(ctx.filename !== undefined ? { filename: ctx.filename } : {}),
    });
    const workKey = pickWorkKey(hits, pdf.workKey);
    pdf = { ...pdf, workKey };
    const layout = layoutKeyOf(pdf, workKey);
    const pdfLayout = { boxes: pdf.barBoxes, pickupFlagged: pdf.pickupFlagged, printedBars: pdf.printedBars };

    // Corpus first: another edition of this work with the same printed bars and
    // pages is served without Mutopia. Its score is re-aligned onto THIS PDF's
    // bar boxes; a collision, miss, or failed alignment discovers as before.
    if (deps.corpusLayout) {
        const hit = await deps.corpusLayout(workKey, pdf.printedBars, pdf.pageCount);
        if (hit) {
            const realigned = align(pdfLayout, hit.score, pdfSha256, hit.candidateSha256 ?? hit.pdfSha256);
            if (realigned.ok) {
                const line = decisionLogLine({
                    uploadId: ctx.uploadId,
                    pdfSha256,
                    pageCount: ctx.pageCount,
                    workKey,
                    ...(ctx.imslpPageTitle !== undefined ? { imslpPageTitle: ctx.imslpPageTitle } : {}),
                    match: null,
                    band: 'accept',
                    reason: 'accept',
                });
                line.candidate = { source: 'corpus', url: '', sha256: hit.pdfSha256, format: '' };
                const text = formatDecisionLine(line);
                emit(deps, text);
                return {
                    kind: 'accept',
                    score: hit.score,
                    alignmentMap: realigned.map,
                    source: hit.source,
                    logLine: text,
                    layout,
                    candidate: null,
                    corpusHit: 'layout',
                };
            }
        }
    }

    let ranked: RankedCandidate[];
    try {
        ranked = await deps.client.discover(workKey, { imslpPageTitle: ctx.imslpPageTitle });
    } catch {
        return fallthrough(ctx, pdfSha256, workKey, emptyDecision(), 'no_candidate', deps, layout);
    }
    if (ranked.length === 0) {
        return fallthrough(ctx, pdfSha256, workKey, emptyDecision(), 'no_candidate', deps, layout);
    }

    const inputs = await fetchAndFingerprint(ranked, pdf, deps.client, fingerprint);
    if (inputs.length === 0) {
        return fallthrough(ctx, pdfSha256, workKey, emptyDecision(), 'no_candidate', deps, layout);
    }

    const decision = decideSymbolic(pdf, inputs);
    const chosen = choosePlaybackCandidate(decision);
    if (chosen === null) {
        return fallthrough(ctx, pdfSha256, workKey, decision, decision.reason, deps, layout);
    }

    let candidateBytes: Buffer;
    try {
        candidateBytes = await deps.client.fetchBytes(chosen.candidate.url);
    } catch {
        return fallthrough(ctx, pdfSha256, workKey, emptyDecision(), 'no_candidate', deps, layout);
    }

    const ingestDecision: Decision = {
        band: 'accept',
        reason: 'accept',
        best: chosen,
        results: decision.results,
    };
    let ingested: ReturnType<typeof ingestSymbolic>;
    try {
        ingested = ingest(ingestDecision, candidateBytes);
    } catch {
        return fallthrough(ctx, pdfSha256, workKey, decision, 'parser_unusable', deps, layout);
    }
    if (!ingested.ok) {
        const reason: MatchReason = ingested.reason === 'parser_unusable' ? 'parser_unusable' : ingested.reason;
        return fallthrough(ctx, pdfSha256, workKey, decision, reason, deps, layout);
    }

    const aligned = align(pdfLayout, ingested.score, pdfSha256, ingested.source.sha256);
    const alignmentMap = aligned.ok ? aligned.map : null;
    const line = decisionLogLine({
        uploadId: ctx.uploadId,
        pdfSha256,
        pageCount: ctx.pageCount,
        workKey,
        ...(ctx.imslpPageTitle !== undefined ? { imslpPageTitle: ctx.imslpPageTitle } : {}),
        match: chosen,
        band: 'accept',
        reason: aligned.ok ? 'accept' : decision.reason === 'accept' ? 'alignment_failed' : decision.reason,
    });
    const text = formatDecisionLine(line);
    emit(deps, text);
    return {
        kind: 'accept',
        score: ingested.score,
        alignmentMap,
        source: analysisSourceFromDecision('symbolic', 'accept', 'accept', chosen.score, {
            source: chosen.candidate.source,
            format: chosen.candidate.format,
        }),
        logLine: text,
        layout,
        candidate: {
            source: chosen.candidate.source,
            format: chosen.candidate.format,
            url: chosen.candidate.url,
            sha256: ingested.source.sha256,
        },
    };
};
