import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ERROR_CODES, JobError } from './errors.js';
import {
    AUDIVERIS_LOG_REL,
    buildAudiverisArgs,
    isRecoverableInvalidSheetFailure,
    parseExtraOpts,
    parseFailedStubSheets,
    parseInvalidSheets,
    parseScoreSheetGroups,
    parseSkippableInvalidSheets,
    PLAY_ALONG_AUDIVERIS_OPTIONS,
    readNewestAudiverisLog,
    recoveryTimeoutMs,
    runAudiveris,
    runAudiverisTolerant,
    sheetRangesExcluding,
    timeoutForPages,
    type AudiverisResult,
    type AudiverisRunner,
} from './audiveris.js';

describe('parseExtraOpts', () => {
    it('splits on whitespace and keeps quoted tokens', () => {
        expect(parseExtraOpts(undefined)).toEqual([]);
        expect(parseExtraOpts('  ')).toEqual([]);
        expect(parseExtraOpts('-sheets 1-2')).toEqual(['-sheets', '1-2']);
        expect(parseExtraOpts('-option "Book.Lyrics=false"')).toEqual(['-option', 'Book.Lyrics=false']);
    });
});

describe('buildAudiverisArgs', () => {
    it('includes play-along defaults and sheets range as one token', () => {
        const prev = process.env.AUDIVERIS_EXTRA_OPTS;
        delete process.env.AUDIVERIS_EXTRA_OPTS;
        try {
            expect(buildAudiverisArgs('/in.pdf', '/out', { sheets: { from: 2, to: 5 } })).toEqual([
                '-batch',
                '-export',
                '-output',
                '/out',
                ...PLAY_ALONG_AUDIVERIS_OPTIONS,
                '-sheets',
                '2-5',
                '--',
                '/in.pdf',
            ]);
            expect(buildAudiverisArgs('/in.pdf', '/out', { sheets: { from: 3, to: 3 } })).toContain('3');
            expect(PLAY_ALONG_AUDIVERIS_OPTIONS).toEqual([
                '-option',
                'org.audiveris.omr.sheet.ProcessingSwitches.lyrics=false',
                '-option',
                'org.audiveris.omr.sheet.ProcessingSwitches.implicitTuplets=true',
                '-option',
                'org.audiveris.omr.sheet.ProcessingSwitches.fingerings=true',
            ]);
            expect(PLAY_ALONG_AUDIVERIS_OPTIONS.join(' ')).not.toMatch(/Book\.Lyrics/);
            expect(
                buildAudiverisArgs('/in.pdf', '/out', {
                    sheets: [
                        { from: 2, to: 4 },
                        { from: 6, to: 8 },
                    ],
                }),
            ).toEqual([
                '-batch',
                '-export',
                '-output',
                '/out',
                ...PLAY_ALONG_AUDIVERIS_OPTIONS,
                '-sheets',
                '2-4',
                '6-8',
                '--',
                '/in.pdf',
            ]);
        } finally {
            if (prev === undefined) {
                delete process.env.AUDIVERIS_EXTRA_OPTS;
            } else {
                process.env.AUDIVERIS_EXTRA_OPTS = prev;
            }
        }
    });

    it('appends AUDIVERIS_EXTRA_OPTS before call-site extras', () => {
        const prev = process.env.AUDIVERIS_EXTRA_OPTS;
        process.env.AUDIVERIS_EXTRA_OPTS = '-force';
        try {
            const args = buildAudiverisArgs('/in.pdf', '/out', { extraArgs: ['-transcribe'] });
            const forceAt = args.indexOf('-force');
            const transcribeAt = args.indexOf('-transcribe');
            expect(forceAt).toBeGreaterThan(-1);
            expect(transcribeAt).toBeGreaterThan(forceAt);
        } finally {
            if (prev === undefined) {
                delete process.env.AUDIVERIS_EXTRA_OPTS;
            } else {
                process.env.AUDIVERIS_EXTRA_OPTS = prev;
            }
        }
    });
});

describe('sheetRangesExcluding', () => {
    it('drops a leading page', () => {
        expect(sheetRangesExcluding({ from: 1, to: 8 }, [1])).toEqual([{ from: 2, to: 8 }]);
    });

    it('drops a trailing page', () => {
        expect(sheetRangesExcluding({ from: 1, to: 8 }, [8])).toEqual([{ from: 1, to: 7 }]);
    });

    it('splits around a middle page', () => {
        expect(sheetRangesExcluding({ from: 1, to: 8 }, [5])).toEqual([
            { from: 1, to: 4 },
            { from: 6, to: 8 },
        ]);
    });

    it('splits around several pages', () => {
        expect(sheetRangesExcluding({ from: 1, to: 8 }, [1, 5])).toEqual([
            { from: 2, to: 4 },
            { from: 6, to: 8 },
        ]);
    });

    it('returns empty when every sheet is excluded', () => {
        expect(sheetRangesExcluding({ from: 1, to: 3 }, [1, 2, 3])).toEqual([]);
    });

    it('walks each range of a multi-range input', () => {
        expect(
            sheetRangesExcluding(
                [
                    { from: 1, to: 3 },
                    { from: 5, to: 8 },
                ],
                [3, 5],
            ),
        ).toEqual([
            { from: 1, to: 2 },
            { from: 6, to: 8 },
        ]);
    });
});

describe('parseScoreSheetGroups', () => {
    it('reads contiguous PAGE sheet groups from the decision log', () => {
        const log =
            'Book reaching PAGE on sheets:[1, 2, 3, 4, 5, 6]\n' +
            'Book reaching PAGE on sheets:[7, 8, 9, 10]\n' +
            'Book reaching PAGE on sheets:[13, 14, 15, 16, 17]\n' +
            'Book reaching PAGE on sheets:[20]\n';
        expect(parseScoreSheetGroups(log)).toEqual([
            { from: 1, to: 6 },
            { from: 7, to: 10 },
            { from: 13, to: 17 },
            { from: 20, to: 20 },
        ]);
    });

    it('splits a non-contiguous listed group', () => {
        expect(parseScoreSheetGroups('Book reaching PAGE on sheets:[1, 2, 4, 5]')).toEqual([
            { from: 1, to: 2 },
            { from: 4, to: 5 },
        ]);
    });

    it('ignores GRID/LOAD sheet lists that are not PAGE', () => {
        expect(parseScoreSheetGroups('Book reaching GRID on sheets:[1, 2, 3]')).toEqual([]);
    });
});

describe('parseInvalidSheets', () => {
    it('reads the Audiveris "flagged as invalid" line', () => {
        const log =
            'INFO  [chopin-op10#1]                 SheetStub 1194 | Sheet chopin-op10#1 flagged as invalid.\n' +
            'WARN  [chopin-op10#1]                      Book 2044 | Error processing stub';
        expect(parseInvalidSheets(log)).toEqual([1]);
    });

    it('collects several pages in order', () => {
        const log = 'Sheet book#3 flagged as invalid.\nSheet book#1 flagged as invalid.\nSheet book#3 flagged as invalid.';
        expect(parseInvalidSheets(log)).toEqual([1, 3]);
    });

    it('matches a missing radix and a space in the sheet id', () => {
        expect(parseInvalidSheets('Sheet #1 flagged as invalid.')).toEqual([1]);
        expect(parseInvalidSheets('Sheet Moonlight Sonata#2 flagged as invalid.')).toEqual([2]);
    });
});

describe('parseSkippableInvalidSheets', () => {
    it('skips a cover when SCALE said there were no staff lines', () => {
        const log =
            'WARN  [original#1] ScaleBuilder | original#1 Interline value is zero. This sheet does not seem to contain staff lines.\n' +
            'INFO  [original#1] SheetStub | Sheet original#1 flagged as invalid.\n' +
            'INFO  [] Book | Could not export since transcription did not complete successfully\n';
        expect(parseSkippableInvalidSheets(log)).toEqual([1]);
        expect(isRecoverableInvalidSheetFailure(log, 1)).toBe(true);
    });

    it('does not skip a low-DPI music page (Audiveris#272)', () => {
        const log =
            'WARN  [original#2] SheetStub | original#2 With an interline value of 7 pixels, either this sheet contains no staves, or the picture resolution is too low (try 300 DPI).\n' +
            'INFO  [original#2] SheetStub | Sheet original#2 flagged as invalid.\n' +
            'INFO  [] Book | Could not export since transcription did not complete successfully\n';
        expect(parseInvalidSheets(log)).toEqual([2]);
        expect(parseSkippableInvalidSheets(log)).toEqual([]);
        expect(isRecoverableInvalidSheetFailure(log, 1)).toBe(false);
    });

    it('fails closed when a later NPE follows a cover flag', () => {
        const log =
            'WARN  [original#1] ScaleBuilder | This sheet does not seem to contain staff lines.\n' +
            'INFO  [original#1] SheetStub | Sheet original#1 flagged as invalid.\n' +
            'java.lang.NullPointerException\n' +
            'INFO  [] Book | Could not export since transcription did not complete successfully\n';
        expect(parseSkippableInvalidSheets(log)).toEqual([1]);
        expect(isRecoverableInvalidSheetFailure(log, 1)).toBe(false);
    });
});

describe('parseFailedStubSheets', () => {
    const tempestLog =
        'WARN  [original#11] Book 2044 | Error processing stub java.lang.RuntimeException: java.lang.IllegalArgumentException: Denominator is zero\n' +
        'java.util.concurrent.ExecutionException: java.lang.RuntimeException: java.lang.IllegalArgumentException: Denominator is zero\n' +
        '\tat org.audiveris.omr.sheet.SheetStub.doOneStep(SheetStub.java:519)\n' +
        'Caused by: java.lang.IllegalArgumentException: Denominator is zero\n' +
        'WARN  [original#12] Book 2044 | Error processing stub java.lang.NullPointerException: Cannot invoke "org.audiveris.omr.sheet.Staff.isTablature()" because "staff" is null\n' +
        'java.lang.NullPointerException: Cannot invoke "org.audiveris.omr.sheet.Staff.isTablature()" because "staff" is null\n' +
        '\tat org.audiveris.omr.sheet.curve.ArcRetriever.isStaffArc(ArcRetriever.java:286)\n' +
        'WARN  [original#18] Book 2044 | Error processing stub java.lang.RuntimeException: java.lang.IllegalArgumentException: Denominator is zero\n' +
        'WARN  [original#19] Book 2044 | Error processing stub java.lang.RuntimeException: java.lang.IllegalArgumentException: no such edge in graph: Exclusion\n' +
        'INFO  [original] Book 596 | Could not export since transcription did not complete successfully\n';

    it('reads Error processing stub sheet numbers from the bracket prefix', () => {
        expect(parseFailedStubSheets(tempestLog)).toEqual([11, 12, 18, 19]);
        expect(isRecoverableInvalidSheetFailure(tempestLog, 1)).toBe(true);
    });

    it('does not treat a per-stub NPE as an unscoped JVM crash', () => {
        const log =
            'WARN  [original#11] Book | Error processing stub java.lang.NullPointerException: staff is null\n' +
            'java.lang.NullPointerException: staff is null\n' +
            '\tat org.audiveris.omr.sheet.curve.ArcRetriever.isStaffArc\n' +
            'INFO  [] Book | Could not export since transcription did not complete successfully\n';
        expect(parseFailedStubSheets(log)).toEqual([11]);
        expect(isRecoverableInvalidSheetFailure(log, 1)).toBe(true);
    });
});

describe('recoveryTimeoutMs', () => {
    it('floors leftover budget at timeoutForPages of the remaining sheets', () => {
        expect(recoveryTimeoutMs(1, 16)).toBe(timeoutForPages(16));
        expect(recoveryTimeoutMs(timeoutForPages(16) + 5_000, 16)).toBe(timeoutForPages(16) + 5_000);
    });
});

describe('readNewestAudiverisLog', () => {
    it('returns empty when the cache dir is missing', () => {
        expect(readNewestAudiverisLog(join(tmpdir(), 'omr-no-av-home'))).toBe('');
    });
});

const emptyResult = (over: Partial<AudiverisResult> = {}): AudiverisResult => ({
    mxlPaths: [],
    omrPath: null,
    jvmStartToFirstSheetMs: null,
    perSheetMs: [],
    stepCounts: {},
    stepDurationsMs: {},
    audiverisTotalMs: 10,
    invalidSheets: [],
    failedStubSheets: [],
    exitCode: 1,
    scoreSheetGroups: [],
    ...over,
});

describe('runAudiverisTolerant', () => {
    const opts = { timeoutMs: 1_000, pageCount: 8 };

    it('returns a successful first run unchanged', async () => {
        const run = vi.fn<AudiverisRunner>(async () =>
            emptyResult({ mxlPaths: ['/out/a.mxl'], omrPath: '/out/a.omr', exitCode: 0, audiverisTotalMs: 5 }),
        );
        const result = await runAudiverisTolerant('/in.pdf', '/out', opts, run);
        expect(result.mxlPaths).toEqual(['/out/a.mxl']);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('re-exports the saved .omr without invalid sheets', async () => {
        const run = vi.fn<AudiverisRunner>(async (input, outDir) => {
            if (input.endsWith('.omr')) {
                expect(outDir).toBe('/out/reexport');
                return emptyResult({ mxlPaths: ['/out/reexport/a.mxl'], omrPath: input, exitCode: 0, audiverisTotalMs: 3 });
            }
            return emptyResult({ omrPath: '/out/book.omr', invalidSheets: [1], exitCode: 1, audiverisTotalMs: 20 });
        });
        const result = await runAudiverisTolerant('/in.pdf', '/out', opts, run);
        expect(result.mxlPaths).toEqual(['/out/reexport/a.mxl']);
        expect(result.invalidSheets).toEqual([1]);
        expect(result.audiverisTotalMs).toBe(23);
        expect(run).toHaveBeenCalledTimes(2);
        const reexportOpts = run.mock.calls[1]![2];
        expect(reexportOpts.sheets).toEqual([{ from: 2, to: 8 }]);
    });

    it('re-runs the PDF when re-export produces no MusicXML', async () => {
        const run = vi.fn<AudiverisRunner>(async (input, outDir) => {
            if (outDir.endsWith('/retry')) {
                return emptyResult({ mxlPaths: ['/out/retry/a.mxl'], exitCode: 0, audiverisTotalMs: 7 });
            }
            if (input.endsWith('.omr')) {
                return emptyResult({ exitCode: 1, audiverisTotalMs: 2 });
            }
            return emptyResult({ omrPath: '/out/book.omr', invalidSheets: [1], exitCode: 1, audiverisTotalMs: 20 });
        });
        const result = await runAudiverisTolerant('/in.pdf', '/out', opts, run);
        expect(result.mxlPaths).toEqual(['/out/retry/a.mxl']);
        expect(result.invalidSheets).toEqual([1]);
        expect(run).toHaveBeenCalledTimes(3);
    });

    it('skips re-export and re-runs the PDF when no .omr was saved', async () => {
        const run = vi.fn<AudiverisRunner>(async (_input, outDir) => {
            if (outDir.endsWith('/retry')) {
                return emptyResult({ mxlPaths: ['/out/retry/a.mxl'], exitCode: 0 });
            }
            return emptyResult({ invalidSheets: [1], exitCode: 1 });
        });
        const result = await runAudiverisTolerant('/in.pdf', '/out', opts, run);
        expect(result.mxlPaths).toEqual(['/out/retry/a.mxl']);
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[1]![0]).toBe('/in.pdf');
    });

    it('falls back to a PDF re-run when re-export throws omr_crash', async () => {
        const run = vi.fn<AudiverisRunner>(async (input, outDir) => {
            if (input.endsWith('.omr')) {
                throw new JobError(ERROR_CODES.omrCrash, 'export still refused');
            }
            if (outDir.endsWith('/retry')) {
                return emptyResult({ mxlPaths: ['/out/retry/a.mxl'], exitCode: 0 });
            }
            return emptyResult({ omrPath: '/out/book.omr', invalidSheets: [1], exitCode: 1 });
        });
        const result = await runAudiverisTolerant('/in.pdf', '/out', opts, run);
        expect(result.mxlPaths).toEqual(['/out/retry/a.mxl']);
    });

    it('throws no_staves_found when every requested sheet is invalid', async () => {
        const run = vi.fn<AudiverisRunner>(async () =>
            emptyResult({ invalidSheets: [1, 2, 3], exitCode: 1 }),
        );
        await expect(runAudiverisTolerant('/in.pdf', '/out', { timeoutMs: 1, pageCount: 3 }, run)).rejects.toMatchObject({
            code: ERROR_CODES.noStavesFound,
        });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('does not treat leftover MusicXML from a non-zero exit as success', async () => {
        const run = vi.fn<AudiverisRunner>(async (input, outDir) => {
            if (input.endsWith('.omr') || outDir.endsWith('/retry') || outDir.endsWith('/reexport')) {
                return emptyResult({ mxlPaths: ['/out/retry/a.mxl'], exitCode: 0, audiverisTotalMs: 3 });
            }
            return emptyResult({
                mxlPaths: ['/out/leftover.mxl'],
                omrPath: '/out/book.omr',
                invalidSheets: [1],
                exitCode: 1,
                audiverisTotalMs: 20,
            });
        });
        const result = await runAudiverisTolerant('/in.pdf', '/out', opts, run);
        expect(result.mxlPaths).not.toContain('/out/leftover.mxl');
        expect(result.mxlPaths).toEqual(['/out/retry/a.mxl']);
    });

    it('treats leftover MusicXML plus a non-zero exit and no skippable sheets as a crash', async () => {
        const run = vi.fn<AudiverisRunner>(async () =>
            emptyResult({ mxlPaths: ['/out/leftover.mxl'], invalidSheets: [], exitCode: 1 }),
        );
        await expect(runAudiverisTolerant('/in.pdf', '/out', opts, run)).rejects.toMatchObject({
            code: ERROR_CODES.omrCrash,
        });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('unions invalid sheets from recovery and uses no_staves_found when the rest is empty', async () => {
        const run = vi.fn<AudiverisRunner>(async (input, outDir) => {
            if (outDir.endsWith('/retry')) {
                return emptyResult({ invalidSheets: [8], exitCode: 0, mxlPaths: [] });
            }
            if (input.endsWith('.omr')) {
                throw new JobError(ERROR_CODES.omrCrash, 'reexport refused');
            }
            return emptyResult({ omrPath: '/out/book.omr', invalidSheets: [1], exitCode: 1 });
        });
        await expect(runAudiverisTolerant('/in.pdf', '/out', opts, run)).rejects.toMatchObject({
            code: ERROR_CODES.noStavesFound,
        });
        expect(run).toHaveBeenCalledTimes(3);
    });

    it('falls through to a PDF re-run when re-export times out', async () => {
        const run = vi.fn<AudiverisRunner>(async (input, outDir) => {
            if (input.endsWith('.omr')) {
                throw new JobError(ERROR_CODES.omrTimeout, 'reexport hung');
            }
            if (outDir.endsWith('/retry')) {
                return emptyResult({ mxlPaths: ['/out/retry/a.mxl'], exitCode: 0, invalidSheets: [4] });
            }
            return emptyResult({ omrPath: '/out/book.omr', invalidSheets: [1], exitCode: 1 });
        });
        const result = await runAudiverisTolerant('/in.pdf', '/out', opts, run);
        expect(result.mxlPaths).toEqual(['/out/retry/a.mxl']);
        expect(result.invalidSheets).toEqual([1, 4]);
    });

    it('kills the previous JVM before a recovery spawn and floors the timeout', async () => {
        const killed: string[] = [];
        const timeouts: number[] = [];
        const run = vi.fn<AudiverisRunner>(async (input, _outDir, options) => {
            timeouts.push(options.timeoutMs);
            options.onSpawned?.(() => killed.push(input));
            if (input.endsWith('.omr')) {
                return emptyResult({ mxlPaths: ['/out/reexport/a.mxl'], exitCode: 0, audiverisTotalMs: 3 });
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
            return emptyResult({ omrPath: '/out/book.omr', invalidSheets: [1], exitCode: 1, audiverisTotalMs: 20 });
        });
        const result = await runAudiverisTolerant('/in.pdf', '/out', { timeoutMs: 5_000, pageCount: 8 }, run);
        expect(result.mxlPaths).toEqual(['/out/reexport/a.mxl']);
        expect(killed).toEqual(['/in.pdf']);
        expect(timeouts[0]).toBeGreaterThanOrEqual(4_900);
        expect(timeouts[1]).toBeGreaterThanOrEqual(timeoutForPages(7));
    });

    it('re-exports the saved .omr with -sheets excluding failed stubs', async () => {
        const remaining = [
            { from: 1, to: 10 },
            { from: 13, to: 17 },
            { from: 20, to: 20 },
        ];
        const run = vi.fn<AudiverisRunner>(async (input, outDir, options) => {
            if (input.endsWith('.omr')) {
                expect(outDir).toBe('/out/reexport');
                expect(options.sheets).toEqual(remaining);
                return emptyResult({ mxlPaths: ['/out/reexport/a.mxl'], omrPath: input, exitCode: 0 });
            }
            return emptyResult({
                omrPath: '/out/book.omr',
                invalidSheets: [11, 12, 18, 19],
                failedStubSheets: [11, 12, 18, 19],
                exitCode: 1,
            });
        });
        const result = await runAudiverisTolerant('/in.pdf', '/out', { timeoutMs: 1_000, pageCount: 20 }, run);
        expect(result.mxlPaths).toEqual(['/out/reexport/a.mxl']);
        expect(result.invalidSheets).toEqual([11, 12, 18, 19]);
        expect(run).toHaveBeenCalledTimes(2);
        expect(run.mock.calls[0]![0]).toBe('/in.pdf');
        expect(run.mock.calls[1]![0]).toBe('/out/book.omr');
        expect(run.mock.calls[1]![2].sheets).toEqual(remaining);
        expect(run.mock.calls[1]![2].timeoutMs).toBeGreaterThanOrEqual(timeoutForPages(16));
    });

    it('falls back to a PDF -sheets re-run when stub .omr re-export still refuses', async () => {
        const remaining = [
            { from: 1, to: 10 },
            { from: 13, to: 17 },
            { from: 20, to: 20 },
        ];
        const run = vi.fn<AudiverisRunner>(async (input, outDir, options) => {
            if (input.endsWith('.omr')) {
                expect(options.sheets).toEqual(remaining);
                return emptyResult({ exitCode: 1 });
            }
            if (outDir.endsWith('/retry')) {
                expect(options.sheets).toEqual(remaining);
                return emptyResult({ mxlPaths: ['/out/retry/a.mxl'], exitCode: 0 });
            }
            return emptyResult({
                omrPath: '/out/book.omr',
                invalidSheets: [11, 12, 18, 19],
                failedStubSheets: [11, 12, 18, 19],
                exitCode: 1,
            });
        });
        const result = await runAudiverisTolerant('/in.pdf', '/out', { timeoutMs: 1_000, pageCount: 20 }, run);
        expect(result.mxlPaths).toEqual(['/out/retry/a.mxl']);
        expect(result.invalidSheets).toEqual([11, 12, 18, 19]);
        expect(run).toHaveBeenCalledTimes(3);
        expect(run.mock.calls[0]![0]).toBe('/in.pdf');
        expect(run.mock.calls[1]![0]).toBe('/out/book.omr');
        expect(run.mock.calls[2]![0]).toBe('/in.pdf');
        expect(run.mock.calls[2]![1]).toBe('/out/retry');
        expect(run.mock.calls[2]![2].timeoutMs).toBeGreaterThanOrEqual(timeoutForPages(16));
    });
});

const FAKE_AUDIVERIS = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const mode = process.env.FAKE_AUDIVERIS_MODE || '';
const outputAt = process.argv.indexOf('-output');
const outDir = outputAt >= 0 ? process.argv[outputAt + 1] : '.';
if (mode === 'crash-flag-mxl') {
    process.stderr.write('Sheet original#1 flagged as invalid.\\njava.lang.NullPointerException\\n');
    writeFileSync(join(outDir, 'leftover.mxl'), 'truncated');
    process.exit(1);
}
if (mode === 'staffless-export-refused') {
    process.stderr.write('[original#1] This sheet does not seem to contain staff lines.\\n');
    process.stderr.write('Sheet ori');
    process.stderr.write('ginal#1 flagged as invalid.\\n');
    process.stderr.write('Could not export since transcription did not complete successfully\\n');
    process.exit(1);
}
if (mode === 'low-dpi-music') {
    process.stderr.write('[original#2] With an interline value of 7 pixels, either this sheet contains no staves, or the picture resolution is too low (try 300 DPI).\\n');
    process.stderr.write('Sheet original#2 flagged as invalid.\\n');
    process.stderr.write('Could not export since transcription did not complete successfully\\n');
    writeFileSync(join(outDir, 'leftover.mxl'), 'truncated');
    process.exit(1);
}
if (mode === 'stub-error-export-refused') {
    process.stderr.write('WARN  [original#11] Book 2044 | Error processing stub java.lang.NullPointerException: staff is null\\n');
    process.stderr.write('java.lang.NullPointerException: staff is null\\n');
    process.stderr.write('\\tat org.audiveris.omr.sheet.curve.ArcRetriever.isStaffArc\\n');
    process.stderr.write('Could not export since transcription did not complete successfully\\n');
    writeFileSync(join(outDir, 'leftover.mxl'), 'truncated');
    process.exit(1);
}
if (mode === 'silent-exit') {
    process.exit(1);
}
process.stderr.write('unexpected fake mode\\n');
process.exit(2);
`;

describe('runAudiveris process close', () => {
    const prevBin = process.env.AUDIVERIS_BIN;
    const prevMode = process.env.FAKE_AUDIVERIS_MODE;
    let bin = '';
    let work = '';

    const installFake = async (): Promise<void> => {
        work = await mkdtemp(join(tmpdir(), 'omr-fake-av-'));
        bin = join(work, 'Audiveris.mjs');
        await writeFile(bin, FAKE_AUDIVERIS, { encoding: 'utf8' });
        await chmod(bin, 0o755);
        process.env.AUDIVERIS_BIN = bin;
    };

    const cleanup = async (): Promise<void> => {
        if (prevBin === undefined) {
            delete process.env.AUDIVERIS_BIN;
        } else {
            process.env.AUDIVERIS_BIN = prevBin;
        }
        if (prevMode === undefined) {
            delete process.env.FAKE_AUDIVERIS_MODE;
        } else {
            process.env.FAKE_AUDIVERIS_MODE = prevMode;
        }
        if (work) {
            await rm(work, { recursive: true, force: true });
        }
    };

    it('treats a non-zero exit plus leftover mxl plus one invalid flag as omr_crash, not READY', async () => {
        await installFake();
        try {
            process.env.FAKE_AUDIVERIS_MODE = 'crash-flag-mxl';
            const outDir = join(work, 'out-crash');
            await mkdir(outDir, { recursive: true });
            await expect(runAudiveris('/in.pdf', outDir, { timeoutMs: 5_000 })).rejects.toMatchObject({
                code: ERROR_CODES.omrCrash,
            });
        } finally {
            await cleanup();
        }
    });

    it('recovers only when SCALE said no staves and export was refused', async () => {
        await installFake();
        try {
            process.env.FAKE_AUDIVERIS_MODE = 'staffless-export-refused';
            const outDir = join(work, 'out-skip');
            await mkdir(outDir, { recursive: true });
            const result = await runAudiveris('/in.pdf', outDir, { timeoutMs: 5_000 });
            expect(result.exitCode).toBe(1);
            expect(result.mxlPaths).toEqual([]);
            expect(result.invalidSheets).toEqual([1]);
        } finally {
            await cleanup();
        }
    });

    it('fails closed on a low-DPI music page even if leftover mxl is on disk', async () => {
        await installFake();
        try {
            process.env.FAKE_AUDIVERIS_MODE = 'low-dpi-music';
            const outDir = join(work, 'out-dpi');
            await mkdir(outDir, { recursive: true });
            await expect(runAudiveris('/in.pdf', outDir, { timeoutMs: 5_000 })).rejects.toMatchObject({
                code: ERROR_CODES.omrCrash,
            });
        } finally {
            await cleanup();
        }
    });

    it('returns failed stubs without treating leftover MusicXML as success', async () => {
        await installFake();
        try {
            process.env.FAKE_AUDIVERIS_MODE = 'stub-error-export-refused';
            const outDir = join(work, 'out-stub');
            await mkdir(outDir, { recursive: true });
            const result = await runAudiveris('/in.pdf', outDir, { timeoutMs: 5_000 });
            expect(result.exitCode).toBe(1);
            expect(result.mxlPaths).toEqual([]);
            expect(result.invalidSheets).toEqual([11]);
            expect(result.failedStubSheets).toEqual([11]);
        } finally {
            await cleanup();
        }
    });

    it('recovers from the Audiveris log file when stdout is empty', async () => {
        await installFake();
        const prevHome = process.env.HOME;
        try {
            process.env.FAKE_AUDIVERIS_MODE = 'silent-exit';
            process.env.HOME = work;
            const logDir = join(work, AUDIVERIS_LOG_REL);
            await mkdir(logDir, { recursive: true });
            await writeFile(
                join(logDir, '20260910T161525.log'),
                'WARN  [original#11] Book | Error processing stub java.lang.NullPointerException: staff is null\n' +
                    'java.lang.NullPointerException: staff is null\n' +
                    'INFO  [] Book | Could not export since transcription did not complete successfully\n',
            );
            const outDir = join(work, 'out-silent');
            await mkdir(outDir, { recursive: true });
            const result = await runAudiveris('/in.pdf', outDir, { timeoutMs: 5_000 });
            expect(result.exitCode).toBe(1);
            expect(result.invalidSheets).toEqual([11]);
            expect(result.failedStubSheets).toEqual([11]);
        } finally {
            if (prevHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = prevHome;
            }
            await cleanup();
        }
    });
});
