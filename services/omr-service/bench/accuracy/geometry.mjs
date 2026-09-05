#!/usr/bin/env node
/**
 * Track A evaluation: cheap geometry (OpenCV, Audiveris GRID) vs reference
 * measure boxes — MuseScore .mpos for typeset scores, the Audiveris 5.6.1
 * baseline's .omr boxes for scans. Writes results/geometry.json + geometry.md.
 *
 *   node bench/accuracy/geometry.mjs [--scores a,b] [--variants cv,grid]
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { loadReferenceBoxes } from './lib/groundTruth.mjs';
import { compareGeometry } from './lib/metrics.mjs';
import { ACCURACY_DIR, DIST_DIR, MANIFEST_PATH, PDF_DIR, RESULTS_DIR } from './lib/paths.mjs';
import { readResult } from './lib/results.mjs';

process.env.AUDIVERIS_BIN = join(ACCURACY_DIR, 'lib', 'audiveris-docker.sh');

const { values } = parseArgs({
    options: {
        scores: { type: 'string' },
        variants: { type: 'string', default: 'cv,grid' },
    },
});
const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const only = values.scores ? new Set(values.scores.split(',')) : null;
const scores = manifest.scores.filter((s) => !only || only.has(s.id));
const variants = values.variants.split(',');

const { extractCvGeometry } = await import(join(DIST_DIR, 'experimental', 'geometry', 'cvGeometry.js'));
const { extractGridGeometry } = await import(join(DIST_DIR, 'experimental', 'geometry', 'gridGeometry.js'));

/** CheapGeometry → flat boxes in the shape compareGeometry expects. */
export const geometryBoxes = (geometry) => {
    const boxes = [];
    let sysIndex = 0;
    for (const sheet of geometry.sheets) {
        for (const system of sheet.systems) {
            for (const stack of system.stacks) {
                boxes.push({
                    page: sheet.pageIndex,
                    sys: sysIndex,
                    x0: stack.x0,
                    x1: stack.x1,
                    y0: system.y0,
                    y1: system.y1,
                });
            }
            sysIndex++;
        }
    }
    return boxes;
};

const referenceFor = async (score) => {
    const mpos = await loadReferenceBoxes(score);
    if (mpos) {
        return {
            boxes: mpos,
            source: 'musescore-mpos',
            systems: new Set(mpos.map((b) => `${b.page}:${b.y0.toFixed(3)}`)).size,
        };
    }
    const base = await readResult('audiveris-5.6.1', score.id);
    if (base?.ok) {
        // ScoreData bars are unrolled through repeats; the same printed bar can
        // appear several times, so dedupe to physical boxes.
        const seen = new Set();
        const boxes = base.boxes.filter((b) => {
            const key = `${b.page}:${b.sys}:${b.x0.toFixed(4)}:${b.x1.toFixed(4)}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
        return { boxes, source: 'audiveris-5.6.1', systems: base.systems.length };
    }
    return null;
};

const rows = [];
const work = join(RESULTS_DIR, 'work', 'geometry');
for (const score of scores) {
    const pdfPath = join(PDF_DIR, `${score.id}.pdf`);
    const ref = await referenceFor(score);
    for (const variant of variants) {
        const dir = join(work, `${variant}--${score.id}`);
        await rm(dir, { recursive: true, force: true });
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, '.image'), 'cleffy-omr:5.6.1');
        process.stdout.write(`[${score.id}] ${variant} ... `);
        try {
            const geometry =
                variant === 'cv' ? await extractCvGeometry(pdfPath, dir) : await extractGridGeometry(pdfPath, dir);
            const boxes = geometryBoxes(geometry);
            const systems = geometry.sheets.reduce((n, s) => n + s.systems.length, 0);
            const withCols =
                boxes.length === 0
                    ? 0
                    : geometry.sheets
                          .flatMap((s) => s.systems.flatMap((y) => y.stacks))
                          .filter((st) => st.columns.length > 0).length;
            const cmp = ref ? compareGeometry(boxes, ref.boxes) : null;
            rows.push({
                scoreId: score.id,
                kind: score.kind,
                pages: geometry.sheets.length,
                variant,
                ok: true,
                totalMs: geometry.timings.totalMs,
                renderMs: geometry.timings.renderMs,
                detectMs: geometry.timings.detectMs,
                systems,
                measures: boxes.length,
                measuresWithColumns: withCols,
                reference: ref ? { source: ref.source, systems: ref.systems, measures: ref.boxes.length } : null,
                geometry: cmp,
            });
            console.log(
                `${geometry.timings.totalMs} ms, ${systems} sys / ${boxes.length} bars` +
                    (cmp
                        ? ` | ref ${ref.systems} sys / ${ref.boxes.length} bars, recall ${cmp.recall} xIoU ${cmp.meanXIou}`
                        : ' | no reference'),
            );
        } catch (error) {
            rows.push({
                scoreId: score.id,
                kind: score.kind,
                variant,
                ok: false,
                error: String(error?.message ?? error),
            });
            console.log(`FAIL ${String(error?.message ?? error).slice(0, 160)}`);
        }
        await rm(dir, { recursive: true, force: true });
    }
}

await mkdir(RESULTS_DIR, { recursive: true });
await writeFile(join(RESULTS_DIR, 'geometry.json'), JSON.stringify(rows, null, 1));

const fmt = (x, d = 3) => (x === null || x === undefined ? '—' : typeof x === 'number' ? x.toFixed(d) : String(x));
const lines = [
    '# Track A — cheap geometry vs reference boxes',
    '',
    'Reference: MuseScore `.mpos` measure boxes for typeset scores; Audiveris 5.6.1 `.omr` for scans. `recall` = share of reference bars found on the right page/system with overlapping x; `xIoU` = mean 1-D IoU of found bars; `sys` = systems detected / reference.',
    '',
    '| score | kind | pages | variant | ms | sys | bars | ref bars | recall | precision | xIoU | ≥0.8 | bars w/ columns |',
    '|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|',
];
for (const r of rows) {
    if (!r.ok) {
        lines.push(`| ${r.scoreId} | ${r.kind} | | ${r.variant} | FAIL | | | | | | | | |`);
        continue;
    }
    lines.push(
        `| ${r.scoreId} | ${r.kind} | ${r.pages} | ${r.variant} | ${r.totalMs} | ${r.systems}/${r.reference?.systems ?? '—'} | ${r.measures} | ${r.reference?.measures ?? '—'} | ${fmt(r.geometry?.recall)} | ${fmt(r.geometry?.precision)} | ${fmt(r.geometry?.meanXIou)} | ${fmt(r.geometry?.shareXIouOver08)} | ${r.measuresWithColumns} |`,
    );
}
for (const variant of variants) {
    const ok = rows.filter((r) => r.ok && r.variant === variant && r.geometry);
    const mean = (f) => ok.reduce((a, r) => a + f(r), 0) / Math.max(1, ok.length);
    lines.push(
        '',
        `**${variant}**: ${ok.length} scores, mean recall ${fmt(mean((r) => r.geometry.recall))}, mean xIoU ${fmt(mean((r) => r.geometry.meanXIou))}, mean ms/page ${fmt(
            mean((r) => r.totalMs / r.pages),
            0,
        )}, systems exact ${ok.filter((r) => r.systems === r.reference.systems).length}/${ok.length}, bar count exact ${ok.filter((r) => r.measures === r.reference.measures).length}/${ok.length}`,
    );
}
await writeFile(join(RESULTS_DIR, 'geometry.md'), `${lines.join('\n')}\n`);
console.log('wrote results/geometry.md');
