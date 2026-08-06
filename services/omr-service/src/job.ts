import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { runAudiveris, timeoutForPages } from './audiveris.js';
import { buildScoreData } from './buildScoreData.js';
import { ERROR_CODES, JobError } from './errors.js';
import { parseMxlFiles } from './musicxml.js';
import { parseOmrGeometry } from './omrGeometry.js';
import type { Writeback } from './writeback.js';

export const ENGINE_VERSION = 'audiveris-5.6.1+svc-2';

/** Matches the Edge Function's guard and the scores bucket's 50 MB cap. */
const MAX_PDF_BYTES = 60 * 1024 * 1024;
export const MAX_PAGES = 60;

const HEARTBEAT_MIN_INTERVAL_MS = 10_000;

export interface JobRequest {
    documentId: string;
    pdfSignedUrl: string;
    pageCount: number | null;
}

/**
 * One analysis, start to finish: download the PDF (at job START, not enqueue
 * time — the signed URL must survive queue waits, downloads must not), run
 * Audiveris, parse both artifacts, write the result back.
 */
export const runJob = async (job: JobRequest, writeback: Writeback): Promise<void> => {
    if (job.pageCount === null || job.pageCount < 1) {
        await writeback.failed(job.documentId, ERROR_CODES.pageCountUnknown);
        return;
    }
    if (job.pageCount > MAX_PAGES) {
        await writeback.failed(job.documentId, ERROR_CODES.tooLarge);
        return;
    }

    const workDir = await mkdtemp(join(tmpdir(), `omr-${job.documentId.slice(0, 8)}-`));
    let lastBeat = 0;
    try {
        await writeback.processing(job.documentId, 0);

        const pdfPath = join(workDir, 'original.pdf');
        await downloadPdf(job.pdfSignedUrl, pdfPath);

        // Re-check page count from the bytes so an under-reported DB value
        // cannot stretch Audiveris beyond the shared-worker budget.
        const pdfBytes = await readFile(pdfPath);
        const observedPages = countPdfPagesHeuristic(pdfBytes);
        if (observedPages !== null && observedPages > MAX_PAGES) {
            await writeback.failed(job.documentId, ERROR_CODES.tooLarge);
            return;
        }

        const outDir = join(workDir, 'out');
        const { mxlPaths, omrPath } = await runAudiveris(pdfPath, outDir, {
            timeoutMs: timeoutForPages(Math.max(job.pageCount, observedPages ?? 0)),
            onSheetProgress: (sheet) => {
                const now = Date.now();
                if (now - lastBeat >= HEARTBEAT_MIN_INTERVAL_MS) {
                    lastBeat = now;
                    void writeback.processing(job.documentId, sheet).catch(() => undefined);
                }
            },
        });

        if (mxlPaths.length === 0) {
            throw new JobError(ERROR_CODES.noStavesFound, 'Audiveris produced no MusicXML');
        }

        const mxlBuffers = await Promise.all(mxlPaths.map((path) => readFile(path)));
        const musical = parseMxlFiles(mxlBuffers);
        const geometry = omrPath ? parseOmrGeometry(await readFile(omrPath)) : null;
        const score = buildScoreData(musical, geometry);

        await writeback.ready(job.documentId, score, ENGINE_VERSION);
        console.log(
            `[job] ${job.documentId}: ready — ${score.notes.length} notes, ${score.measures.length} measures, warnings: ${score.warnings.join(',') || 'none'}`,
        );
    } catch (err) {
        const code = err instanceof JobError ? err.code : ERROR_CODES.internal;
        console.warn(`[job] ${job.documentId}: failed (${code})`, err instanceof Error ? err.message : err);
        await writeback.failed(job.documentId, code).catch(() => undefined);
    } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
};

const downloadPdf = async (url: string, destination: string): Promise<void> => {
    let res: Response;
    try {
        res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' });
    } catch (err) {
        throw new JobError(ERROR_CODES.downloadFailed, err instanceof Error ? err.message : 'fetch failed');
    }
    if (!res.ok || !res.body) {
        throw new JobError(ERROR_CODES.downloadFailed, `HTTP ${res.status}`);
    }
    const length = Number.parseInt(res.headers.get('content-length') ?? '0', 10);
    if (Number.isFinite(length) && length > MAX_PDF_BYTES) {
        throw new JobError(ERROR_CODES.tooLarge, `PDF is ${length} bytes`);
    }
    let written = 0;
    const limiter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
            written += chunk.length;
            if (written > MAX_PDF_BYTES) {
                cb(new JobError(ERROR_CODES.tooLarge, `PDF exceeded ${MAX_PDF_BYTES} bytes`));
                return;
            }
            cb(null, chunk);
        },
    });
    try {
        await pipeline(Readable.fromWeb(res.body as WebReadableStream), limiter, createWriteStream(destination));
    } catch (err) {
        await rm(destination, { force: true }).catch(() => undefined);
        if (err instanceof JobError) {
            throw err;
        }
        // pipeline wraps the transform error; surface too_large when present.
        const cause = err instanceof Error ? err : null;
        if (cause?.message?.includes('exceeded') || cause?.message === ERROR_CODES.tooLarge) {
            throw new JobError(ERROR_CODES.tooLarge, cause.message);
        }
        throw new JobError(ERROR_CODES.downloadFailed, cause?.message ?? 'stream failed');
    }
};

/**
 * Cheap page-object count from PDF bytes. Not a full parser — used only to
 * reject clearly oversized scores when the DB page_count was under-reported.
 */
const countPdfPagesHeuristic = (bytes: Buffer): number | null => {
    const matches = bytes.toString('latin1').match(/\/Type\s*\/Page(?![sA-Za-z])/g);
    return matches && matches.length > 0 ? matches.length : null;
};
