import AdmZip from 'adm-zip';

import { buildScoreData } from '../buildScoreData.js';
import { type MusicalScore, parseMxlFiles } from '../musicxml.js';
import type { OmrGeometry, OmrSheet } from '../omrGeometry.js';
import type { ScoreData } from '../scoreData.js';
import { runAudiverisFallback, toRanges } from './fallback.js';
import { extractCvGeometry } from './geometry/cvGeometry.js';
import { extractGridGeometry } from './geometry/gridGeometry.js';
import type { CheapGeometry } from './geometry/types.js';
import type { AnthropicTranscriber, Effort } from './llm/anthropic.js';
import type { LlmUsage } from './llm/ledger.js';
import type { LlmPageTranscription } from './llm/schema.js';
import { type TranscriptionStats, toMusicXml } from './llm/toMusicXml.js';
import { type CropUnit, type TranscribeResult, transcribePdf } from './llm/transcribe.js';
import { type MergeReport, mergeGeometry } from './merge.js';

/**
 * Experimental pipeline: LLM notes (+ cheap geometry, + page-level Audiveris
 * fallback) → the same MusicalScore/ScoreData the production job produces.
 *
 *   llm-notes  Track B only. No geometry (ScoreData carries `no_geometry`).
 *   llm-geo    Track B + Track A merged; pages the LLM botched go to Audiveris.
 */

export type ExperimentalMode = 'llm-notes' | 'llm-geo';

export interface ExperimentalOptions {
    client: AnthropicTranscriber;
    mode: ExperimentalMode;
    geometryVariant?: 'cv' | 'grid';
    unit?: CropUnit;
    model?: string;
    effort?: Effort;
    concurrency?: number;
    /** Defaults to true in llm-geo mode; never in llm-notes. */
    fallback?: boolean;
    /** Share of a page's bars with a rhythm problem that sends the page to Audiveris. */
    fallbackBadBarShare?: number;
    audiverisTimeoutMs?: number;
    log?: (line: string) => void;
}

export interface ExperimentalTimings {
    geometryMs: number;
    llmRenderMs: number;
    llmWallMs: number;
    fallbackMs: number;
    parseMs: number;
    totalMs: number;
}

export interface ExperimentalResult {
    musical: MusicalScore;
    scoreData: ScoreData;
    geometry: OmrGeometry | null;
    cheapGeometry: CheapGeometry | null;
    timings: ExperimentalTimings;
    usage: LlmUsage;
    llm: {
        model: string;
        unit: CropUnit;
        calls: number;
        cachedCalls: number;
        pages: TranscriptionStats['pages'];
        failedPages: number[];
    };
    merge: MergeReport | null;
    fallbackPages: number[];
    fallbackErrors: string[];
    transcriptions: Array<LlmPageTranscription | null>;
    warnings: string[];
}

const toMxl = (xml: string): Buffer => {
    const zip = new AdmZip();
    zip.addFile(
        'META-INF/container.xml',
        Buffer.from(
            '<?xml version="1.0" encoding="UTF-8"?><container><rootfiles><rootfile full-path="score.xml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>',
        ),
    );
    zip.addFile('score.xml', Buffer.from(xml));
    return zip.toBuffer();
};

const lastSignatures = (pages: LlmPageTranscription[], start: { ts: string; key: number }) => {
    let { ts, key } = start;
    for (const page of pages) {
        for (const system of page.systems) {
            for (const m of system.measures) {
                if (m.ts) {
                    ts = m.ts;
                }
                if (typeof m.key === 'number') {
                    key = m.key;
                }
            }
        }
    }
    return { ts, key };
};

/** Pages whose transcription should not be trusted. */
export const pickFallbackPages = (
    llm: TranscribeResult,
    stats: TranscriptionStats,
    merge: MergeReport | null,
    badBarShare: number,
): number[] => {
    const pages = new Set<number>();
    for (const page of llm.pages) {
        if (!page.transcription) {
            pages.add(page.pageIndex);
        }
    }
    for (const page of stats.pages) {
        if (page.measures === 0 || page.bad / Math.max(1, page.measures) >= badBarShare) {
            pages.add(page.page);
        }
    }
    for (const page of merge?.pages ?? []) {
        // Bars and systems both disagree with the geometry: the transcript
        // most likely skipped or invented whole lines.
        if (page.mode === 'proportional' && Math.abs(page.llmBars - page.geoBars) > Math.max(2, 0.2 * page.geoBars)) {
            pages.add(page.page);
        }
    }
    return [...pages].sort((a, b) => a - b);
};

export const analyzeExperimental = async (
    pdfPath: string,
    workDir: string,
    options: ExperimentalOptions,
): Promise<ExperimentalResult> => {
    const t0 = Date.now();
    const log = options.log ?? (() => {});
    const unit: CropUnit = options.unit ?? 'page';
    const useGeometry = options.mode === 'llm-geo';
    // System crops need Track A even in llm-notes mode; the geometry is then used
    // only to cut the images, never merged into the ScoreData.
    const wantGeometry = useGeometry || unit === 'system';
    const fallbackEnabled = useGeometry && (options.fallback ?? true);
    const warnings: string[] = [];

    const geometryTask = async (): Promise<CheapGeometry | null> => {
        if (!wantGeometry) {
            return null;
        }
        const extract = options.geometryVariant === 'grid' ? extractGridGeometry : extractCvGeometry;
        try {
            return await extract(pdfPath, workDir);
        } catch (error) {
            warnings.push('geometry_failed');
            log(`[geometry] failed: ${String(error).slice(0, 200)}`);
            return null;
        }
    };

    let cheapGeometry: CheapGeometry | null;
    let llm: TranscribeResult;
    const llmOptions = { model: options.model, effort: options.effort, unit, concurrency: options.concurrency, log };
    if (unit === 'system') {
        cheapGeometry = await geometryTask();
        if (!cheapGeometry) {
            throw new Error('system crops need geometry, and geometry extraction failed');
        }
        llm = await transcribePdf(options.client, pdfPath, workDir, { ...llmOptions, geometry: cheapGeometry });
    } else {
        [cheapGeometry, llm] = await Promise.all([
            geometryTask(),
            transcribePdf(options.client, pdfPath, workDir, llmOptions),
        ]);
    }
    const geometryMs = cheapGeometry?.timings.totalMs ?? 0;
    const mergeable = useGeometry ? cheapGeometry : null;

    const pageCount = Math.max(llm.pages.length, ...llm.pages.map((p) => p.pageIndex + 1));
    const transcriptions: Array<LlmPageTranscription | null> = Array.from({ length: pageCount }, () => null);
    for (const page of llm.pages) {
        transcriptions[page.pageIndex] = page.transcription;
    }

    // Dry serialization for rhythm health; the real documents are built after
    // fallback pages are known.
    const { stats } = toMusicXml(transcriptions.map((t) => t ?? { systems: [] }));
    const preMerge = mergeable ? mergeGeometry(transcriptions, mergeable).report : null;
    const failedPages = llm.pages.filter((p) => !p.transcription).map((p) => p.pageIndex);
    const fallbackPages = fallbackEnabled
        ? pickFallbackPages(llm, stats, preMerge, options.fallbackBadBarShare ?? 0.34)
        : [];
    if (!fallbackEnabled) {
        for (const p of failedPages) {
            warnings.push(`page_${p + 1}_dropped`);
        }
    }

    const t1 = Date.now();
    const fallbackRuns =
        fallbackPages.length > 0
            ? await runAudiverisFallback(pdfPath, workDir, toRanges(fallbackPages), {
                  timeoutMs: options.audiverisTimeoutMs,
                  log,
              })
            : [];
    const fallbackMs = Date.now() - t1;
    const fallbackErrors = fallbackRuns
        .filter((r) => r.error)
        .map((r) => `pages ${r.from + 1}-${r.to + 1}: ${r.error}`);

    const t2 = Date.now();
    const fallbackSet = new Set(fallbackPages);
    const docs: Buffer[] = [];
    const sheets: OmrSheet[] = [];
    const llmPagesForMerge: Array<LlmPageTranscription | null> = transcriptions.map((t, p) =>
        fallbackSet.has(p) ? null : t,
    );
    const merge = mergeable ? mergeGeometry(llmPagesForMerge, mergeable) : null;
    let signatures = { ts: '4/4', key: 0 };
    let p = 0;
    while (p < pageCount) {
        if (fallbackSet.has(p)) {
            const run = fallbackRuns.find((r) => r.from === p);
            if (run) {
                if (run.mxl.length > 0) {
                    docs.push(...run.mxl);
                    sheets.push(...run.sheets);
                    for (let q = run.from; q <= run.to; q++) {
                        warnings.push(`page_${q + 1}_audiveris`);
                    }
                } else {
                    for (let q = run.from; q <= run.to; q++) {
                        warnings.push(`page_${q + 1}_dropped`);
                    }
                }
                p = run.to + 1;
            } else {
                p += 1;
            }
            continue;
        }
        const runPages: LlmPageTranscription[] = [];
        const start = p;
        while (p < pageCount && !fallbackSet.has(p)) {
            runPages.push(transcriptions[p] ?? { systems: [] });
            p += 1;
        }
        if (runPages.some((t) => t.systems.some((s) => s.measures.length > 0))) {
            const { xml } = toMusicXml(runPages, {
                defaultTimeSignature: signatures.ts,
                defaultKeyFifths: signatures.key,
            });
            docs.push(toMxl(xml));
            if (merge?.geometry) {
                sheets.push(...merge.geometry.sheets.filter((s) => s.pageIndex >= start && s.pageIndex < p));
            }
        }
        signatures = lastSignatures(runPages, signatures);
    }
    sheets.sort((a, b) => a.pageIndex - b.pageIndex);
    const geometry: OmrGeometry | null = mergeable ? { sheets } : null;

    const musical = parseMxlFiles(docs);
    const scoreData = buildScoreData(musical, geometry);
    const parseMs = Date.now() - t2;
    for (const w of [...(merge?.report.warnings ?? []), ...warnings]) {
        if (!scoreData.warnings.includes(w)) {
            scoreData.warnings.push(w);
        }
    }

    return {
        musical,
        scoreData,
        geometry,
        cheapGeometry,
        timings: {
            geometryMs,
            llmRenderMs: llm.renderMs,
            llmWallMs: llm.wallMs,
            fallbackMs,
            parseMs,
            totalMs: Date.now() - t0,
        },
        usage: llm.usage,
        llm: {
            model: llm.model,
            unit: llm.unit,
            calls: llm.calls,
            cachedCalls: llm.cachedCalls,
            pages: stats.pages,
            failedPages,
        },
        merge: merge?.report ?? null,
        fallbackPages,
        fallbackErrors,
        transcriptions,
        warnings: [...new Set([...warnings, ...(merge?.report.warnings ?? [])])],
    };
};
