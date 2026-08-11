#!/usr/bin/env node
/**
 * Benchmark harness: run Audiveris on a PDF, emit timings CSV.
 * Decision-grade numbers require x86 (not Apple Silicon qemu).
 */
import { mkdir, appendFile, copyFile, access } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { values } = parseArgs({
    options: {
        pdf: { type: 'string' },
        out: { type: 'string', default: 'bench-results.csv' },
        label: { type: 'string', default: '' },
    },
});

const pdfArg = values.pdf;
if (!pdfArg) {
    console.error('Usage: node bench/run.mjs --pdf <path> [--out results.csv] [--label cpu4]');
    process.exit(1);
}

// Dynamic import after build, or from src via tsx — prefer dist for CI image.
const audiverisPath = join(ROOT, 'dist/audiveris.js');
try {
    await access(audiverisPath);
} catch {
    console.error('Build first: npm run build (need dist/audiveris.js)');
    process.exit(1);
}

const { runAudiveris, timeoutForPages } = await import(audiverisPath);

const work = await mkdtemp(join(tmpdir(), 'omr-bench-'));
const pdfPath = join(work, 'input.pdf');
const outDir = join(work, 'out');
await mkdir(outDir, { recursive: true });
await copyFile(pdfArg, pdfPath);

const t0 = Date.now();
try {
    const result = await runAudiveris(pdfPath, outDir, {
        timeoutMs: timeoutForPages(20),
        onSheetProgress: (n) => process.stderr.write(`sheet#${n}\n`),
    });
    const row = {
        label: values.label || '',
        pdf: pdfArg,
        wallMs: Date.now() - t0,
        audiverisTotalMs: result.audiverisTotalMs,
        jvmStartToFirstSheetMs: result.jvmStartToFirstSheetMs,
        perSheetMs: result.perSheetMs.join('|'),
        steps: JSON.stringify(result.stepCounts),
        mxlCount: result.mxlPaths.length,
        hasOmr: Boolean(result.omrPath),
        at: new Date().toISOString(),
    };
    console.log(JSON.stringify(row, null, 2));

    const header =
        'at,label,pdf,wallMs,audiverisTotalMs,jvmStartToFirstSheetMs,perSheetMs,steps,mxlCount,hasOmr\n';
    const line = [
        row.at,
        row.label,
        JSON.stringify(row.pdf),
        row.wallMs,
        row.audiverisTotalMs,
        row.jvmStartToFirstSheetMs ?? '',
        JSON.stringify(row.perSheetMs),
        JSON.stringify(row.steps),
        row.mxlCount,
        row.hasOmr,
    ].join(',');
    try {
        await access(values.out);
        await appendFile(values.out, line + '\n');
    } catch {
        await appendFile(values.out, header + line + '\n');
    }
    console.error('appended', values.out);
} finally {
    await rm(work, { recursive: true, force: true });
}
