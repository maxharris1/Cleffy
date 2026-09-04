import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { CheapGeometry } from '../geometry/types.js';
import { renderPdfPages } from '../render.js';
import { AnthropicTranscriber, type Effort } from './anthropic.js';
import type { LlmUsage } from './ledger.js';
import type { LlmPageTranscription } from './schema.js';

const run = promisify(execFile);

export type CropUnit = 'page' | 'system';

export interface TranscribeOptions {
    model?: string;
    effort?: Effort;
    /** `page`: one call per page. `system`: one call per system band (needs geometry). */
    unit?: CropUnit;
    /** Render DPI. Anthropic downsizes long edges past ~1568 px, so a full page gains nothing above 150. */
    dpi?: number;
    concurrency?: number;
    /** Only transcribe these 0-based pages (default all). */
    pages?: number[];
    geometry?: CheapGeometry | null;
    log?: (line: string) => void;
}

export interface PageTranscript {
    pageIndex: number;
    transcription: LlmPageTranscription | null;
    error: string | null;
    calls: number;
    cachedCalls: number;
    usage: LlmUsage;
    /** Sum of per-call latencies (calls run in parallel, so this exceeds wall time). */
    callMs: number;
}

export interface TranscribeResult {
    pages: PageTranscript[];
    usage: LlmUsage;
    calls: number;
    cachedCalls: number;
    renderMs: number;
    wallMs: number;
    model: string;
    unit: CropUnit;
}

const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 };

const addUsage = (a: LlmUsage, b: LlmUsage): LlmUsage => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    usd: a.usd + b.usd,
});

/** Last printed time/key signature in a transcription (for the next image's context). */
const trailingSignatures = (t: LlmPageTranscription, prev: { ts: string | null; key: number | null }) => {
    let { ts, key } = prev;
    for (const system of t.systems) {
        for (const m of system.measures) {
            if (m.ts) {
                ts = m.ts;
            }
            if (typeof m.key === 'number') {
                key = m.key;
            }
        }
    }
    return { ts, key };
};

interface Crop {
    pageIndex: number;
    /** Index within the page for `system` unit; 0 for `page`. */
    systemIndex: number;
    systemCount: number;
    path: string;
}

/**
 * Render a horizontal band of a page (page-normalized y0..y1, already padded)
 * with pdftoppm's crop flags.
 */
const renderBand = async (
    pdfPath: string,
    outDir: string,
    pageIndex: number,
    y0: number,
    y1: number,
    dpi: number,
    pageHeightPt: number,
    pageWidthPt: number,
    name: string,
): Promise<string> => {
    const heightPx = Math.round((pageHeightPt / 72) * dpi);
    const widthPx = Math.round((pageWidthPt / 72) * dpi);
    const top = Math.max(0, Math.floor(y0 * heightPx));
    const bottom = Math.min(heightPx, Math.ceil(y1 * heightPx));
    const prefix = join(outDir, name);
    await run(
        'pdftoppm',
        ['-r', String(dpi), '-png', '-gray', '-f', String(pageIndex + 1), '-l', String(pageIndex + 1), '-x', '0', '-y', String(top), '-W', String(widthPx), '-H', String(bottom - top), '-singlefile', pdfPath, prefix],
        { timeout: 120_000 },
    );
    return `${prefix}.png`;
};

const pageSizesPt = async (pdfPath: string): Promise<Array<{ w: number; h: number }>> => {
    const { stdout } = await run('pdfinfo', ['-f', '1', '-l', '10000', pdfPath]);
    const sizes: Array<{ w: number; h: number }> = [];
    for (const m of stdout.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/gm)) {
        sizes[Number(m[1]) - 1] = { w: Number(m[2]), h: Number(m[3]) };
    }
    return sizes;
};

/**
 * Track B driver. The first image is sent alone so its printed time/key
 * signature can seed the others, which then run `concurrency`-wide; a key
 * signature is printed at every system start anyway, and the prompt tells the
 * model the carried meter is only a hint.
 */
export const transcribePdf = async (
    client: AnthropicTranscriber,
    pdfPath: string,
    workDir: string,
    options: TranscribeOptions = {},
): Promise<TranscribeResult> => {
    const t0 = Date.now();
    const unit: CropUnit = options.unit ?? 'page';
    const dpi = options.dpi ?? (unit === 'system' ? 220 : 150);
    const concurrency = options.concurrency ?? 4;
    const log = options.log ?? (() => {});
    const model = options.model;

    const crops: Crop[] = [];
    let renderMs = 0;
    if (unit === 'page') {
        const r0 = Date.now();
        const outDir = join(workDir, 'llm-pages');
        await mkdir(outDir, { recursive: true });
        const rendered = await renderPdfPages(pdfPath, outDir, { dpi, gray: true });
        renderMs = Date.now() - r0;
        for (const page of rendered) {
            if (options.pages && !options.pages.includes(page.pageIndex)) {
                continue;
            }
            crops.push({ pageIndex: page.pageIndex, systemIndex: 0, systemCount: 1, path: page.path });
        }
    } else {
        if (!options.geometry) {
            throw new Error("unit 'system' needs geometry");
        }
        const r0 = Date.now();
        const outDir = join(workDir, 'llm-systems');
        await mkdir(outDir, { recursive: true });
        const sizes = await pageSizesPt(pdfPath);
        for (const sheet of options.geometry.sheets) {
            if (options.pages && !options.pages.includes(sheet.pageIndex)) {
                continue;
            }
            const size = sizes[sheet.pageIndex];
            if (!size) {
                continue;
            }
            for (const [s, system] of sheet.systems.entries()) {
                // Pad into the inter-system gap without reaching the neighbour's
                // staff, or the model reports the neighbour as a second system.
                const prev = sheet.systems[s - 1];
                const next = sheet.systems[s + 1];
                const padTop = Math.min(0.06, prev ? (system.y0 - prev.y1) * 0.45 : 0.06);
                const padBottom = Math.min(0.06, next ? (next.y0 - system.y1) * 0.45 : 0.06);
                const path = await renderBand(
                    pdfPath,
                    outDir,
                    sheet.pageIndex,
                    Math.max(0, system.y0 - padTop),
                    Math.min(1, system.y1 + padBottom),
                    dpi,
                    size.h,
                    size.w,
                    `p${sheet.pageIndex + 1}-s${s + 1}`,
                );
                crops.push({ pageIndex: sheet.pageIndex, systemIndex: s, systemCount: sheet.systems.length, path });
            }
        }
        renderMs = Date.now() - r0;
    }

    const pageCount = Math.max(0, ...crops.map((c) => c.pageIndex + 1));
    const label = (c: Crop) =>
        unit === 'page' ? `page ${c.pageIndex + 1} of ${pageCount}` : `system ${c.systemIndex + 1} of ${c.systemCount} on page ${c.pageIndex + 1} of ${pageCount}`;

    const results = new Map<Crop, Awaited<ReturnType<AnthropicTranscriber['transcribe']>> | Error>();
    let context = { ts: null as string | null, key: null as number | null };

    const callFor = async (crop: Crop, isStart: boolean) => {
        try {
            const imagePng = await readFile(crop.path);
            const res = await client.transcribe({
                imagePng,
                model,
                effort: options.effort,
                context: { label: label(crop), timeSignature: context.ts, keyFifths: context.key, isStart, singleSystem: unit === 'system' },
            });
            results.set(crop, res);
            return res;
        } catch (error) {
            results.set(crop, error instanceof Error ? error : new Error(String(error)));
            return null;
        }
    };

    const first = crops[0];
    if (first) {
        const res = await callFor(first, first.pageIndex === 0 && first.systemIndex === 0);
        if (res) {
            context = trailingSignatures(res.transcription, context);
        }
    }
    const rest = crops.slice(1);
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(concurrency, rest.length) }, async () => {
            while (next < rest.length) {
                const crop = rest[next++]!;
                await callFor(crop, false);
            }
        }),
    );

    const pages: PageTranscript[] = [];
    let usage = ZERO_USAGE;
    let calls = 0;
    let cachedCalls = 0;
    for (let p = 0; p < pageCount; p++) {
        const mine = crops.filter((c) => c.pageIndex === p);
        if (mine.length === 0) {
            continue;
        }
        const page: PageTranscript = { pageIndex: p, transcription: null, error: null, calls: 0, cachedCalls: 0, usage: ZERO_USAGE, callMs: 0 };
        const systems: LlmPageTranscription['systems'] = [];
        const errors: string[] = [];
        for (const crop of mine) {
            const r = results.get(crop);
            page.calls += 1;
            if (!r) {
                errors.push(`${label(crop)}: not attempted`);
                continue;
            }
            if (r instanceof Error) {
                errors.push(`${label(crop)}: ${r.message}`);
                const partial = (r as { usage?: LlmUsage | null }).usage;
                if (partial) {
                    page.usage = addUsage(page.usage, partial);
                }
                continue;
            }
            page.usage = addUsage(page.usage, r.usage);
            page.callMs += r.ms;
            if (r.cached) {
                page.cachedCalls += 1;
            }
            systems.push(...r.transcription.systems);
        }
        if (errors.length === 0) {
            page.transcription = { systems };
        } else {
            page.error = errors.join('; ');
            log(`[llm] page ${p + 1} failed: ${page.error.slice(0, 300)}`);
        }
        usage = addUsage(usage, page.usage);
        calls += page.calls;
        cachedCalls += page.cachedCalls;
        pages.push(page);
    }

    return {
        pages,
        usage,
        calls,
        cachedCalls,
        renderMs,
        wallMs: Date.now() - t0,
        model: model ?? (results.values().next().value as { model?: string } | undefined)?.model ?? 'unknown',
        unit,
    };
};
