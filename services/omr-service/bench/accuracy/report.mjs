#!/usr/bin/env node
/**
 * Aggregate results/raw/<engine>/<score>.json into results/summary.{csv,md,json}.
 *
 *   node bench/accuracy/report.mjs
 *   node bench/accuracy/report.mjs --engines audiveris-5.6.1,llm-geo+sys
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { MANIFEST_PATH, RAW_RESULTS_DIR, RESULTS_DIR } from './lib/paths.mjs';
import { listEngines } from './lib/results.mjs';

const { values } = parseArgs({ options: { engines: { type: 'string' } } });

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const scoreOrder = new Map(manifest.scores.map((s, i) => [s.id, i]));
const engines = values.engines ? values.engines.split(',') : await listEngines();

const rows = [];
for (const engine of engines) {
    let files = [];
    try {
        files = (await readdir(join(RAW_RESULTS_DIR, engine))).filter((f) => f.endsWith('.json'));
    } catch {
        continue;
    }
    for (const file of files) {
        const r = JSON.parse(await readFile(join(RAW_RESULTS_DIR, engine, file), 'utf8'));
        const m = r.metrics;
        const g = r.geometryVsReference;
        rows.push({
            engine,
            score: r.scoreId,
            kind: r.kind,
            pages: r.pages,
            ok: r.ok,
            error: r.ok ? '' : r.error?.message?.slice(0, 120) ?? '',
            wallMs: r.wallMs,
            wallMsPerPage: r.pages ? Math.round(r.wallMs / r.pages) : null,
            usd: r.usd ?? 0,
            tokensIn: r.tokens?.input ?? null,
            tokensOut: r.tokens?.output ?? null,
            f1: m?.aligned.f1 ?? null,
            precision: m?.aligned.precision ?? null,
            recall: m?.aligned.recall ?? null,
            anyHandF1: m?.aligned.anyHandF1 ?? null,
            globalF1: m?.global.f1 ?? null,
            onsetMeanAbs: m?.aligned.onsetAbsMeanTicks ?? null,
            durationAcc: m?.aligned.durationAccuracy ?? null,
            barsGt: m?.measures.gt ?? null,
            barsEng: m?.measures.eng ?? null,
            barsAligned: m?.measures.aligned ?? null,
            barsExactDur: m?.measures.exactDuration ?? null,
            barsOverfull: m?.measures.overfull ?? null,
            barsUnderfull: m?.measures.underfull ?? null,
            geoRecall: g?.recall ?? null,
            geoXIoU: g?.xIoU ?? null,
            measuresPlaced: r.scoreData?.measuresPlaced ?? null,
            measuresWithSlots: r.scoreData?.measuresWithSlots ?? null,
            systemsWithStaves: r.scoreData?.systemsWithStaves ?? null,
            fallbackPages: r.llm?.fallbackPages?.length ?? null,
            llmCalls: r.llm?.calls ?? null,
            warnings: (r.scoreData?.warnings ?? []).join(' '),
        });
    }
}
rows.sort((a, b) => a.engine.localeCompare(b.engine) || (scoreOrder.get(a.score) ?? 99) - (scoreOrder.get(b.score) ?? 99));

const csvCols = Object.keys(rows[0] ?? { engine: '' });
const csvEscape = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const csv = [csvCols.join(','), ...rows.map((r) => csvCols.map((c) => csvEscape(r[c])).join(','))].join('\n');
await writeFile(join(RESULTS_DIR, 'summary.csv'), `${csv}\n`);

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
    if (!xs.length) {
        return null;
    }
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const fmt = (v, d = 3) => (v === null || v === undefined || Number.isNaN(v) ? '—' : typeof v === 'number' ? v.toFixed(d) : String(v));

const aggregate = (subset) => {
    const ok = subset.filter((r) => r.ok);
    return {
        scores: subset.length,
        ok: ok.length,
        failed: subset.length - ok.length,
        meanF1: mean(ok.map((r) => r.f1)),
        medianF1: median(ok.map((r) => r.f1)),
        meanPrecision: mean(ok.map((r) => r.precision)),
        meanRecall: mean(ok.map((r) => r.recall)),
        meanGlobalF1: mean(ok.map((r) => r.globalF1)),
        meanOnsetAbs: mean(ok.map((r) => r.onsetMeanAbs)),
        barCountExact: ok.filter((r) => r.barsGt === r.barsEng).length,
        meanBarCountErr: mean(ok.map((r) => Math.abs(r.barsEng - r.barsGt) / Math.max(1, r.barsGt))),
        meanBarsExactDur: mean(ok.map((r) => r.barsExactDur / Math.max(1, r.barsEng))),
        meanWallMsPerPage: mean(subset.map((r) => r.wallMsPerPage).filter((v) => v !== null)),
        medianWallMsPerPage: median(subset.map((r) => r.wallMsPerPage).filter((v) => v !== null)),
        totalUsd: subset.reduce((a, r) => a + (r.usd ?? 0), 0),
        usdPerPage: subset.reduce((a, r) => a + (r.usd ?? 0), 0) / Math.max(1, subset.reduce((a, r) => a + r.pages, 0)),
        meanGeoRecall: mean(ok.map((r) => r.geoRecall).filter((v) => v !== null)),
        meanGeoXIoU: mean(ok.map((r) => r.geoXIoU).filter((v) => v !== null)),
        placedShare: mean(ok.map((r) => (r.barsEng ? r.measuresPlaced / r.barsEng : null)).filter((v) => v !== null)),
        slotsShare: mean(ok.map((r) => (r.barsEng ? r.measuresWithSlots / r.barsEng : null)).filter((v) => v !== null)),
        fallbackPages: subset.reduce((a, r) => a + (r.fallbackPages ?? 0), 0),
    };
};

const summary = {};
const md = ['# Accuracy benchmark — summary', '', `Generated ${new Date().toISOString()} from ${rows.length} runs.`, ''];
for (const kind of ['all', 'typeset', 'scan']) {
    md.push(`## ${kind === 'all' ? 'All scores' : `${kind} scores`}`, '');
    md.push(
        '| engine | scores | ok | mean F1 | median F1 | P | R | global F1 | onset |Δ| | bars exact | bar-count err | bars exact dur | wall/page (median) | $/page | $ total | geo recall | geo xIoU | placed | slots | fallback pages |',
    );
    md.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const engine of engines) {
        const subset = rows.filter((r) => r.engine === engine && (kind === 'all' || r.kind === kind));
        if (subset.length === 0) {
            continue;
        }
        const a = aggregate(subset);
        summary[kind] ??= {};
        summary[kind][engine] = a;
        md.push(
            `| ${engine} | ${a.scores} | ${a.ok} | ${fmt(a.meanF1)} | ${fmt(a.medianF1)} | ${fmt(a.meanPrecision)} | ${fmt(a.meanRecall)} | ${fmt(a.meanGlobalF1)} | ${fmt(a.meanOnsetAbs, 0)} | ${a.barCountExact}/${a.ok} | ${fmt(a.meanBarCountErr)} | ${fmt(a.meanBarsExactDur)} | ${fmt(a.medianWallMsPerPage === null ? null : a.medianWallMsPerPage / 1000, 1)}s | ${fmt(a.usdPerPage, 4)} | ${fmt(a.totalUsd, 2)} | ${fmt(a.meanGeoRecall)} | ${fmt(a.meanGeoXIoU)} | ${fmt(a.placedShare)} | ${fmt(a.slotsShare)} | ${a.fallbackPages} |`,
        );
    }
    md.push('');
}

md.push('## Per score — aligned note F1 (bars engine/gt)', '');
md.push(`| score | kind | pages | ${engines.join(' | ')} |`);
md.push(`|---|---|---:|${engines.map(() => '---:').join('|')}|`);
for (const score of manifest.scores) {
    const cells = engines.map((engine) => {
        const r = rows.find((x) => x.engine === engine && x.score === score.id);
        if (!r) {
            return '—';
        }
        if (!r.ok) {
            return `FAIL (${r.error.slice(0, 30)})`;
        }
        return `${fmt(r.f1)} (${r.barsEng}/${r.barsGt})`;
    });
    const pages = rows.find((x) => x.score === score.id)?.pages ?? '';
    md.push(`| ${score.id} | ${score.kind} | ${pages} | ${cells.join(' | ')} |`);
}
md.push('');
md.push('## Per score — wall seconds / USD', '');
md.push(`| score | ${engines.join(' | ')} |`);
md.push(`|---|${engines.map(() => '---:').join('|')}|`);
for (const score of manifest.scores) {
    const cells = engines.map((engine) => {
        const r = rows.find((x) => x.engine === engine && x.score === score.id);
        return r ? `${(r.wallMs / 1000).toFixed(0)}s${r.usd ? ` / $${r.usd.toFixed(3)}` : ''}` : '—';
    });
    md.push(`| ${score.id} | ${cells.join(' | ')} |`);
}
md.push('');
md.push(
    'F1 = aligned note F1 (pitch + hand + onset within an eighth, after Needleman-Wunsch bar alignment). global F1 = absolute-tick matching, no alignment. placed/slots = share of ScoreData bars with page geometry / with `sl` slots. geo = measure boxes vs MuseScore `.mpos` (typeset) or Audiveris 5.6.1 `.omr` (scan) reference.',
);

await writeFile(join(RESULTS_DIR, 'summary.md'), `${md.join('\n')}\n`);
await writeFile(join(RESULTS_DIR, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), engines, summary, rows }, null, 1));
console.log(md.join('\n'));
