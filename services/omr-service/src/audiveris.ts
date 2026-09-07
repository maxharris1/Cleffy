import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ERROR_CODES, JobError } from './errors.js';

/** 1-based inclusive Audiveris sheet range (`-sheets N-M`). */
export type SheetRange = { from: number; to: number };

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
    /** 1-based PDF pages Audiveris flagged as invalid (no staves). */
    invalidSheets: number[];
    /** Process exit code; 0 on success. Non-zero with invalidSheets is recoverable. */
    exitCode: number;
}

export interface AudiverisOptions {
    timeoutMs: number;
    /** 1-based inclusive sheet range(s) (`-sheets N-M` or `-sheets 2-4 6-8`). */
    sheets?: SheetRange | SheetRange[];
    /** Extra CLI args inserted before `--` (overrides/extends env). */
    extraArgs?: string[];
    /** Called with the highest sheet number seen in the log so far. */
    onSheetProgress?: (sheet: number) => void;
    /** Receives a killer for the JVM process group (lease loss / abandon). */
    onSpawned?: (kill: () => void) => void;
}

export type AudiverisRunner = (
    inputPath: string,
    outDir: string,
    options: AudiverisOptions,
) => Promise<AudiverisResult>;

const AUDIVERIS_BIN = process.env.AUDIVERIS_BIN ?? '/opt/audiveris/bin/Audiveris';

/**
 * Play-along defaults. Constant keys are `enclosingClass.field` as Audiveris
 * registers them (`org.audiveris.omr.sheet.ProcessingSwitches.lyrics`, not
 * the undocumented `Book.Lyrics`, which is a no-op). These apply to every
 * live job: unmarked tuplets are a known Audiveris drop (Schubert D.780 No.1,
 * Moonlight I), and fingering digits otherwise compete as tuplet signs.
 * `implicitTuplets` can invent 3:2 on beamed groups that are not printed
 * tuplets; that is accepted product risk, not a Moonlight-only experiment,
 * and the Moonlight pitch-recall report does not validate rhythm.
 */
const SWITCH = 'org.audiveris.omr.sheet.ProcessingSwitches';
export const PLAY_ALONG_AUDIVERIS_OPTIONS = [
    '-option',
    `${SWITCH}.lyrics=false`,
    '-option',
    `${SWITCH}.implicitTuplets=true`,
    '-option',
    `${SWITCH}.fingerings=true`,
] as const;

const STEP_RE = /\b(LOAD|BINARY|GRID|HEADERS|STEMS|BEAMS|LEDGERS|HEADS|TEXTS|SYMBOLS|SLURS|CURVES|PAGES|REDUCTION|SHEET)\b/gi;
const SHEET_RE = /sheet#(\d+)/gi;
const INVALID_SHEET_RE = /Sheet \S+#(\d+) flagged as invalid/gi;
const LOG_TAIL_MAX = 2048;

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
    const ranges = normalizeSheetRanges(options.sheets);
    if (ranges.length > 0) {
        // One `-sheets` then one token per range. Audiveris rejects spaces
        // around the hyphen inside a token (`2-4`, not `2 - 4`).
        args.push('-sheets', ...ranges.map(formatSheetRange));
    }
    args.push('--', pdfPath);
    return args;
};

export const normalizeSheetRanges = (sheets: AudiverisOptions['sheets']): SheetRange[] => {
    if (!sheets) {
        return [];
    }
    return (Array.isArray(sheets) ? sheets : [sheets]).map(assertSheetRange);
};

const assertSheetRange = (range: SheetRange): SheetRange => {
    const { from, to } = range;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
        throw new JobError(ERROR_CODES.internal, `Invalid sheets range ${from}-${to}`);
    }
    return range;
};

export const formatSheetRange = (range: SheetRange): string =>
    range.from === range.to ? String(range.from) : `${range.from}-${range.to}`;

/**
 * Drop excluded 1-based sheet numbers from one or more inclusive ranges,
 * splitting around holes (`1-8` minus `[1,5]` → `[{2,4},{6,8}]`).
 */
export const sheetRangesExcluding = (
    range: SheetRange | SheetRange[],
    exclude: readonly number[],
): SheetRange[] => {
    const skip = new Set(exclude.filter((n) => Number.isInteger(n) && n >= 1));
    const out: SheetRange[] = [];
    for (const { from, to } of normalizeSheetRanges(range)) {
        let start: number | null = null;
        for (let sheet = from; sheet <= to; sheet++) {
            if (skip.has(sheet)) {
                if (start !== null) {
                    out.push({ from: start, to: sheet - 1 });
                    start = null;
                }
            } else if (start === null) {
                start = sheet;
            }
        }
        if (start !== null) {
            out.push({ from: start, to });
        }
    }
    return out;
};

/** Sheets Audiveris flagged as having no regularly spaced staff lines. */
export const parseInvalidSheets = (text: string): number[] => {
    const found = new Set<number>();
    // Fresh regex: a shared /g lastIndex would skip matches on later chunks.
    const re = new RegExp(INVALID_SHEET_RE.source, INVALID_SHEET_RE.flags);
    for (const match of text.matchAll(re)) {
        const sheet = Number.parseInt(match[1] ?? '0', 10);
        if (sheet >= 1) {
            found.add(sheet);
        }
    }
    return [...found].sort((a, b) => a - b);
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
    const invalidSheetSet = new Set<number>();
    let logTail = '';
    let exitCode = 0;

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
            logTail = (logTail + text).slice(-LOG_TAIL_MAX);
            for (const sheet of parseInvalidSheets(text)) {
                invalidSheetSet.add(sheet);
            }
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
            exitCode = code ?? 1;
            if (code === 0) {
                finish(null);
            } else if (invalidSheetSet.size > 0) {
                // Staff-less pages make batch -export refuse the whole book.
                // Recovery (re-export / re-run minus those pages) is the caller's job.
                finish(null);
            } else if (!done) {
                const reason = `Audiveris exited with ${code ?? signal}`;
                finish(new JobError(ERROR_CODES.omrCrash, logTail ? `${reason}\n${logTail}` : reason));
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
        invalidSheets: [...invalidSheetSet].sort((a, b) => a - b),
        exitCode,
    };
};

export interface TolerantAudiverisOptions extends AudiverisOptions {
    /** Used when `sheets` is omitted: the requested 1-based range is `1..pageCount`. */
    pageCount: number;
}

/**
 * Run Audiveris, and if staff-less pages make batch export refuse the book,
 * recover: re-export the saved `.omr` without those sheets, else re-run the
 * PDF with `-sheets` excluding them. All-invalid books become `no_staves_found`.
 */
export const runAudiverisTolerant = async (
    pdfPath: string,
    outDir: string,
    options: TolerantAudiverisOptions,
    run: AudiverisRunner = runAudiveris,
): Promise<AudiverisResult> => {
    const first = await run(pdfPath, outDir, options);
    if (first.mxlPaths.length > 0) {
        return first;
    }

    const requested = requestedSheetRanges(options);
    const validRanges = sheetRangesExcluding(requested, first.invalidSheets);
    if (first.invalidSheets.length === 0) {
        throw new JobError(ERROR_CODES.noStavesFound, 'Audiveris produced no MusicXML');
    }
    if (validRanges.length === 0) {
        throw new JobError(ERROR_CODES.noStavesFound, 'All sheets flagged invalid (no staves)');
    }

    const recovered = await recoverWithoutInvalidSheets(pdfPath, outDir, options, first, validRanges, run);
    return {
        ...recovered,
        invalidSheets: first.invalidSheets,
        audiverisTotalMs: first.audiverisTotalMs + recovered.audiverisTotalMs,
    };
};

const requestedSheetRanges = (options: TolerantAudiverisOptions): SheetRange[] => {
    const explicit = normalizeSheetRanges(options.sheets);
    if (explicit.length > 0) {
        return explicit;
    }
    const pages = Number.isInteger(options.pageCount) && options.pageCount >= 1 ? options.pageCount : 1;
    return [{ from: 1, to: pages }];
};

const recoverWithoutInvalidSheets = async (
    pdfPath: string,
    outDir: string,
    options: TolerantAudiverisOptions,
    first: AudiverisResult,
    validRanges: SheetRange[],
    run: AudiverisRunner,
): Promise<AudiverisResult> => {
    const retryOptions: AudiverisOptions = { ...options, sheets: validRanges };
    if (first.omrPath) {
        try {
            const reexport = await run(first.omrPath, join(outDir, 'reexport'), retryOptions);
            if (reexport.mxlPaths.length > 0) {
                return reexport;
            }
        } catch (err) {
            if (!(err instanceof JobError && err.code === ERROR_CODES.omrCrash)) {
                throw err;
            }
        }
    }

    const retry = await run(pdfPath, join(outDir, 'retry'), retryOptions);
    if (retry.mxlPaths.length === 0) {
        throw new JobError(ERROR_CODES.omrCrash, 'Audiveris produced no MusicXML after skipping invalid sheets');
    }
    return retry;
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
