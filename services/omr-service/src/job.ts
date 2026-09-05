import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { runAudiveris, timeoutForPages } from './audiveris.js';
import { buildScoreData, type BuildScoreDataOptions } from './buildScoreData.js';
import { DEFAULT_ERA, eraForDocument, type Era } from './era.js';
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
import { mergeScoreDataParts, seamIsUnsafe, splitSheetRangesOverlapping } from './mergeScoreData.js';
import { expressionSeedAt, parseMxlFiles, type MusicalScore, type ParseSeed } from './musicxml.js';
import { parseOmrGeometry, type OmrGeometry } from './omrGeometry.js';
import { summarizeStructure, type StructureSummary } from './repeats.js';
import { emptyTimings, type JobTimings } from './timings.js';
import type { Writeback } from './writeback.js';
import type { ScoreData } from './scoreData.js';

/**
 * Bump svc-<n> when anything that changes the ScoreData a given PDF produces
 * changes: musicxml/omrGeometry/buildScoreData/repeats/mergeScoreData/caps/
 * scoreData/flags/tessdata. `scripts/check-engine-version.mjs` enforces it.
 *
 * Jumped 2 → 5 deliberately. Analyses in production report `svc-4`, a value that
 * has never existed in this repository's history — the deployed service was built
 * from code that is not on main. Numbering past it keeps svc-<n> monotonic against
 * what is actually deployed, which matters because staleness is judged by
 * comparing that integer: naming this svc-3 would make every production-analyzed
 * document look NEWER than the current engine and never offer to regenerate.
 *
 * svc-8 seeds the second shard of a split score with the first's tempo and
 * dynamics, so rit./a tempo/hairpins survive the page cut instead of resetting.
 * svc-9: ornaments, appoggiatura, tempo-relative graces, swing.
 * svc-10: engine upgrade 5.6.1 → 5.11.0.
 * svc-11: voices (ScoreData v5), per-voice dynamics, auto-pedal, rhythm repair, Baroque ornaments.
 */
export const ENGINE_VERSION = 'audiveris-5.11.0+svc-11';

/**
 * The `score_cache` key for one engine and one era. The era comes from the
 * document's title, not from the PDF, and it changes the output (how an
 * unmarked score is pedalled, how a Baroque trill is spelled), so two
 * documents that share a PDF under different titles need two entries. Only
 * the cache reads this: what is written to `engine_version` on the document
 * stays the bare ENGINE_VERSION, which the client parses for its generation.
 */
export const cacheKeyFor = (engineVersion: string, era: Era): string => `${engineVersion}#era=${era}`;

const MAX_PDF_BYTES = 60 * 1024 * 1024;
export const MAX_PAGES = 60;
/** Cost-neutral page parallel: 2 JVMs — only when the container can hold them. */
export const PARALLEL_SHEET_MIN_PAGES = 4;
const PARALLEL_SHEET_SHARDS = 2;
const PARALLEL_SHEET_OVERLAP = 1;
/**
 * Two concurrent -Xmx3g heaps + OpenCV/JavaCPP + Node + /tmp need more than 8Gi.
 * Cloud Run is 4Gi; typical Docker Desktop is ≤8Gi — both stay serial.
 */
export const PARALLEL_MIN_MEMORY_BYTES = 8 * 1024 * 1024 * 1024;
const CGROUP_V2_MEMORY_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_V1_MEMORY_LIMIT = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
/** cgroup v1 "unlimited" is a near-2^63 sentinel, not a real limit. */
const CGROUP_UNLIMITED_FLOOR = 1e15;

const HEARTBEAT_MIN_INTERVAL_MS = 10_000;
const LEASE_HEARTBEAT_MS = 60_000;
const COMPLETE_RETRIES = 2;

/** Parse a cgroup memory.max / memory.limit_in_bytes value. Null = unlimited/unknown. */
export const parseCgroupMemoryLimit = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === 'max' || trimmed === '-1') {
        return null;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0 || n >= CGROUP_UNLIMITED_FLOOR) {
        return null;
    }
    return Math.floor(n);
};

export const readContainerMemoryBytes = (): number | null => {
    for (const path of [CGROUP_V2_MEMORY_MAX, CGROUP_V1_MEMORY_LIMIT]) {
        try {
            const parsed = parseCgroupMemoryLimit(readFileSync(path, 'utf8'));
            if (parsed !== null) {
                return parsed;
            }
        } catch {
            // missing or unreadable
        }
    }
    const total = totalmem();
    return total > 0 ? total : null;
};

export const isParallelForcedOff = (raw: string | undefined): boolean => {
    const v = raw?.trim().toLowerCase();
    return v === '0' || v === 'false' || v === 'off';
};

/** Parallel only with enough pages and more than 8Gi of container RAM. */
export const shouldRunParallelShards = (
    pageCount: number,
    containerMemoryBytes: number | null,
    parallelEnv: string | undefined = process.env.OMR_PARALLEL,
): boolean =>
    pageCount >= PARALLEL_SHEET_MIN_PAGES &&
    !isParallelForcedOff(parallelEnv) &&
    containerMemoryBytes !== null &&
    containerMemoryBytes > PARALLEL_MIN_MEMORY_BYTES;

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
    /** The document's stylistic era, for auto-pedalling; the default when absent. */
    resolveEra?: () => Promise<Era>;
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
        resolveEra: () => eraForDocument(job.documentId),
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
            resolveEra: () => eraForDocument(job.document_id),
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
        // Resolved before the lookup: the era is part of the key, because the
        // same PDF under a Bach title and a Chopin title must not share pedalling.
        const era = adapters.resolveEra ? await adapters.resolveEra() : DEFAULT_ERA;
        const cacheKey = cacheKeyFor(ENGINE_VERSION, era);
        const cached = await cacheLookup(hash, cacheKey);
        if (cached) {
            timings.cacheHit = true;
            const ok = await adapters.onReady(cached.score, timings);
            logJob(adapters.documentId, timings, cached.score, ok);
            return ok;
        }

        if (adapters.isAbandoned?.()) {
            return false;
        }

        const score = await transcribe(
            pdfPath,
            workDir,
            timings,
            era,
            (sheet) => {
                const now = Date.now();
                if (now - lastBeat >= HEARTBEAT_MIN_INTERVAL_MS) {
                    lastBeat = now;
                    void adapters.onProcessing(sheet).catch(() => undefined);
                }
            },
            adapters.registerKill,
        );

        if (adapters.isAbandoned?.()) {
            return false;
        }

        await cacheStore(hash, cacheKey, score);
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
    era: Era,
    onSheet: (sheet: number) => void,
    registerKill?: (kill: KillJvm) => void,
): Promise<ScoreData> => {
    const pages = timings.pageCount ?? 0;
    const memoryBytes = readContainerMemoryBytes();
    if (shouldRunParallelShards(pages, memoryBytes)) {
        try {
            return await transcribeParallel(pdfPath, workDir, timings, era, onSheet, registerKill);
        } catch (err) {
            if (
                err instanceof JobError &&
                err.code === ERROR_CODES.omrCrash &&
                timings.parallelPath !== 'serial_fallback'
            ) {
                timings.parallelPath = 'serial_fallback';
                timings.parallelFallbackReasons = ['omr_crash'];
                return transcribeRange(
                    pdfPath,
                    join(workDir, 'out-serial'),
                    timings,
                    era,
                    onSheet,
                    registerKill,
                    undefined,
                );
            }
            throw err;
        }
    }
    if (pages >= PARALLEL_SHEET_MIN_PAGES) {
        timings.parallelPath = 'serial';
        timings.parallelFallbackReasons = ['insufficient_memory'];
    }
    return transcribeRange(pdfPath, join(workDir, 'out'), timings, era, onSheet, registerKill, undefined);
};

const transcribeParallel = async (
    pdfPath: string,
    workDir: string,
    timings: JobTimings,
    era: Era,
    onSheet: (sheet: number) => void,
    registerKill?: (kill: KillJvm) => void,
): Promise<ScoreData> => {
    const ranges = splitSheetRangesOverlapping(timings.pageCount ?? 0, PARALLEL_SHEET_SHARDS, PARALLEL_SHEET_OVERLAP);
    const kills: KillJvm[] = [];
    const killShards = () => {
        for (const kill of kills) {
            try {
                kill();
            } catch {
                // already exited
            }
        }
    };
    registerKill?.(killShards);

    const maxSheetByShard = ranges.map(() => 0);
    const report = () => {
        onSheet(Math.max(0, ...maxSheetByShard));
    };

    const started = Date.now();

    let artifacts: Array<{
        mxlBuffers: Buffer[];
        geometry: OmrGeometry | null;
        sheets: { from: number; to: number };
    }>;
    try {
        artifacts = await Promise.all(
            ranges.map(async (sheets, index) => {
                const outDir = join(workDir, `out-${sheets.from}-${sheets.to}`);
                const collected = await collectRangeArtifacts(
                    pdfPath,
                    outDir,
                    timings,
                    (sheet) => {
                        maxSheetByShard[index] = Math.max(maxSheetByShard[index]!, sheet);
                        report();
                    },
                    (kill) => {
                        kills.push(kill);
                    },
                    sheets,
                    /* aggregateTimings */ index === 0,
                );
                return { ...collected, sheets };
            }),
        );
    } catch (err) {
        killShards();
        throw err;
    }

    const tParse = Date.now();
    const first = artifacts[0];
    const second = artifacts[1];
    if (!first || !second) {
        throw new JobError(ERROR_CODES.internal, 'parallel transcribe: expected two shards');
    }
    // Shards are not auto-pedalled: a shard cannot tell a score that never
    // pedals from one whose marks sit on the other shard's pages. The merge
    // infers once, over the whole score, with the same era.
    const parsedA = parseRangeArtifacts(first.mxlBuffers, first.geometry, era, undefined, { autoPedal: false });
    const seed = expressionSeedAt(parsedA.musical, overlapPageStartTick(parsedA.score, parsedA.musical));
    const parsedB = parseRangeArtifacts(second.mxlBuffers, second.geometry, era, seed, { autoPedal: false });
    timings.parseMs = (timings.parseMs ?? 0) + (Date.now() - tParse);
    recordRhythmRepairs(timings, parsedA.musical, parsedB.musical);

    const parts = [
        {
            score: parsedA.score,
            sheets: first.sheets,
            openTiesAtEnd: parsedA.openTiesAtEnd,
            structure: parsedA.structure,
        },
        {
            score: parsedB.score,
            sheets: second.sheets,
            openTiesAtEnd: parsedB.openTiesAtEnd,
            structure: parsedB.structure,
        },
    ];

    const safety = seamIsUnsafe(parts);
    if (safety.unsafe) {
        timings.parallelPath = 'serial_fallback';
        timings.parallelFallbackReasons = safety.reasons;
        timings.audiverisTotalMs = Date.now() - started;
        return transcribeRange(pdfPath, join(workDir, 'out-serial'), timings, era, onSheet, registerKill, undefined);
    }

    timings.parallelPath = 'merged';
    timings.audiverisTotalMs = Date.now() - started;
    return mergeScoreDataParts(parts, { era });
};

const transcribeRange = async (
    pdfPath: string,
    outDir: string,
    timings: JobTimings,
    era: Era,
    onSheet: (sheet: number) => void,
    registerKill: ((kill: KillJvm) => void) | undefined,
    sheets: { from: number; to: number } | undefined,
    aggregateTimings = true,
): Promise<ScoreData> => {
    const { score } = await transcribeRangeDetailed(
        pdfPath,
        outDir,
        timings,
        era,
        onSheet,
        registerKill,
        sheets,
        aggregateTimings,
    );
    return score;
};

const transcribeRangeDetailed = async (
    pdfPath: string,
    outDir: string,
    timings: JobTimings,
    era: Era,
    onSheet: (sheet: number) => void,
    registerKill: ((kill: KillJvm) => void) | undefined,
    sheets: { from: number; to: number } | undefined,
    aggregateTimings = true,
): Promise<{ score: ScoreData; openTiesAtEnd: number; structure: StructureSummary }> => {
    const artifacts = await collectRangeArtifacts(
        pdfPath,
        outDir,
        timings,
        onSheet,
        registerKill,
        sheets,
        aggregateTimings,
    );
    const tParse = Date.now();
    const parsed = parseRangeArtifacts(artifacts.mxlBuffers, artifacts.geometry, era);
    if (aggregateTimings) {
        timings.parseMs = Date.now() - tParse;
    } else {
        timings.parseMs = (timings.parseMs ?? 0) + (Date.now() - tParse);
    }
    recordRhythmRepairs(timings, parsed.musical);
    // Summarized from the marks rather than the built score: buildScoreData has
    // already decided what this range alone can perform, and the merge needs to
    // know what reaches past it.
    return { score: parsed.score, openTiesAtEnd: parsed.openTiesAtEnd, structure: parsed.structure };
};

const collectRangeArtifacts = async (
    pdfPath: string,
    outDir: string,
    timings: JobTimings,
    onSheet: (sheet: number) => void,
    registerKill: ((kill: KillJvm) => void) | undefined,
    sheets: { from: number; to: number } | undefined,
    aggregateTimings: boolean,
): Promise<{ mxlBuffers: Buffer[]; geometry: OmrGeometry | null }> => {
    await mkdir(outDir, { recursive: true });
    const result = await runAudiveris(pdfPath, outDir, {
        timeoutMs: timeoutForPages(timings.pageCount ?? null),
        sheets,
        onSheetProgress: onSheet,
        onSpawned: registerKill,
    });
    if (aggregateTimings) {
        timings.jvmStartToFirstSheetMs = result.jvmStartToFirstSheetMs ?? undefined;
        timings.perSheetMs = result.perSheetMs;
        timings.audiverisTotalMs = result.audiverisTotalMs;
        timings.steps = result.stepDurationsMs;
        timings.stepCounts = result.stepCounts;
    }

    if (result.mxlPaths.length === 0) {
        throw new JobError(ERROR_CODES.noStavesFound, 'Audiveris produced no MusicXML');
    }

    const mxlBuffers = await Promise.all(result.mxlPaths.map((path) => readFile(path)));
    const geometry = result.omrPath ? parseOmrGeometry(await readFile(result.omrPath)) : null;
    return { mxlBuffers, geometry };
};

/** Telemetry only: how often the rhythm repair fires is how we learn whether to trust it. */
const recordRhythmRepairs = (timings: JobTimings, ...parsed: MusicalScore[]): void => {
    const count = parsed.reduce((acc, musical) => acc + (musical.rhythmRepairs ?? 0), 0);
    if (count > 0) {
        timings.rhythmRepairs = (timings.rhythmRepairs ?? 0) + count;
    }
};

const parseRangeArtifacts = (
    mxlBuffers: Buffer[],
    geometry: OmrGeometry | null,
    era: Era,
    seed?: ParseSeed,
    build: Omit<BuildScoreDataOptions, 'era'> = {},
): { score: ScoreData; musical: MusicalScore; openTiesAtEnd: number; structure: StructureSummary } => {
    const musical = parseMxlFiles(mxlBuffers, seed, { era });
    const score = buildScoreData(musical, geometry, { ...build, era });
    return {
        score,
        musical,
        openTiesAtEnd: musical.openTiesAtEnd,
        structure: summarizeStructure(musical.repeats),
    };
};

/** Tick where shard A's last (overlap) page begins, on the linear musical timeline. */
const overlapPageStartTick = (score: ScoreData, musical: MusicalScore): number => {
    const pages = score.measures.map((m) => m.page).filter((p) => p >= 0);
    if (pages.length === 0) {
        return musical.totalTicks;
    }
    const maxPage = Math.max(...pages);
    const first = score.measures.find((m) => m.page === maxPage);
    if (!first) {
        return musical.totalTicks;
    }
    const idx = first.srcIndex ?? score.measures.indexOf(first);
    return musical.measures[idx]?.tick ?? first.tick;
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
