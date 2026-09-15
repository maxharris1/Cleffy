import { alignMutopia } from './align.js';
import {
    createNetworkBytesFetcher,
    createNetworkSymbolicClient,
    type SymbolicJobClient,
} from './candidateClient.js';
import { fingerprintCandidate } from './fingerprint.js';
import { createNetworkFetcher, rateLimitedFetcher } from './http.js';
import { ingestSymbolic } from './ingest.js';
import { analysisSourceFromDecision, type SymbolicJobResult } from './jobResult.js';
import { decisionLogLine, formatDecisionLine, sha256Hex } from './log.js';
import { decideSymbolic, type Decision, type MatchReason } from './match.js';
import { pdfSignalsFromPdf } from './pdfRead.js';
import type { MatchCandidateInput, PdfSignals } from './signals.js';
import type { RankedCandidate, WorkKey } from './types.js';
import {
    createGeminiCallerFromEnv,
    createVisionWorkKeyProvider,
    hydrateGeminiKeyFromFiles,
} from './visionId.js';
import { pdfTextWorkKeyProvider, pickWorkKey, type WorkKeyProvider } from './workKeyProvider.js';

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

const emit = (deps: TrySymbolicDeps, line: string): void => {
    if (deps.log) {
        deps.log(line);
        return;
    }
    process.stderr.write(`${line}\n`);
};

const fallthrough = (
    ctx: TrySymbolicContext,
    pdfSha256: string,
    workKey: WorkKey,
    decision: Decision,
    reason: MatchReason,
    deps: TrySymbolicDeps,
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
    let ranked: RankedCandidate[];
    try {
        ranked = await deps.client.discover(workKey, { imslpPageTitle: ctx.imslpPageTitle });
    } catch {
        return fallthrough(ctx, pdfSha256, workKey, emptyDecision(), 'no_candidate', deps);
    }
    if (ranked.length === 0) {
        return fallthrough(ctx, pdfSha256, workKey, emptyDecision(), 'no_candidate', deps);
    }

    const inputs = await fetchAndFingerprint(ranked, pdf, deps.client, fingerprint);
    if (inputs.length === 0) {
        return fallthrough(ctx, pdfSha256, workKey, emptyDecision(), 'no_candidate', deps);
    }

    const decision = decideSymbolic(pdf, inputs);
    if (decision.band !== 'accept' || decision.best === null) {
        return fallthrough(ctx, pdfSha256, workKey, decision, decision.reason, deps);
    }

    let candidateBytes: Buffer;
    try {
        candidateBytes = await deps.client.fetchBytes(decision.best.candidate.url);
    } catch {
        return fallthrough(ctx, pdfSha256, workKey, emptyDecision(), 'no_candidate', deps);
    }

    let ingested: ReturnType<typeof ingestSymbolic>;
    try {
        ingested = ingest(decision, candidateBytes);
    } catch {
        return fallthrough(ctx, pdfSha256, workKey, decision, 'parser_unusable', deps);
    }
    if (!ingested.ok) {
        const reason: MatchReason = ingested.reason === 'parser_unusable' ? 'parser_unusable' : ingested.reason;
        return fallthrough(ctx, pdfSha256, workKey, decision, reason, deps);
    }

    const aligned = align(
        { boxes: pdf.barBoxes, pickupFlagged: pdf.pickupFlagged, printedBars: pdf.printedBars },
        ingested.score,
        pdfSha256,
        ingested.source.sha256,
    );
    if (!aligned.ok) {
        return fallthrough(ctx, pdfSha256, workKey, decision, 'alignment_failed', deps);
    }

    const line = decisionLogLine({
        uploadId: ctx.uploadId,
        pdfSha256,
        pageCount: ctx.pageCount,
        workKey,
        ...(ctx.imslpPageTitle !== undefined ? { imslpPageTitle: ctx.imslpPageTitle } : {}),
        match: decision.best,
        band: 'accept',
        reason: 'accept',
    });
    const text = formatDecisionLine(line);
    emit(deps, text);
    return {
        kind: 'accept',
        score: ingested.score,
        alignmentMap: aligned.map,
        source: analysisSourceFromDecision('symbolic', 'accept', 'accept', decision.best.score, {
            source: decision.best.candidate.source,
            format: decision.best.candidate.format,
        }),
        logLine: text,
    };
};
