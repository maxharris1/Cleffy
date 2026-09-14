import { ERA_AWARE_ENGINE_GENERATION, eraOfTitle, isEra } from './era.ts';

/**
 * Whether a metered re-run would rewrite the same analysis the reader already
 * has. True means score-analyze must refuse before enforce() — a cache-hit of
 * the live worker is a paid no-op.
 *
 * If the live generation cannot be read, we cannot prove the worker would
 * change the row, so this is true (do not charge).
 */
export const engineGenerationOf = (engineVersion: unknown): number | null => {
    if (typeof engineVersion !== 'string') {
        return null;
    }
    const match = /\+svc-(\d+)$/.exec(engineVersion);
    if (!match?.[1]) {
        return null;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
};

export interface NoopRegenerateInput {
    status: unknown;
    existingEngineVersion: unknown;
    liveGeneration: number | null;
    stampedEra: unknown;
    title: string | null;
}

export const regenerateWouldBeNoop = (input: NoopRegenerateInput): boolean => {
    if (input.status !== 'ready') {
        return false;
    }
    if (input.liveGeneration === null) {
        return true;
    }
    const existingGen = engineGenerationOf(input.existingEngineVersion);
    if (existingGen === null || existingGen < input.liveGeneration) {
        return false;
    }
    if (
        input.liveGeneration >= ERA_AWARE_ENGINE_GENERATION &&
        isEra(input.stampedEra) &&
        eraOfTitle(input.title) !== input.stampedEra
    ) {
        return false;
    }
    return true;
};
