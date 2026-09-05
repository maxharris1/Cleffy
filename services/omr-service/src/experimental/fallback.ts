import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runAudiveris } from '../audiveris.js';
import { type OmrSheet, parseOmrGeometry } from '../omrGeometry.js';

/**
 * Page-level Audiveris fallback: when the LLM's transcription of a page is
 * missing or rhythmically broken, transcribe just that page range with the
 * production engine (`-sheets N-M`) and take both its MusicXML and its .omr
 * geometry for those pages.
 */

export interface PageRange {
    /** 0-based inclusive. */
    from: number;
    to: number;
}

export interface FallbackRun extends PageRange {
    mxl: Buffer[];
    sheets: OmrSheet[];
    ms: number;
    error: string | null;
}

/** Collapse a sorted list of 0-based page indexes into contiguous ranges. */
export const toRanges = (pages: number[]): PageRange[] => {
    const sorted = [...new Set(pages)].sort((a, b) => a - b);
    const out: PageRange[] = [];
    for (const p of sorted) {
        const last = out[out.length - 1];
        if (last && p === last.to + 1) {
            last.to = p;
        } else {
            out.push({ from: p, to: p });
        }
    }
    return out;
};

export const runAudiverisFallback = async (
    pdfPath: string,
    workDir: string,
    ranges: PageRange[],
    options: { timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<FallbackRun[]> => {
    const runs: FallbackRun[] = [];
    for (const range of ranges) {
        const t0 = Date.now();
        const outDir = join(workDir, `fallback-${range.from + 1}-${range.to + 1}`);
        await mkdir(outDir, { recursive: true });
        try {
            const result = await runAudiveris(pdfPath, outDir, {
                timeoutMs: options.timeoutMs ?? 10 * 60_000,
                sheets: { from: range.from + 1, to: range.to + 1 },
            });
            const mxl = await Promise.all(result.mxlPaths.map((p) => readFile(p)));
            const geometry = result.omrPath ? parseOmrGeometry(await readFile(result.omrPath)) : null;
            const sheets = (geometry?.sheets ?? []).filter((s) => s.pageIndex >= range.from && s.pageIndex <= range.to);
            runs.push({
                ...range,
                mxl,
                sheets,
                ms: Date.now() - t0,
                error: mxl.length === 0 ? 'No MusicXML produced' : null,
            });
            options.log?.(
                `[fallback] pages ${range.from + 1}-${range.to + 1}: ${Date.now() - t0}ms, ${mxl.length} mxl, ${sheets.length} sheets`,
            );
        } catch (error) {
            runs.push({
                ...range,
                mxl: [],
                sheets: [],
                ms: Date.now() - t0,
                error: error instanceof Error ? error.message : String(error),
            });
            options.log?.(`[fallback] pages ${range.from + 1}-${range.to + 1} failed: ${String(error).slice(0, 200)}`);
        }
    }
    return runs;
};
