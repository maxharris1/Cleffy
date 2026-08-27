import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ERROR_CODES, JobError } from './errors.js';

export interface AudiverisResult {
    mxlPaths: string[];
    omrPath: string | null;
    /** Wall ms from process start to first sheet# sighting. */
    jvmStartToFirstSheetMs: number | null;
    /** Deltas between consecutive sheet# sightings (and final exit). */
    perSheetMs: number[];
    /** Counts of Audiveris step name sightings (LOAD, BINARY, GRID, TEXTS, …). */
    stepCounts: Record<string, number>;
    /** Elapsed ms attributed to each step (time since previous step sighting). */
    stepDurationsMs: Record<string, number>;
    audiverisTotalMs: number;
}

export interface AudiverisOptions {
    timeoutMs: number;
    /** 1-based inclusive sheet range (`-sheets N-M`). */
    sheets?: { from: number; to: number };
    /** Extra CLI args inserted before `--` (overrides/extends env). */
    extraArgs?: string[];
    /** Called with the highest sheet number seen in the log so far. */
    onSheetProgress?: (sheet: number) => void;
    /** Receives a killer for the JVM process group (lease loss / abandon). */
    onSpawned?: (kill: () => void) => void;
}

const AUDIVERIS_BIN = process.env.AUDIVERIS_BIN ?? '/opt/audiveris/bin/Audiveris';

/**
 * Play-along needs notes + measure geometry, not lyric OCR.
 * Cost-neutral: less TEXTS work → fewer CPU-seconds on the same instance shape.
 */
export const PLAY_ALONG_AUDIVERIS_OPTIONS = ['-option', 'Book.Lyrics=false'] as const;

const STEP_RE = /\b(LOAD|BINARY|GRID|HEADERS|STEMS|BEAMS|LEDGERS|HEADS|TEXTS|SYMBOLS|SLURS|CURVES|PAGES|REDUCTION|SHEET)\b/gi;
const SHEET_RE = /sheet#(\d+)/gi;

/** Split AUDIVERIS_EXTRA_OPTS on whitespace; supports simple double-quoted tokens. */
export const parseExtraOpts = (raw: string | undefined): string[] => {
    if (!raw || !raw.trim()) {
        return [];
    }
    const out: string[] = [];
    const re = /"([^"]*)"|(\S+)/g;
    for (const match of raw.matchAll(re)) {
        out.push(match[1] ?? match[2] ?? '');
    }
    return out.filter(Boolean);
};

/**
 * Build Audiveris argv (excluding the binary). Order: batch/export/output,
 * play-along defaults, env extra opts, call-site extra/sheets, then `--` + pdf.
 */
export const buildAudiverisArgs = (
    pdfPath: string,
    outDir: string,
    options: Pick<AudiverisOptions, 'sheets' | 'extraArgs'> = {},
): string[] => {
    const args: string[] = ['-batch', '-export', '-output', outDir, ...PLAY_ALONG_AUDIVERIS_OPTIONS];
    args.push(...parseExtraOpts(process.env.AUDIVERIS_EXTRA_OPTS));
    if (options.extraArgs?.length) {
        args.push(...options.extraArgs);
    }
    if (options.sheets) {
        const { from, to } = options.sheets;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
            throw new JobError(ERROR_CODES.internal, `Invalid sheets range ${from}-${to}`);
        }
        // One token: "N-M" (Audiveris rejects spaces around the hyphen).
        args.push('-sheets', from === to ? String(from) : `${from}-${to}`);
    }
    args.push('--', pdfPath);
    return args;
};

/**
 * Run Audiveris headless on a PDF: transcribe + export MusicXML (-export)
 * into outDir. Verified against 5.6.1: outputs land as <base>.mxl (or
 * <base>.mvtN.mxl per movement) and <base>.omr directly in the output folder.
 *
 * Do NOT pass `-save`. In batch, `-save` writes the .omr zip on every step;
 * reopening that zip during `-export` trips FileSystemAlreadyExistsException
 * and a sheet-reload NPE (exit 255 / omr_crash) on multi-page scores.
 * `-export` alone still writes the final .omr needed for measure geometry.
 */
export const runAudiveris = async (
    pdfPath: string,
    outDir: string,
    options: AudiverisOptions,
): Promise<AudiverisResult> => {
    const started = Date.now();
    let firstSheetAt: number | null = null;
    const sheetAts: number[] = [];
    const stepCounts: Record<string, number> = {};
    const stepDurationsMs: Record<string, number> = {};
    let lastStepAt = started;
    let lastStepName: string | null = null;

    const argv = buildAudiverisArgs(pdfPath, outDir, options);

    await new Promise<void>((resolve, reject) => {
        const child = spawn(AUDIVERIS_BIN, argv, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true, // own process group, so the timeout can kill the whole JVM tree
        });

        const killTree = () => {
            try {
                if (child.pid) {
                    process.kill(-child.pid, 'SIGKILL');
                }
            } catch {
                child.kill('SIGKILL');
            }
        };
        options.onSpawned?.(killTree);

        let done = false;
        const finish = (err: Error | null) => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        };

        const timer = setTimeout(() => {
            killTree();
            finish(new JobError(ERROR_CODES.omrTimeout, `Audiveris exceeded ${options.timeoutMs} ms`));
        }, options.timeoutMs);

        let maxSheet = 0;
        const scan = (chunk: Buffer) => {
            const text = chunk.toString('utf8');
            const now = Date.now();
            for (const match of text.matchAll(SHEET_RE)) {
                const sheet = Number.parseInt(match[1] ?? '0', 10);
                if (sheet > maxSheet) {
                    maxSheet = sheet;
                    if (firstSheetAt === null) {
                        firstSheetAt = now;
                    }
                    sheetAts.push(now);
                    options.onSheetProgress?.(sheet);
                }
            }
            for (const match of text.matchAll(STEP_RE)) {
                const step = (match[1] ?? '').toUpperCase();
                if (!step) {
                    continue;
                }
                stepCounts[step] = (stepCounts[step] ?? 0) + 1;
                if (lastStepName !== null) {
                    stepDurationsMs[lastStepName] = (stepDurationsMs[lastStepName] ?? 0) + (now - lastStepAt);
                }
                lastStepName = step;
                lastStepAt = now;
            }
        };
        child.stdout.on('data', scan);
        child.stderr.on('data', scan);

        child.on('error', (err) =>
            finish(new JobError(ERROR_CODES.omrCrash, `Could not start Audiveris: ${err.message}`)),
        );
        child.on('exit', (code, signal) => {
            if (code === 0) {
                finish(null);
            } else if (!done) {
                finish(new JobError(ERROR_CODES.omrCrash, `Audiveris exited with ${code ?? signal}`));
            }
        });
    });

    const ended = Date.now();
    if (lastStepName !== null) {
        stepDurationsMs[lastStepName] = (stepDurationsMs[lastStepName] ?? 0) + (ended - lastStepAt);
    }

    const perSheetMs: number[] = [];
    for (let i = 0; i < sheetAts.length; i++) {
        const prev = i === 0 ? started : sheetAts[i - 1]!;
        perSheetMs.push(sheetAts[i]! - prev);
    }

    const outputs = await discoverOutputs(outDir);
    return {
        ...outputs,
        jvmStartToFirstSheetMs: firstSheetAt === null ? null : firstSheetAt - started,
        perSheetMs,
        stepCounts,
        stepDurationsMs,
        audiverisTotalMs: ended - started,
    };
};

/** Find produced artifacts wherever Audiveris put them (layout differs across versions). */
export const discoverOutputs = async (
    outDir: string,
): Promise<{ mxlPaths: string[]; omrPath: string | null }> => {
    const mxlPaths: string[] = [];
    let omrPath: string | null = null;

    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 3) {
            return;
        }
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full, depth + 1);
            } else if (entry.name.toLowerCase().endsWith('.mxl')) {
                mxlPaths.push(full);
            } else if (entry.name.toLowerCase().endsWith('.omr')) {
                omrPath = omrPath ?? full;
            }
        }
    };
    await walk(outDir, 0);
    mxlPaths.sort();
    return { mxlPaths, omrPath };
};

/** Generous wall-clock budget: dense scans run ~30-60 s/page on small instances. */
export const timeoutForPages = (pageCount: number | null): number => {
    const pages = pageCount && pageCount > 0 ? pageCount : 20;
    return Math.min(30 * 60_000, 120_000 + pages * 60_000);
};
