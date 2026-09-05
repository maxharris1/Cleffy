#!/usr/bin/env node
/**
 * Run one or more engines over the corpus and store raw results under
 * results/raw/<engine>/<score>.json (transcript, timings, cost, warnings,
 * geometry boxes, metrics vs ground truth). `report.mjs` aggregates them.
 *
 *   node bench/accuracy/run.mjs --engines audiveris-5.6.1,audiveris-5.11.0
 *   node bench/accuracy/run.mjs --engines llm-notes,llm-geo --scores bach-prelude-846
 *   node bench/accuracy/run.mjs --engines llm-notes --model claude-haiku-4-5-20251001 --tag haiku
 *
 * Existing results are skipped unless --force. Requires `npm run build` in
 * services/omr-service (engines import dist/) and `fetch.mjs` (corpus).
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { loadGroundTruthMusical, loadReferenceBoxes } from './lib/groundTruth.mjs';
import { compareGeometry, compareTranscripts, scoreDataBoxes } from './lib/metrics.mjs';
import { ACCURACY_DIR, MANIFEST_PATH, PDF_DIR, RESULTS_DIR } from './lib/paths.mjs';
import { pdfPageCount } from './lib/pdf.mjs';
import { readResult, toTranscript, writeResult } from './lib/results.mjs';

// Must precede any import of dist/audiveris.js (reads AUDIVERIS_BIN at load).
process.env.AUDIVERIS_BIN = join(ACCURACY_DIR, 'lib', 'audiveris-docker.sh');

const { values } = parseArgs({
    options: {
        engines: { type: 'string', default: 'audiveris-5.6.1' },
        scores: { type: 'string' },
        kind: { type: 'string' },
        force: { type: 'boolean', default: false },
        model: { type: 'string' },
        tag: { type: 'string' },
        variant: { type: 'string' },
        effort: { type: 'string' },
        'spend-cap-usd': { type: 'string' },
        'keep-work': { type: 'boolean', default: false },
    },
});

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const only = values.scores ? new Set(values.scores.split(',')) : null;
const scores = manifest.scores.filter((s) => (!only || only.has(s.id)) && (!values.kind || s.kind === values.kind));
const engineNames = values.engines
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const { getEngine } = await import('./lib/engines/index.mjs');

const WORK_ROOT = join(RESULTS_DIR, 'work');
await mkdir(WORK_ROOT, { recursive: true });

const summarizeScoreData = (scoreData) => ({
    measures: scoreData.measures.length,
    measuresPlaced: scoreData.measures.filter((m) => m.sys >= 0).length,
    measuresWithSlots: scoreData.measures.filter((m) => (m.sl?.length ?? 0) > 0).length,
    systems: scoreData.systems.length,
    systemsWithStaves: scoreData.systems.filter((s) => s.staves && s.staves.length > 0).length,
    notes: scoreData.notes.length,
    bytes: Buffer.byteLength(JSON.stringify(scoreData)),
    bpmDefault: scoreData.bpmDefault ?? null,
    tempos: scoreData.tempos?.length ?? 0,
    warnings: scoreData.warnings,
});

for (const engineName of engineNames) {
    const engine = getEngine(engineName, {
        model: values.model,
        variant: values.variant,
        effort: values.effort,
        spendCapUsd: values['spend-cap-usd'],
    });
    const resultsKey = values.tag ? `${engineName}+${values.tag}` : engineName;
    console.log(`=== engine ${resultsKey}`);
    for (const score of scores) {
        if (!values.force && (await readResult(resultsKey, score.id))) {
            console.log(`  [${score.id}] cached`);
            continue;
        }
        const pdfPath = join(PDF_DIR, `${score.id}.pdf`);
        const pages = await pdfPageCount(pdfPath);
        const workDir = join(WORK_ROOT, `${resultsKey}--${score.id}`);
        await rm(workDir, { recursive: true, force: true });
        await mkdir(workDir, { recursive: true });
        const gt = await loadGroundTruthMusical(score);
        const refBoxes = await loadReferenceBoxes(score);
        const startedAt = new Date().toISOString();
        process.stdout.write(`  [${score.id}] ${pages}p ... `);
        const t0 = Date.now();
        let record = { engine: resultsKey, scoreId: score.id, kind: score.kind, tags: score.tags, pages, startedAt };
        try {
            const out = await engine.run({ score, pdfPath, workDir, pages });
            const transcript = toTranscript(out.musical);
            const boxes = scoreDataBoxes(out.scoreData);
            record = {
                ...record,
                ok: true,
                wallMs: Date.now() - t0,
                timings: out.timings,
                usd: out.usd ?? 0,
                tokens: out.tokens ?? null,
                llm: out.llm ?? null,
                scoreData: summarizeScoreData(out.scoreData),
                transcript,
                boxes,
                systems: out.scoreData.systems.map((s) => ({
                    page: s.page,
                    y0: s.y0,
                    y1: s.y1,
                    staves: s.staves?.length ?? 0,
                })),
                metrics: compareTranscripts(toTranscript(gt), transcript),
                geometryVsReference: refBoxes ? compareGeometry(boxes, refBoxes) : null,
                extra: out.extra ?? null,
            };
            const m = record.metrics;
            console.log(
                `ok ${(record.wallMs / 1000).toFixed(1)}s F1=${m.aligned.f1} global=${m.global.f1} bars=${m.measures.eng}/${m.measures.gt}` +
                    (record.usd ? ` $${record.usd.toFixed(3)}` : ''),
            );
        } catch (error) {
            record = {
                ...record,
                ok: false,
                wallMs: Date.now() - t0,
                error: { code: error?.code ?? null, message: String(error?.message ?? error) },
                usd: error?.usd ?? 0,
            };
            console.log(`FAIL ${record.error.message.slice(0, 200)}`);
        }
        await writeResult(resultsKey, score.id, record);
        if (!values['keep-work']) {
            await rm(workDir, { recursive: true, force: true });
        }
    }
}
console.log('done');
