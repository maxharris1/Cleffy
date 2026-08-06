import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { runAudiveris, timeoutForPages } from './audiveris.js';
import { buildScoreData } from './buildScoreData.js';
import { ERROR_CODES, JobError, type ErrorCode } from './errors.js';
import {
    cacheLookup,
    cacheStore,
    completeJob,
    failJob,
    heartbeatJob,
    mintSignedUrl,
    sha256Hex,
    stillOwnsJob,
    type OmJobRow,
} from './jobStore.js';
import { parseMxlFiles } from './musicxml.js';
import { parseOmrGeometry } from './omrGeometry.js';
import { emptyTimings, type JobTimings } from './timings.js';
import type { Writeback } from './writeback.js';
import type { ScoreData } from './scoreData.js';

/** Bump svc-<n> when musicxml/omrGeometry/buildScoreData/scoreData/flags/tessdata change. */
export const ENGINE_VERSION = 'audiveris-5.6.1+svc-2';

const MAX_PDF_BYTES = 60 * 1024 * 1024;
export const MAX_PAGES = 60;

const HEARTBEAT_MIN_INTERVAL_MS = 10_000;
const LEASE_HEARTBEAT_MS = 60_000;
const COMPLETE_RETRIES = 2;

export interface JobRequest {
    documentId: string;
    pdfSignedUrl: string;
    pageCount: number | null;
}

export type KillJvm = () => void;

interface PipelineAdapters {
    documentId: string;
    pageCount: number;
    resolvePdfUrl: () => Promise<string>;
    onProcessing: (progress: number) => Promise<void>;
    onReady: (score: ScoreData, timings: JobTimings) => Promise<boolean>;
    onFailed: (code: ErrorCode) => Promise<void>;
    registerKill?: (kill: KillJvm) => void;
    /** When true, abort without failing (lease lost). */
    isAbandoned?: () => boolean;
}

/**
 * Push-mode path (/jobs): thin adapter over the shared pipeline.
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

    await runPipeline({
        documentId: job.documentId,
        pageCount: job.pageCount,
        resolvePdfUrl: async () => job.pdfSignedUrl,
        onProcessing: (progress) => writeback.processing(job.documentId, progress),
        onReady: async (score, timings) => {
            await writeback.ready(job.documentId, score, ENGINE_VERSION, timings);
            return true;
        },
        onFailed: (code) => writeback.failed(job.documentId, code),
    });
};

/**
 * Pull-mode path (/poke): claim adapters + lease heartbeats over the shared pipeline.
 */
export const runClaimedJob = async (
    job: OmJobRow,
    workerId: string,
    writeback: Writeback,
): Promise<{ ok: boolean }> => {
    let killJvm: KillJvm | null = null;
    let abandoned = false;
    let heartbeatFails = 0;

    const leaseTimer = setInterval(() => {
        void (async () => {
            const ok = await heartbeatJob(job.id, workerId);
            if (ok) {
                heartbeatFails = 0;
                return;
            }
            heartbeatFails += 1;
            // Require two consecutive failures so a single PostgREST blip doesn't kill the JVM.
            if (heartbeatFails >= 2) {
                abandoned = true;
                killJvm?.();
            }
        })();
    }, LEASE_HEARTBEAT_MS);

    try {
        if (job.page_count < 1) {
            await failJob(job.id, workerId, ERROR_CODES.pageCountUnknown);
            return { ok: false };
        }
        if (job.page_count > MAX_PAGES) {
            await failJob(job.id, workerId, ERROR_CODES.tooLarge);
            return { ok: false };
        }

        const ok = await runPipeline({
            documentId: job.document_id,
            pageCount: job.page_count,
            resolvePdfUrl: async () => {
                const url = await mintSignedUrl(job.storage_path);
                if (!url) {
                    throw new JobError(ERROR_CODES.downloadFailed, 'Could not mint signed URL');
                }
                return url;
            },
            onProcessing: (progress) => writeback.processing(job.document_id, progress),
            onReady: async (score, timings) => completeWithRetry(job.id, workerId, score, timings),
            onFailed: async (code) => {
                await failJob(job.id, workerId, code);
            },
            registerKill: (kill) => {
                killJvm = kill;
            },
            isAbandoned: () => abandoned,
        });
        return { ok };
    } finally {
        clearInterval(leaseTimer);
    }
};

/** Shared download → cache → Audiveris → parse → complete/fail path. */
const runPipeline = async (adapters: PipelineAdapters): Promise<boolean> => {
    const timings = emptyTimings();
    const workDir = await mkdtemp(join(tmpdir(), `omr-${adapters.documentId.slice(0, 8)}-`));
    let lastBeat = 0;

    try {
        await adapters.onProcessing(0);

        const pdfPath = join(workDir, 'original.pdf');
        const t0 = Date.now();
        await downloadPdf(await adapters.resolvePdfUrl(), pdfPath);
        timings.downloadMs = Date.now() - t0;

        const pdfBytes = await readFile(pdfPath);
        timings.pdfBytes = pdfBytes.length;
        const observedPages = countPdfPagesHeuristic(pdfBytes);
        if (observedPages !== null && observedPages > MAX_PAGES) {
            await adapters.onFailed(ERROR_CODES.tooLarge);
            return false;
        }
        timings.pageCount = Math.max(adapters.pageCount, observedPages ?? 0);

        const hash = sha256Hex(pdfBytes);
        const cached = await cacheLookup(hash, ENGINE_VERSION);
        if (cached) {
            timings.cacheHit = true;
            const ok = await adapters.onReady(cached.score, timings);
            logJob(adapters.documentId, timings, cached.score, ok);
            return ok;
        }

        if (adapters.isAbandoned?.()) {
            return false;
        }

        const score = await transcribe(pdfPath, workDir, timings, (sheet) => {
            const now = Date.now();
            if (now - lastBeat >= HEARTBEAT_MIN_INTERVAL_MS) {
                lastBeat = now;
                void adapters.onProcessing(sheet).catch(() => undefined);
            }
        }, adapters.registerKill);

        if (adapters.isAbandoned?.()) {
            return false;
        }

        await cacheStore(hash, ENGINE_VERSION, score);
        const ok = await adapters.onReady(score, timings);
        logJob(adapters.documentId, timings, score, ok);
        return ok;
    } catch (err) {
        if (adapters.isAbandoned?.()) {
            return false;
        }
        const code: ErrorCode = err instanceof JobError ? err.code : ERROR_CODES.internal;
        console.warn(`[job] ${adapters.documentId}: failed (${code})`, err instanceof Error ? err.message : err);
        await adapters.onFailed(code).catch(() => undefined);
        return false;
    } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
};

const logJob = (documentId: string, timings: JobTimings, score: ScoreData, ok: boolean): void => {
    if (ok) {
        console.log(`[job] ${documentId}: ready — ${score.notes.length} notes`);
    }
    console.log(JSON.stringify({ event: 'omr_job', documentId, ok, ...timings }));
};

const completeWithRetry = async (
    jobId: number,
    workerId: string,
    score: ScoreData,
    timings: JobTimings,
): Promise<boolean> => {
    const tW = Date.now();
    for (let i = 0; i <= COMPLETE_RETRIES; i++) {
        const ok = await completeJob(jobId, workerId, score, ENGINE_VERSION, timings);
        if (ok) {
            timings.writebackMs = Date.now() - tW;
            return true;
        }
    }
    timings.writebackMs = Date.now() - tW;
    // Only fail if we still own the lease; otherwise reaper/other worker owns it.
    if (await stillOwnsJob(jobId, workerId)) {
        await failJob(jobId, workerId, ERROR_CODES.internal);
    }
    return false;
};

const transcribe = async (
    pdfPath: string,
    workDir: string,
    timings: JobTimings,
    onSheet: (sheet: number) => void,
    registerKill?: (kill: KillJvm) => void,
): Promise<ScoreData> => {
    const outDir = join(workDir, 'out');
    const result = await runAudiveris(pdfPath, outDir, {
        timeoutMs: timeoutForPages(timings.pageCount ?? null),
        onSheetProgress: onSheet,
        onSpawned: registerKill,
    });
    timings.jvmStartToFirstSheetMs = result.jvmStartToFirstSheetMs ?? undefined;
    timings.perSheetMs = result.perSheetMs;
    timings.audiverisTotalMs = result.audiverisTotalMs;
    timings.steps = result.stepCounts;

    if (result.mxlPaths.length === 0) {
        throw new JobError(ERROR_CODES.noStavesFound, 'Audiveris produced no MusicXML');
    }

    const tParse = Date.now();
    const mxlBuffers = await Promise.all(result.mxlPaths.map((path) => readFile(path)));
    const musical = parseMxlFiles(mxlBuffers);
    const geometry = result.omrPath ? parseOmrGeometry(await readFile(result.omrPath)) : null;
    const score = buildScoreData(musical, geometry);
    timings.parseMs = Date.now() - tParse;
    return score;
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
        const cause = err instanceof Error ? err : null;
        if (cause?.message?.includes('exceeded') || cause?.message === ERROR_CODES.tooLarge) {
            throw new JobError(ERROR_CODES.tooLarge, cause.message);
        }
        throw new JobError(ERROR_CODES.downloadFailed, cause?.message ?? 'stream failed');
    }
};

const countPdfPagesHeuristic = (bytes: Buffer): number | null => {
    const matches = bytes.toString('latin1').match(/\/Type\s*\/Page(?![sA-Za-z])/g);
    return matches && matches.length > 0 ? matches.length : null;
};
