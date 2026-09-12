import { describe, expect, it } from 'vitest';

import { ERA_AWARE_ENGINE_GENERATION } from '../_shared/era.ts';
import { engineGenerationOf, regenerateWouldBeNoop } from '../_shared/noopRegenerate.ts';

const ready = (over: Partial<Parameters<typeof regenerateWouldBeNoop>[0]> = {}) =>
    regenerateWouldBeNoop({
        status: 'ready',
        existingEngineVersion: 'audiveris-5.6.1+svc-6',
        liveGeneration: 6,
        stampedEra: null,
        title: null,
        ...over,
    });

describe('engineGenerationOf', () => {
    it('reads the svc suffix', () => {
        expect(engineGenerationOf('audiveris-5.11.0+svc-12')).toBe(12);
        expect(engineGenerationOf('audiveris-5.6.1')).toBeNull();
        expect(engineGenerationOf(null)).toBeNull();
    });
});

/**
 * These cases are the paid no-op the banner used to walk readers into:
 * client gen 11, live Cloud Run svc-6, click spends omr_runs, cache-hit, banner
 * returns. The gate must refuse whenever the live worker cannot improve the row,
 * including when /healthz cannot be read.
 */
describe('regenerateWouldBeNoop', () => {
    it('lets a first run through (no ready row)', () => {
        expect(
            regenerateWouldBeNoop({
                status: undefined,
                existingEngineVersion: null,
                liveGeneration: 6,
                stampedEra: null,
                title: null,
            }),
        ).toBe(false);
        expect(
            regenerateWouldBeNoop({
                status: 'failed',
                existingEngineVersion: 'audiveris-5.6.1+svc-6',
                liveGeneration: 6,
                stampedEra: null,
                title: null,
            }),
        ).toBe(false);
    });

    it('refuses when the live worker is the same generation as the row', () => {
        expect(ready()).toBe(true);
    });

    it('refuses when the live worker is behind the row', () => {
        expect(ready({ existingEngineVersion: 'audiveris-5.11.0+svc-11', liveGeneration: 6 })).toBe(true);
    });

    it('allows a re-run the live worker would actually rewrite', () => {
        expect(ready({ existingEngineVersion: 'audiveris-5.6.1+svc-5', liveGeneration: 6 })).toBe(false);
        expect(ready({ existingEngineVersion: 'audiveris-5.6.1+svc-6', liveGeneration: 12 })).toBe(false);
    });

    it('allows a re-run of an unstamped row once the worker is reachable', () => {
        expect(ready({ existingEngineVersion: null, liveGeneration: 6 })).toBe(false);
        expect(ready({ existingEngineVersion: 'audiveris-5.6.1', liveGeneration: 6 })).toBe(false);
    });

    it('refuses when the live generation cannot be read — cannot prove a rewrite', () => {
        expect(ready({ liveGeneration: null })).toBe(true);
        expect(ready({ existingEngineVersion: 'audiveris-5.6.1+svc-2', liveGeneration: null })).toBe(true);
    });

    it('allows an era mismatch only once the live worker is era-aware', () => {
        expect(
            ready({
                existingEngineVersion: 'audiveris-5.11.0+svc-11',
                liveGeneration: ERA_AWARE_ENGINE_GENERATION,
                stampedEra: 'baroque',
                title: 'Ballade (Chopin, Frédéric)',
            }),
        ).toBe(false);
        expect(
            ready({
                existingEngineVersion: 'audiveris-5.6.1+svc-6',
                liveGeneration: 6,
                stampedEra: 'baroque',
                title: 'Ballade (Chopin, Frédéric)',
            }),
        ).toBe(true);
        expect(
            ready({
                existingEngineVersion: 'audiveris-5.11.0+svc-11',
                liveGeneration: ERA_AWARE_ENGINE_GENERATION,
                stampedEra: 'baroque',
                title: 'Inventions (Bach, Johann Sebastian)',
            }),
        ).toBe(true);
    });
});
