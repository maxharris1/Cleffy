/**
 * Experimental engines (dist/experimental/pipeline.js):
 *   llm-notes  Track B only — LLM transcription, no geometry, no fallback.
 *   llm-geo    Track B + Track A (cheap geometry) + page-level Audiveris fallback.
 *
 * `--variant` selects geometry/crop: `cv` (default), `grid`, `cv-system`
 * (system-band crops instead of full pages). `--model` overrides the model.
 * All calls go through one spend ledger (results/llm-ledger.json, cap from
 * --spend-cap-usd or LLM_SPEND_CAP_USD, default $20) and a disk cache
 * (results/llm-cache) so re-runs are free.
 */
import { join } from 'node:path';

import { DIST_DIR, LLM_CACHE_DIR, RESULTS_DIR } from '../paths.mjs';

const dist = (name) => import(join(DIST_DIR, name));

let shared = null;
const sharedClient = async (spendCapUsd) => {
    if (shared) {
        return shared;
    }
    const [{ AnthropicTranscriber }, { SpendLedger, ResponseCache }] = await Promise.all([
        dist('experimental/llm/anthropic.js'),
        dist('experimental/llm/ledger.js'),
    ]);
    const cap = Number(spendCapUsd ?? process.env.LLM_SPEND_CAP_USD ?? 20);
    const ledger = new SpendLedger(join(RESULTS_DIR, 'llm-ledger.json'), cap);
    // LLM_NO_CACHE=1 forces live calls (determinism checks).
    const cache = new ResponseCache(process.env.LLM_NO_CACHE ? null : LLM_CACHE_DIR);
    shared = new AnthropicTranscriber({ ledger, cache, log: (line) => process.stdout.write(`\n    ${line}`) });
    return shared;
};

const parseVariant = (variant) => {
    const v = variant ?? 'cv';
    const [geometryVariant, unit] = v.split('-');
    return { geometryVariant: geometryVariant === 'grid' ? 'grid' : 'cv', unit: unit === 'system' ? 'system' : 'page' };
};

export const runLlmEngine = async ({ pdfPath, workDir, mode, model, variant, effort, spendCapUsd }) => {
    if (mode === 'geo-only') {
        throw new Error('geo-only is measured by geometry.mjs');
    }
    const { analyzeExperimental } = await dist('experimental/pipeline.js');
    const client = await sharedClient(spendCapUsd);
    const { geometryVariant, unit } = parseVariant(variant);
    const spentBefore = await client.ledger.spent();
    try {
        const out = await analyzeExperimental(pdfPath, workDir, {
            client,
            mode,
            geometryVariant,
            unit,
            model,
            effort,
            log: (line) => process.stdout.write(`\n    ${line}`),
        });
        process.stdout.write('\n    ');
        return {
            musical: out.musical,
            scoreData: out.scoreData,
            geometry: out.geometry,
            timings: {
                wallMs: out.timings.totalMs,
                ...out.timings,
            },
            usd: out.usage.usd,
            tokens: {
                input: out.usage.inputTokens,
                output: out.usage.outputTokens,
                cacheRead: out.usage.cacheReadTokens,
                cacheWrite: out.usage.cacheWriteTokens,
            },
            llm: {
                ...out.llm,
                geometryVariant: out.cheapGeometry?.source ?? null,
                fallbackPages: out.fallbackPages,
                fallbackErrors: out.fallbackErrors,
                merge: out.merge,
                warnings: out.warnings,
            },
            extra: { transcriptions: out.transcriptions },
        };
    } catch (error) {
        // Attribute whatever was spent on the failed attempt to the record.
        error.usd = (await client.ledger.spent()) - spentBefore;
        throw error;
    }
};
