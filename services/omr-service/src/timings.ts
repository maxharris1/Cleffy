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
    steps?: Record<string, number>;
}

export const emptyTimings = (): JobTimings => ({});
