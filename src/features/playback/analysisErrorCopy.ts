/**
 * Reader-facing copy for score-analyze / OMR failure codes. Shared by the
 * transport's failed state and the IMSLP import panel, so a rate-limited
 * auto-analysis after an import says the same thing Retry would.
 */
export const ANALYSIS_ERROR_COPY: Record<string, string> = {
    too_large: 'This score is too long to analyze (60-page limit).',
    page_count_unknown: 'Page count is missing — reopen the score so we can measure it, then try Generate again.',
    no_staves_found: "Couldn't find readable music in this PDF.",
    omr_timeout: 'Analysis took too long and was stopped.',
    omr_crash: 'The music-recognition engine crashed on this score.',
    musicxml_parse_failed: 'The recognized music could not be converted.',
    queue_full: 'The analysis service is busy — try again in a few minutes.',
    backlog_full: 'You already have several scores analyzing — try Generate again shortly.',
    rate_limited: 'Too many analysis requests in a short time — wait a minute, then try again.',
    service_unreachable: 'The analysis service is not reachable right now.',
    download_failed: 'The PDF could not be fetched for analysis.',
    worker_lost: 'The analysis was interrupted and will retry automatically.',
    stale: 'The analysis was interrupted.',
    internal: 'Something went wrong during analysis.',
};

export const analysisErrorText = (code: string): string =>
    ANALYSIS_ERROR_COPY[code] ?? ANALYSIS_ERROR_COPY['internal'] ?? '';
