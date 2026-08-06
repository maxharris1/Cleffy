import { describe, expect, it } from 'vitest';

import { ERROR_CODES, isPermanentError } from './errors.js';

describe('error taxonomy (mirrors SQL omr_error_is_permanent)', () => {
    it('classifies permanent vs transient', () => {
        expect(isPermanentError(ERROR_CODES.tooLarge)).toBe(true);
        expect(isPermanentError(ERROR_CODES.noStavesFound)).toBe(true);
        expect(isPermanentError(ERROR_CODES.downloadFailed)).toBe(false);
        expect(isPermanentError(ERROR_CODES.workerLost)).toBe(false);
    });

    it('gives omr_crash/timeout exactly one retry', () => {
        expect(isPermanentError(ERROR_CODES.omrCrash, 1)).toBe(false);
        expect(isPermanentError(ERROR_CODES.omrCrash, 2)).toBe(true);
        expect(isPermanentError(ERROR_CODES.omrTimeout, 1)).toBe(false);
        expect(isPermanentError(ERROR_CODES.omrTimeout, 2)).toBe(true);
    });
});
