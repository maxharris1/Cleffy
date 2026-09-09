import { describe, expect, it } from 'vitest';

import {
    analysisIsStale,
    CURRENT_ENGINE_GENERATION,
    DEPLOYED_ENGINE_GENERATION,
} from '@/features/playback/scoreAnalysisService';

const stamped = (generation: number): string => `audiveris-5.6.1+svc-${generation}`;

/**
 * The regenerate offer must never be a paid no-op: it may only appear when the
 * DEPLOYED worker would produce something newer than the row it is shown on.
 * The client's own generation regularly runs ahead of the deploy (the OMR
 * image ships from main only), and that gap must stay invisible to readers.
 */
describe('analysisIsStale', () => {
    it('does not offer a re-run the deployed worker would answer with the same row', () => {
        expect(analysisIsStale(stamped(DEPLOYED_ENGINE_GENERATION))).toBe(false);
    });

    it('caps the offer at the deployed generation, not the client one', () => {
        // A row the client could read better than the worker can rewrite: the
        // click would burn a metered omr_runs credit and change nothing.
        for (let generation = DEPLOYED_ENGINE_GENERATION; generation <= CURRENT_ENGINE_GENERATION; generation++) {
            expect(analysisIsStale(stamped(generation))).toBe(false);
        }
    });

    it('offers a re-run when the deployed worker can actually better the row', () => {
        expect(analysisIsStale(stamped(DEPLOYED_ENGINE_GENERATION - 1))).toBe(true);
    });

    it('treats an unstamped analysis as the oldest data there is', () => {
        expect(analysisIsStale(null)).toBe(true);
        expect(analysisIsStale('audiveris-5.6.1')).toBe(true);
    });

    it('never claims a deploy the client does not understand', () => {
        // The cap only means "worker lags client". If this fails, the constant
        // was bumped ahead of CURRENT_ENGINE_GENERATION and readers would be
        // offered re-runs whose payloads this bundle may reject wholesale.
        expect(DEPLOYED_ENGINE_GENERATION).toBeLessThanOrEqual(CURRENT_ENGINE_GENERATION);
    });
});
