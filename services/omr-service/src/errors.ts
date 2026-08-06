/**
 * Machine error codes stored in score_analyses.error / omr_jobs.last_error.
 * Permanence and backoff are decided in SQL (`omr_error_is_permanent`) —
 * keep this list in sync with that function.
 */
export const ERROR_CODES = {
    downloadFailed: 'download_failed',
    tooLarge: 'too_large',
    pageCountUnknown: 'page_count_unknown',
    noStavesFound: 'no_staves_found',
    omrTimeout: 'omr_timeout',
    omrCrash: 'omr_crash',
    musicXmlParseFailed: 'musicxml_parse_failed',
    /** @deprecated Retained for old rows; pull-mode uses backlog_full instead. */
    queueFull: 'queue_full',
    backlogFull: 'backlog_full',
    serviceUnreachable: 'service_unreachable',
    workerLost: 'worker_lost',
    internal: 'internal',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Mirrors SQL `omr_error_is_permanent` for unit tests / docs.
 * Production fail path does not call this — Postgres decides.
 */
export const isPermanentError = (code: ErrorCode, attempt = 1): boolean => {
    switch (code) {
        case ERROR_CODES.tooLarge:
        case ERROR_CODES.pageCountUnknown:
        case ERROR_CODES.noStavesFound:
        case ERROR_CODES.musicXmlParseFailed:
        case ERROR_CODES.backlogFull:
            return true;
        case ERROR_CODES.omrTimeout:
        case ERROR_CODES.omrCrash:
            return attempt >= 2;
        case ERROR_CODES.downloadFailed:
        case ERROR_CODES.queueFull:
        case ERROR_CODES.serviceUnreachable:
        case ERROR_CODES.workerLost:
        case ERROR_CODES.internal:
            return false;
        default: {
            const _exhaustive: never = code;
            return _exhaustive;
        }
    }
};

/** Thrown by pipeline stages that already know their public error code. */
export class JobError extends Error {
    readonly code: ErrorCode;

    constructor(code: ErrorCode, message?: string) {
        super(message ?? code);
        this.code = code;
    }
}
