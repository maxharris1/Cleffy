/**
 * Machine error codes stored in score_analyses.error. The app maps these to
 * friendly copy in the transport bar — add new codes there too.
 */
export const ERROR_CODES = {
    downloadFailed: 'download_failed',
    tooLarge: 'too_large',
    noStavesFound: 'no_staves_found',
    omrTimeout: 'omr_timeout',
    omrCrash: 'omr_crash',
    musicXmlParseFailed: 'musicxml_parse_failed',
    queueFull: 'queue_full',
    serviceUnreachable: 'service_unreachable',
    internal: 'internal',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Thrown by pipeline stages that already know their public error code. */
export class JobError extends Error {
    readonly code: ErrorCode;

    constructor(code: ErrorCode, message?: string) {
        super(message ?? code);
        this.code = code;
    }
}
