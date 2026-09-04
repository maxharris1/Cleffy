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
}

export const emptyTimings = (): JobTimings => ({});
