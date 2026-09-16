import type { CorpusGateVerdict } from './corpus/gate.js';
import type { AlignmentMap } from './symbolic/align.js';
import type { AnalysisSource } from './symbolic/jobResult.js';

/** Per-job timing / size telemetry written to score_analyses.timings. */
export interface JobTimings {
    downloadMs?: number;
    pdfBytes?: number;
    pageCount?: number;
    jvmStartToFirstSheetMs?: number;
    perSheetMs?: number[];
    audiverisTotalMs?: number;
    parseMs?: number;
    writebackMs?: number;
    cacheHit?: boolean;
    /** Step durations in ms (share of wall); preferred over counts for OCR gate. */
    steps?: Record<string, number>;
    /** Raw step sighting counts (debug). */
    stepCounts?: Record<string, number>;
    /** Parallel path outcome when pageCount >= 4. `serial` = never started (low RAM). */
    parallelPath?: 'merged' | 'serial_fallback' | 'serial';
    parallelFallbackReasons?: string[];
    /** Bar-voices the rhythm repair edited (musicxml.ts / rhythmRepair.ts). */
    rhythmRepairs?: number;
    /** Key events the key-signature repair dropped (musicxml.ts / keyRepair.ts). */
    keyRepairs?: number;
    /** 1-based PDF pages Audiveris flagged invalid (no staves) and we skipped. */
    invalidSheets?: number[];
    /**
     * Sibling of ScoreData (not part of scoreDataSchema). Present when
     * CLEFFY_SYMBOLIC_FIRST ran; absent when the flag is off so timings stay
     * byte-identical to the pre-symbolic job.
     */
    source?: AnalysisSource;
    /** Printed-bar cursor. Only stamped on a symbolic accept. */
    alignmentMap?: AlignmentMap;
    /**
     * Served from playalong_corpus: by this PDF's sha256, or by WorkKey +
     * printed bars + page count (another edition). Absent when
     * CLEFFY_CORPUS_LOOKUP is off or the corpus missed.
     */
    corpusHit?: 'hash' | 'layout';
    /** Time spent in corpus RPCs. Only present when CLEFFY_CORPUS_LOOKUP is on. */
    corpusLookupMs?: number;
    /**
     * Outcome of the corpus-promotion gate, present only on a job that was a
     * corpus candidate (an IMSLP import or a corpus-owner seed). `promoted:
     * false` means the analysis is served to this user but withheld from the
     * corpus; the seed reconciles those ledger rows to `needs_review`.
     */
    corpusGate?: CorpusGateVerdict;
}

export const emptyTimings = (): JobTimings => ({});
