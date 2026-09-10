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
    /** 1-based PDF pages skipped as staff-less (covers/blanks), not low-DPI music. */
    invalidSheets: number[];
    /** Process exit code; 0 on success. Non-zero is recoverable only for staff-less export refusal. */
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

const audiverisBin = (): string => process.env.AUDIVERIS_BIN ?? '/opt/audiveris/bin/Audiveris';

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
/** `Sheet original#1`, `Sheet #1`, or `Sheet Moonlight Sonata#1`. */
const INVALID_SHEET_RE = /Sheet\s+(?:[^#\n]*#)?(\d+)\s+flagged as invalid/gi;
/** SCALE/GRID said there were no staff lines — skippable covers/blanks. */
const STAFFLESS_RE =
    /does not seem to contain staff lines|Interline value is zero|No regularly spaced lines found|No significant black lines found/i;
/** Same `flagged as invalid` line is also used for muddy music (Audiveris#272). Fail closed. */
const LOW_DPI_RE = /picture resolution is too low/i;
const EXPORT_REFUSED_RE = /Could not export since transcription did not complete successfully/i;
const JVM_CRASH_RE =
    /NullPointerException|OutOfMemoryError|FileSystemAlreadyExistsException|Java heap space|Exception in thread|SIGSEGV|\bSIGKILL\b|\bKilled\b/i;
const LOG_TAIL_MAX = 8192;
const LOG_DECISION_MAX = 65_536;

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

/** 1-based sheet numbers mentioned as `#N` on a log line (`[original#1]`, `Sheet original#1`). */
const sheetNumbersIn = (text: string): number[] => {
    const found = new Set<number>();
    for (const match of text.matchAll(/#(\d+)/g)) {
        const sheet = Number.parseInt(match[1] ?? '0', 10);
        if (sheet >= 1) {
            found.add(sheet);
        }
    }
    return [...found];
};

/** Sheets Audiveris logged as `flagged as invalid` (covers, blanks, *or* low-DPI music). */
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
 * Invalid sheets we may drop: SCALE/GRID said there were no staff lines, and
 * the stub was not the low-DPI / irregular-interline music warning.
 */
export const parseSkippableInvalidSheets = (text: string): number[] => {
    const flagged = new Set(parseInvalidSheets(text));
    const staffless = new Set<number>();
    const lowDpi = new Set<number>();
    for (const line of text.split(/\r?\n/)) {
        const sheets = sheetNumbersIn(line);
        if (sheets.length === 0) {
            continue;
        }
        if (LOW_DPI_RE.test(line)) {
            for (const sheet of sheets) {
                lowDpi.add(sheet);
            }
        }
        if (STAFFLESS_RE.test(line)) {
            for (const sheet of sheets) {
                staffless.add(sheet);
            }
        }
    }
    return [...flagged].filter((sheet) => staffless.has(sheet) && !lowDpi.has(sheet)).sort((a, b) => a - b);
};

export const logShowsExportRefusal = (text: string): boolean => EXPORT_REFUSED_RE.test(text);

export const logShowsJvmCrash = (text: string, exitCode: number): boolean => {
    switch (exitCode) {
        case 134:
        case 137:
        case 139:
            return true;
        default:
            return JVM_CRASH_RE.test(text);
    }
};

/**
 * Non-zero exit is recoverable only when batch export refused the book because
 * of staff-less sheets — not because a later NPE/OOM happened after SCALE
 * flagged page 1, and not because a music page was too low-DPI.
 */
export const isRecoverableInvalidSheetFailure = (text: string, exitCode: number): boolean => {
    if (exitCode === 0 || logShowsJvmCrash(text, exitCode) || !logShowsExportRefusal(text)) {
        return false;
    }
    const flagged = parseInvalidSheets(text);
    const skippable = parseSkippableInvalidSheets(text);
    return skippable.length > 0 && flagged.every((sheet) => skippable.includes(sheet));
};

const unionSheetNumbers = (left: readonly number[], right: readonly number[]): number[] =>
    [...new Set([...left, ...right])].filter((n) => Number.isInteger(n) && n >= 1).sort((a, b) => a - b);

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
    const skippableSheetSet = new Set<number>();
    let logTail = '';
    let decisionLog = '';
    let lineCarry = '';
    let exitCode = 0;

    await new Promise<void>((resolve, reject) => {
        const child = spawn(audiverisBin(), argv, {
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

        const ingest = (text: string) => {
            for (const sheet of parseSkippableInvalidSheets(text)) {
                skippableSheetSet.add(sheet);
            }
        };

        let maxSheet = 0;
        const scan = (chunk: Buffer) => {
            const piece = chunk.toString('utf8');
            logTail = (logTail + piece).slice(-LOG_TAIL_MAX);
            decisionLog = (decisionLog + piece).slice(-LOG_DECISION_MAX);
            const text = lineCarry + piece;
            const lastNl = text.lastIndexOf('\n');
            if (lastNl === -1) {
                lineCarry = text;
                return;
            }
            ingest(text.slice(0, lastNl + 1));
            lineCarry = text.slice(lastNl + 1);
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
        // `close` (not `exit`): stdio has drained, so a flag that arrived after
        // the JVM died is still in `decisionLog` / `lineCarry`.
        child.on('close', (code, signal) => {
            exitCode = code ?? 1;
            if (lineCarry) {
                ingest(lineCarry);
                lineCarry = '';
            }
            ingest(logTail);
            ingest(decisionLog);
            if (code === 0) {
                finish(null);
                return;
            }
            killTree();
            if (isRecoverableInvalidSheetFailure(decisionLog, exitCode)) {
                finish(null);
                return;
            }
            if (!done) {
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
        // A crashed JVM can leave a truncated .mxl; never ship it as success.
        mxlPaths: exitCode === 0 ? outputs.mxlPaths : [],
        jvmStartToFirstSheetMs: firstSheetAt === null ? null : firstSheetAt - started,
        perSheetMs,
        stepCounts,
        stepDurationsMs,
        audiverisTotalMs: ended - started,
        invalidSheets: [...skippableSheetSet].sort((a, b) => a - b),
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
 * Leftover MusicXML from a non-zero exit is ignored — never stored as READY.
 */
export const runAudiverisTolerant = async (
    pdfPath: string,
    outDir: string,
    options: TolerantAudiverisOptions,
    run: AudiverisRunner = runAudiveris,
): Promise<AudiverisResult> => {
    const startedAt = Date.now();
    const killers: Array<() => void> = [];
    const killAll = () => {
        for (const kill of killers) {
            try {
                kill();
            } catch {
                // already exited
            }
        }
    };
    options.onSpawned?.(killAll);

    const remainingTimeoutMs = (): number => Math.max(1, options.timeoutMs - (Date.now() - startedAt));

    const runAttempt: AudiverisRunner = async (inputPath, attemptDir, attemptOptions) => {
        if (killers.length > 0) {
            try {
                killers[killers.length - 1]!();
            } catch {
                // previous process already gone
            }
        }
        return run(inputPath, attemptDir, {
            ...attemptOptions,
            timeoutMs: remainingTimeoutMs(),
            onSpawned: (kill) => {
                killers.push(kill);
            },
        });
    };

    const first = await runAttempt(pdfPath, outDir, options);
    if (first.exitCode === 0 && first.mxlPaths.length > 0) {
        return first;
    }
    if (first.exitCode !== 0 && first.mxlPaths.length > 0) {
        // Belt: runAudiveris already strips these; mocks may not.
        first.mxlPaths = [];
    }

    const requested = requestedSheetRanges(options);
    const validRanges = sheetRangesExcluding(requested, first.invalidSheets);
    if (first.exitCode !== 0 && first.invalidSheets.length === 0) {
        throw new JobError(ERROR_CODES.omrCrash, 'Audiveris exited non-zero with no staff-less sheets to skip');
    }
    if (first.invalidSheets.length === 0) {
        throw new JobError(ERROR_CODES.noStavesFound, 'Audiveris produced no MusicXML');
    }
    if (validRanges.length === 0) {
        throw new JobError(ERROR_CODES.noStavesFound, 'All sheets flagged invalid (no staves)');
    }

    const recovered = await recoverWithoutInvalidSheets(pdfPath, outDir, options, first, validRanges, runAttempt);
    return {
        ...recovered,
        invalidSheets: unionSheetNumbers(first.invalidSheets, recovered.invalidSheets),
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

const isRetryableRecoveryError = (err: unknown): boolean => {
    if (!(err instanceof JobError)) {
        return false;
    }
    switch (err.code) {
        case ERROR_CODES.omrCrash:
        case ERROR_CODES.omrTimeout:
            return true;
        case ERROR_CODES.downloadFailed:
        case ERROR_CODES.tooLarge:
        case ERROR_CODES.pageCountUnknown:
        case ERROR_CODES.noStavesFound:
        case ERROR_CODES.musicXmlParseFailed:
        case ERROR_CODES.queueFull:
        case ERROR_CODES.backlogFull:
        case ERROR_CODES.serviceUnreachable:
        case ERROR_CODES.workerLost:
        case ERROR_CODES.internal:
            return false;
        default: {
            const _exhaustive: never = err.code;
            return _exhaustive;
        }
    }
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
            if (reexport.exitCode === 0 && reexport.mxlPaths.length > 0) {
                return reexport;
            }
        } catch (err) {
            if (!isRetryableRecoveryError(err)) {
                throw err;
            }
        }
    }

    const retry = await run(pdfPath, join(outDir, 'retry'), retryOptions);
    if (retry.mxlPaths.length === 0) {
        throw new JobError(ERROR_CODES.noStavesFound, 'Audiveris produced no MusicXML after skipping invalid sheets');
    }
    if (retry.exitCode !== 0) {
        throw new JobError(ERROR_CODES.omrCrash, 'Audiveris produced MusicXML after a failed skip recovery');
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
