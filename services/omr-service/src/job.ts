import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { runAudiverisTolerant, sheetRangesExcluding, timeoutForPages, type AudiverisResult } from './audiveris.js';
import { buildScoreData, type BuildScoreDataOptions } from './buildScoreData.js';
import { corpusOwnerUserId, isCorpusLookupEnabled } from './corpus/flag.js';
import { corpusGate } from './corpus/gate.js';
import {
    analysisSourceFromCorpus,
    corpusLookupByHash,
    corpusLookupByLayout,
    corpusPut,
    pdProvenance,
    type CorpusPutInput,
    type CorpusSource,
    type PdProvenance,
} from './corpus/store.js';
import { titleForDocument } from './documentTitle.js';
import { DEFAULT_ERA, eraForDocument, type Era } from './era.js';
import { ERROR_CODES, JobError, type ErrorCode } from './errors.js';
import {
    cacheLookup,
    cacheStore,
    completeJob,
    failJob,
    heartbeatJob,
    mintSignedUrl,
    releaseJob,
    sha256Hex,
    stillOwnsJob,
    type OmJobRow,
} from './jobStore.js';
import { mergeScoreDataParts, seamIsUnsafe, splitSheetRangesOverlapping } from './mergeScoreData.js';
import { expressionSeedAt, parseMxlFiles, type MusicalScore, type ParseSeed } from './musicxml.js';
import { parseOmrGeometry, type OmrGeometry } from './omrGeometry.js';
import { summarizeStructure, type StructureSummary } from './repeats.js';
import { isSymbolicFirstEnabled } from './symbolic/flag.js';
import { PIANO_MIDI_CREDIT, PIANO_MIDI_SOURCE_URL, isPianoMidiUrl } from './symbolic/pianoMidi.js';
import type { SymbolicAcceptResult, SymbolicLayoutKey } from './symbolic/jobResult.js';
import { defaultSymbolicDeps, trySymbolicJob, type TrySymbolicDeps } from './symbolic/tryJob.js';
import { emptyTimings, type JobTimings } from './timings.js';
import type { Writeback } from './writeback.js';
import type { ScoreData } from './scoreData.js';

/** Drain-only: accept Mutopia MIDI or park the job. Never start Audiveris. */
const isSymbolicOnly = (raw: string | undefined = process.env.CLEFFY_SYMBOLIC_ONLY): boolean => {
    const v = raw?.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes';
};

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
 * svc-12: auto-pedal only for wholly unmarked scores; per-voice dynamics survive a
 * mark-less shard B; era stamped on the analysis; wire version 3 so v3 readers
 * still parse the optional v5 fields.
 * svc-13: implicit tuplets / fingerings at the source; D.C./Fine and tempo OCR;
 * key-signature repair; ghost-part fill; per-system geometry zip.
 * svc-14: skip staff-less pages (covers, blank, front matter) instead of omr_crash.
 * svc-35: a near-blank scanned leaf is skipped like a cover instead of failing
 * the whole book export. Only PDFs that produced nothing under svc-34 change.
 * svc-34: raster-honest Audiveris patches 0001-0004 and 0007 (octave G clef,
 * ottava ink, tuplet bracket, ledger head, ledger-fragment dots). Parser
 * repairs from the RSI cycles land in the same stamp. Not svc-15..33: those
 * numbers were vector-hint images or mixed patch sets this product image omits.
 */
export const ENGINE_VERSION = 'audiveris-5.11.0+svc-35';

/**
 * The `score_cache` key for one engine and one era. The era comes from the
 * document's title, not from the PDF, and it changes the output (how an
 * unmarked score is pedalled, how a Baroque trill is spelled), so two
 * documents that share a PDF under different titles need two entries. Only
 * the cache reads this: what is written to `engine_version` on the document
 * stays the bare ENGINE_VERSION, which the client parses for its generation.
 * The resolved era is also stamped on ScoreData so a same-document title
 * edit can mark the row stale without a schema migration.
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
 * Typical Docker Desktop is ≤8Gi and stays serial; Cloud Run is deployed at 16Gi.
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
    /** IMSLP work-page title (documents.title for an IMSLP import); absent for uploads. */
    imslpPageTitle?: string;
}

export type KillJvm = () => void;

export interface PipelineAdapters {
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
    /**
     * Override CLEFFY_SYMBOLIC_FIRST. Unset reads the env (off in prod).
     * Tests pass this so env leakage cannot flip the cache-then-transcribe path.
     */
    symbolicEnabled?: boolean;
    imslpPageTitle?: string;
    symbolicDeps?: TrySymbolicDeps;
    /** Override CLEFFY_CORPUS_LOOKUP. Unset reads the env (off in prod). */
    corpusEnabled?: boolean;
    /** omr_jobs.created_by — a corpus-owner document is a seed run whose OMR result may be stored. */
    createdBy?: string | null;
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
        ...(job.imslpPageTitle !== undefined ? { imslpPageTitle: job.imslpPageTitle } : {}),
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

        const imslpPageTitle = await titleForDocument(job.document_id);
        const ok = await runPipeline({
            documentId: job.document_id,
            pageCount: job.page_count,
            createdBy: job.created_by,
            ...(imslpPageTitle !== null ? { imslpPageTitle } : {}),
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
                const prev = killJvm;
                killJvm = () => {
                    try {
                        prev?.();
                    } catch {
                        // previous process already gone
                    }
                    kill();
                };
            },
            isAbandoned: () => abandoned,
            resolveEra: () => eraForDocument(job.document_id),
        });
        if (!ok && isSymbolicOnly() && !abandoned) {
            const released = await releaseJob(job.id, workerId, 'symbolic_defer');
            console.log(
                JSON.stringify({
                    event: 'omr_job',
                    documentId: job.document_id,
                    jobId: job.id,
                    ok: false,
                    symbolicDefer: released,
                }),
            );
        }
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
        const corpusOn = adapters.corpusEnabled ?? isCorpusLookupEnabled();
        // The era is part of every key below (corpus and cache), because the
        // same PDF under a Bach title and a Chopin title must not share pedalling.
        // Resolved lazily so the flag-off path still reads it where it always did.
        let resolvedEra: Era | null = null;
        const resolveEra = async (): Promise<Era> => {
            resolvedEra ??= adapters.resolveEra ? await adapters.resolveEra() : DEFAULT_ERA;
            return resolvedEra;
        };
        const corpusTimed = async <T>(fn: () => Promise<T>): Promise<T> => {
            const t = Date.now();
            try {
                return await fn();
            } finally {
                timings.corpusLookupMs = (timings.corpusLookupMs ?? 0) + (Date.now() - t);
            }
        };

        // A corpus candidate is a public edition: an IMSLP import or a seed job.
        // Only those can be in `pd_pdf_store`, and only those carry a licence we
        // owe attribution for.
        const corpusOwner = corpusOwnerUserId();
        const isSeedJob = corpusOwner !== null && adapters.createdBy === corpusOwner;
        const isCorpusCandidate = adapters.imslpPageTitle !== undefined || isSeedJob;
        let provenance: PdProvenance | null | undefined;
        const resolveProvenance = async (): Promise<PdProvenance | null> => {
            if (provenance === undefined) {
                provenance = isCorpusCandidate ? await pdProvenance(hash) : null;
            }
            return provenance;
        };
        /**
         * Carry licence / credit / source onto what the player badges from. A
         * CC-BY / CC-BY-SA edition obliges us to attribute it wherever it is
         * served, so this happens even on the paths that would otherwise leave
         * `timings.source` unset (symbolic-first off).
         */
        const stampAttribution = async (): Promise<void> => {
            const pd = await resolveProvenance();
            if (pd === null) {
                return;
            }
            timings.source = {
                ...(timings.source ?? { tier: 'omr', band: 'reject', reason: 'no_candidate' }),
                licence: pd.licenceTag,
                ...(pd.editorCredit !== null ? { editorCredit: pd.editorCredit } : {}),
                ...(pd.sourceUrl !== null ? { sourceUrl: pd.sourceUrl } : {}),
            };
        };

        // Corpus by hash comes before symbolic and the OMR cache: the same PDF
        // bytes already analysed (Mutopia MIDI + alignment, or a seed OMR run)
        // cost one RPC and no JVM.
        if (corpusOn) {
            const hitEra = await resolveEra();
            const hit = await corpusTimed(() => corpusLookupByHash(hash, ENGINE_VERSION, hitEra));
            if (hit) {
                timings.corpusHit = 'hash';
                timings.source = analysisSourceFromCorpus(hit.source);
                if (hit.alignmentMap) {
                    timings.alignmentMap = hit.alignmentMap;
                }
                const ok = await adapters.onReady(hit.score, timings);
                logJob(adapters.documentId, timings, hit.score, ok);
                return ok;
            }
        }

        // OMR rows only join the corpus for public work: an IMSLP import (the
        // title is the work page) or a corpus-owner seed job. Never a user upload.
        let omrLayout: SymbolicLayoutKey | undefined;
        const corpusPutOmr = async (score: ScoreData, omrEra: Era): Promise<void> => {
            if (!corpusOn || !isCorpusCandidate) {
                return;
            }
            // A bulk mirror can hand us a file that is not the work it is filed
            // under. Withhold those from the corpus; the user still gets the score.
            const gate = corpusGate({ tier: 'omr', score });
            timings.corpusGate = gate;
            if (!gate.promoted) {
                console.warn(`[corpus] ${adapters.documentId}: not promoted (${gate.reason})`);
                return;
            }
            const pd = await resolveProvenance();
            const source: CorpusSource = {
                ...(timings.source ?? { tier: 'omr', band: 'reject', reason: 'no_candidate' }),
                origin: 'omr',
                ...(adapters.imslpPageTitle !== undefined ? { imslp_page_title: adapters.imslpPageTitle } : {}),
                ...corpusProvenanceKeys(pd),
            };
            await corpusPut({
                pdfSha256: hash,
                engineVersion: ENGINE_VERSION,
                era: omrEra,
                score,
                source,
                ...(omrLayout !== undefined ? { workKey: omrLayout.workKey, printedBars: omrLayout.printedBars } : {}),
                ...(timings.pageCount !== undefined ? { pageCount: timings.pageCount } : {}),
                symbolicSource: 'omr',
                ...(adapters.imslpPageTitle !== undefined ? { imslpPageTitle: adapters.imslpPageTitle } : {}),
                ...corpusPutProvenance(pd),
            });
        };

        const symbolicOn = adapters.symbolicEnabled ?? isSymbolicFirstEnabled();
        if (symbolicOn) {
            const baseDeps = adapters.symbolicDeps ?? defaultSymbolicDeps();
            const deps: TrySymbolicDeps =
                corpusOn && baseDeps.corpusLayout === undefined
                    ? {
                          ...baseDeps,
                          corpusLayout: (workKey, printedBars, pageCount) =>
                              corpusTimed(() => corpusLookupByLayout(ENGINE_VERSION, workKey, printedBars, pageCount)),
                      }
                    : baseDeps;
            const symbolic = await trySymbolicJob(
                pdfBytes,
                {
                    uploadId: adapters.documentId,
                    pageCount: timings.pageCount,
                    ...(adapters.imslpPageTitle !== undefined ? { imslpPageTitle: adapters.imslpPageTitle } : {}),
                },
                deps,
            );
            timings.source = symbolic.source;
            if (symbolic.kind === 'accept') {
                if (symbolic.alignmentMap) {
                    timings.alignmentMap = symbolic.alignmentMap;
                }
                if (symbolic.corpusHit !== undefined) {
                    timings.corpusHit = symbolic.corpusHit;
                }
                if (corpusOn) {
                    await corpusPutSymbolic(hash, symbolic, adapters.imslpPageTitle, await resolveProvenance());
                }
                await stampAttribution();
                const ok = await adapters.onReady(symbolic.score, timings);
                logJob(adapters.documentId, timings, symbolic.score, ok);
                return ok;
            }
            // Fallthrough keeps band/reason. Do not re-score after OMR.
            omrLayout = symbolic.layout;
            if (isSymbolicOnly()) {
                console.log(
                    JSON.stringify({
                        event: 'omr_job',
                        documentId: adapters.documentId,
                        ok: false,
                        symbolicDefer: true,
                        ...timings,
                    }),
                );
                return false;
            }
        }

        const era = await resolveEra();
        const cacheKey = cacheKeyFor(ENGINE_VERSION, era);
        const cached = await cacheLookup(hash, cacheKey);
        if (cached) {
            timings.cacheHit = true;
            await corpusPutOmr(cached.score, era);
            await stampAttribution();
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
        await corpusPutOmr(score, era);
        await stampAttribution();
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

/** Exported for job-level symbolic-first tests. */
export const runOmrPipeline = runPipeline;

/** Provenance keys on the stored `playalong_corpus.source` jsonb. */
const corpusProvenanceKeys = (
    pd: PdProvenance | null,
): Pick<CorpusSource, 'licence_tag' | 'editor_credit' | 'source_url' | 'us_pd'> =>
    pd === null
        ? {}
        : {
              licence_tag: pd.licenceTag,
              us_pd: pd.usPd,
              ...(pd.editorCredit !== null ? { editor_credit: pd.editorCredit } : {}),
              ...(pd.sourceUrl !== null ? { source_url: pd.sourceUrl } : {}),
          };

/** Provenance on the corpus row's own columns (not only inside `source`). */
const corpusPutProvenance = (
    pd: PdProvenance | null,
): Partial<Pick<CorpusPutInput, 'licenceTag' | 'editorCredit' | 'sourceUrl'>> =>
    pd === null
        ? {}
        : {
              licenceTag: pd.licenceTag,
              ...(pd.editorCredit !== null ? { editorCredit: pd.editorCredit } : {}),
              ...(pd.sourceUrl !== null ? { sourceUrl: pd.sourceUrl } : {}),
          };

/**
 * Organic corpus growth from a symbolic accept: Mutopia FTP MIDI/XML, or
 * piano-midi.de (Wayback) under CC-BY-SA. User XML and live IMSLP files stay out.
 */
const corpusPutSymbolic = async (
    pdfSha256: string,
    accept: SymbolicAcceptResult,
    imslpPageTitle: string | undefined,
    pd: PdProvenance | null,
): Promise<void> => {
    if (accept.candidate === null) {
        return;
    }
    const pianoMidi = isPianoMidiUrl(accept.candidate.url);
    if (accept.candidate.source !== 'mutopia' && !pianoMidi) {
        return;
    }
    const midiCredit = pianoMidi
        ? {
              licenceTag: 'CC-BY-SA' as const,
              editorCredit: PIANO_MIDI_CREDIT,
              sourceUrl: PIANO_MIDI_SOURCE_URL,
          }
        : corpusPutProvenance(pd);
    const source: CorpusSource = {
        ...accept.source,
        origin: pianoMidi ? 'ia' : 'mutopia',
        ...(imslpPageTitle !== undefined ? { imslp_page_title: imslpPageTitle } : {}),
        ...(pianoMidi
            ? {
                  licence_tag: 'CC-BY-SA' as const,
                  editor_credit: PIANO_MIDI_CREDIT,
                  source_url: PIANO_MIDI_SOURCE_URL,
              }
            : corpusProvenanceKeys(pd)),
    };
    if (pianoMidi) {
        source.licence = 'CC-BY-SA';
        source.editorCredit = PIANO_MIDI_CREDIT;
        source.sourceUrl = PIANO_MIDI_SOURCE_URL;
    }
    await corpusPut({
        pdfSha256,
        engineVersion: ENGINE_VERSION,
        era: '',
        score: accept.score,
        ...(accept.alignmentMap ? { alignmentMap: accept.alignmentMap } : {}),
        source,
        workKey: accept.layout.workKey,
        printedBars: accept.layout.printedBars,
        pageCount: accept.layout.pageCount,
        candidateSha256: accept.candidate.sha256,
        candidateUrl: accept.candidate.url,
        symbolicSource: pianoMidi ? 'ia' : 'mutopia',
        symbolicFormat: accept.candidate.format,
        ...(imslpPageTitle !== undefined ? { imslpPageTitle } : {}),
        ...midiCredit,
    });
};

const logJob = (documentId: string, timings: JobTimings, score: ScoreData, ok: boolean): void => {
    if (ok) {
        console.log(`[job] ${documentId}: ready — ${score.notes.length} notes`);
    }
    const { alignmentMap, ...rest } = timings;
    console.log(
        JSON.stringify({
            event: 'omr_job',
            documentId,
            ok,
            notes: score.notes.length,
            alignmentBars: alignmentMap?.printedBars ?? null,
            ...rest,
        }),
    );
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
        invalidSheets: number[];
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
                return { ...collected, sheets: collected.sheets ?? sheets };
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
    return recordInvalidSheets(
        timings,
        mergeScoreDataParts(parts, { era }),
        unionSheetNumbers(first.invalidSheets, second.invalidSheets),
    );
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
    const score = recordInvalidSheets(timings, parsed.score, artifacts.invalidSheets);
    if (aggregateTimings) {
        timings.parseMs = Date.now() - tParse;
    } else {
        timings.parseMs = (timings.parseMs ?? 0) + (Date.now() - tParse);
    }
    recordRhythmRepairs(timings, parsed.musical);
    // Summarized from the marks rather than the built score: buildScoreData has
    // already decided what this range alone can perform, and the merge needs to
    // know what reaches past it.
    return { score, openTiesAtEnd: parsed.openTiesAtEnd, structure: parsed.structure };
};

export const collectRangeArtifacts = async (
    pdfPath: string,
    outDir: string,
    timings: JobTimings,
    onSheet: (sheet: number) => void,
    registerKill: ((kill: KillJvm) => void) | undefined,
    sheets: { from: number; to: number } | undefined,
    aggregateTimings: boolean,
): Promise<{
    mxlBuffers: Buffer[];
    geometry: OmrGeometry | null;
    invalidSheets: number[];
    sheets: { from: number; to: number } | undefined;
}> => {
    await mkdir(outDir, { recursive: true });
    let result: AudiverisResult;
    try {
        result = await runAudiverisTolerant(pdfPath, outDir, {
            timeoutMs: timeoutForPages(timings.pageCount ?? null),
            pageCount: timings.pageCount ?? 0,
            sheets,
            onSheetProgress: onSheet,
            onSpawned: registerKill,
        });
    } catch (err) {
        // A shard whose requested range is all staff-less would otherwise throw
        // permanent no_staves_found for the job. Map it to omr_crash so
        // transcribe() can serial-fallback over the whole book.
        if (sheets && err instanceof JobError && err.code === ERROR_CODES.noStavesFound) {
            throw new JobError(ERROR_CODES.omrCrash, 'Shard range produced no staves; falling back to serial');
        }
        throw err;
    }
    if (aggregateTimings) {
        timings.jvmStartToFirstSheetMs = result.jvmStartToFirstSheetMs ?? undefined;
        timings.perSheetMs = result.perSheetMs;
        timings.audiverisTotalMs = result.audiverisTotalMs;
        timings.steps = result.stepDurationsMs;
        timings.stepCounts = result.stepCounts;
    }
    if (result.invalidSheets.length > 0) {
        timings.invalidSheets = unionSheetNumbers(timings.invalidSheets, result.invalidSheets);
    }

    if (result.mxlPaths.length === 0) {
        if (sheets) {
            throw new JobError(ERROR_CODES.omrCrash, 'Shard range produced no MusicXML; falling back to serial');
        }
        throw new JobError(ERROR_CODES.noStavesFound, 'Audiveris produced no MusicXML');
    }

    const remaining = sheets ? sheetRangesExcluding(sheets, result.invalidSheets) : [];
    const effectiveSheets =
        remaining.length > 0 ? { from: remaining[0]!.from, to: remaining[remaining.length - 1]!.to } : sheets;

    const mxlBuffers = await Promise.all(result.mxlPaths.map((path) => readFile(path)));
    const geometry = result.omrPath ? parseOmrGeometry(await readFile(result.omrPath)) : null;
    return { mxlBuffers, geometry, invalidSheets: result.invalidSheets, sheets: effectiveSheets };
};

export const unionSheetNumbers = (existing: readonly number[] | undefined, added: readonly number[]): number[] =>
    [...new Set([...(existing ?? []), ...added])].filter((n) => Number.isInteger(n) && n >= 1).sort((a, b) => a - b);

/** Record skipped staff-less pages on timings and the score warning list. */
export const recordInvalidSheets = (
    timings: JobTimings,
    score: ScoreData,
    invalidSheets: readonly number[],
): ScoreData => {
    if (invalidSheets.length === 0) {
        return score;
    }
    timings.invalidSheets = unionSheetNumbers(timings.invalidSheets, invalidSheets);
    if (score.warnings.includes('pages_skipped')) {
        return score;
    }
    return { ...score, warnings: [...score.warnings, 'pages_skipped'] };
};

/** Telemetry only: how often the rhythm repair fires is how we learn whether to trust it. */
const recordRhythmRepairs = (timings: JobTimings, ...parsed: MusicalScore[]): void => {
    const count = parsed.reduce((acc, musical) => acc + (musical.rhythmRepairs ?? 0), 0);
    if (count > 0) {
        timings.rhythmRepairs = (timings.rhythmRepairs ?? 0) + count;
    }
    const keys = parsed.reduce((acc, musical) => acc + (musical.keyRepairs ?? 0), 0);
    if (keys > 0) {
        timings.keyRepairs = (timings.keyRepairs ?? 0) + keys;
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
