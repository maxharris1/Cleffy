import { describe, expect, it, vi } from 'vitest';

import { ERROR_CODES, JobError } from './errors.js';
import {
    buildAudiverisArgs,
    parseExtraOpts,
    parseInvalidSheets,
    PLAY_ALONG_AUDIVERIS_OPTIONS,
    runAudiverisTolerant,
    sheetRangesExcluding,
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
    exitCode: 1,
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
});
