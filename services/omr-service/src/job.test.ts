import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AdmZip from 'adm-zip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES, JobError } from './errors.js';
import {
    ENGINE_VERSION,
    PARALLEL_MIN_MEMORY_BYTES,
    PARALLEL_SHEET_MIN_PAGES,
    assertScoreUsable,
    cacheKeyFor,
    collectRangeArtifacts,
    parseCgroupMemoryLimit,
    planMovementRanges,
    recordInvalidSheets,
    scoreIsPlayable,
    shouldRunParallelShards,
    transcribeAndMergeSheetRanges,
    unionSheetNumbers,
} from './job.js';
import type * as audiveris from './audiveris.js';
import { timeoutForPages } from './audiveris.js';
import type { ScoreData } from './scoreData.js';
import { emptyTimings } from './timings.js';

const runAudiverisTolerant = vi.fn();

vi.mock('./audiveris.js', async (importOriginal) => {
    const actual = await importOriginal<typeof audiveris>();
    return {
        ...actual,
        runAudiverisTolerant: (...args: unknown[]) => runAudiverisTolerant(...args),
    };
});

const GIB = 1024 * 1024 * 1024;

const stubScore = (warnings: string[] = []): ScoreData =>
    ({
        version: 3,
        ticksPerQuarter: 480,
        defaultBpm: 90,
        timeSignatures: [{ tick: 0, num: 4, den: 4 }],
        totalTicks: 480,
        notes: [{ t: 0, d: 480, p: 60, h: 0 }],
        measures: [{ n: 1, tick: 0, dTicks: 480, page: 0, sys: 0, x0: 0, x1: 1 }],
        systems: [{ page: 0, y0: 0, y1: 1 }],
        warnings,
    }) as ScoreData;

describe('parseCgroupMemoryLimit', () => {
    it('treats unlimited sentinels as unknown', () => {
        expect(parseCgroupMemoryLimit('max')).toBeNull();
        expect(parseCgroupMemoryLimit('-1')).toBeNull();
        expect(parseCgroupMemoryLimit('')).toBeNull();
        expect(parseCgroupMemoryLimit('9223372036854771712')).toBeNull();
        expect(parseCgroupMemoryLimit('not-a-number')).toBeNull();
        expect(parseCgroupMemoryLimit('0')).toBeNull();
    });

    it('parses real cgroup limits', () => {
        expect(parseCgroupMemoryLimit('4294967296')).toBe(4 * GIB);
        expect(parseCgroupMemoryLimit(' 8589934592\n')).toBe(8 * GIB);
    });
});

describe('shouldRunParallelShards', () => {
    it('stays serial below the page floor', () => {
        expect(shouldRunParallelShards(PARALLEL_SHEET_MIN_PAGES - 1, 16 * GIB)).toBe(false);
    });

    it('stays serial at 4Gi and at the 8Gi floor; 16Gi Cloud Run is parallel', () => {
        expect(shouldRunParallelShards(19, 4 * GIB)).toBe(false);
        expect(shouldRunParallelShards(19, PARALLEL_MIN_MEMORY_BYTES)).toBe(false);
        expect(shouldRunParallelShards(19, null)).toBe(false);
    });

    it('allows two JVMs only when RAM is above 8Gi', () => {
        expect(shouldRunParallelShards(PARALLEL_SHEET_MIN_PAGES, 16 * GIB, undefined)).toBe(true);
        expect(shouldRunParallelShards(19, 16 * GIB, undefined)).toBe(true);
    });

    it('honors OMR_PARALLEL=0 even on a large container', () => {
        expect(shouldRunParallelShards(19, 16 * GIB, '0')).toBe(false);
        expect(shouldRunParallelShards(19, 16 * GIB, 'off')).toBe(false);
    });
});

describe('cacheKeyFor', () => {
    it('keys the cache by era as well as engine, since the era comes from the title, not the PDF', () => {
        const eras = ['baroque', 'classical', 'romantic', 'modern'] as const;
        const keys = eras.map((era) => cacheKeyFor(ENGINE_VERSION, era));
        expect(new Set(keys).size).toBe(eras.length);
        for (const key of keys) {
            expect(key.startsWith(ENGINE_VERSION)).toBe(true);
        }
    });

    it('leaves the bare engine version parseable for the client generation check', () => {
        // The client reads `+svc-N` anchored at the end of documents.engine_version.
        expect(ENGINE_VERSION).toMatch(/\+svc-\d+$/);
        expect(cacheKeyFor(ENGINE_VERSION, 'classical')).not.toMatch(/\+svc-\d+$/);
    });
});

describe('unionSheetNumbers', () => {
    it('unions, sorts, and drops junk', () => {
        expect(unionSheetNumbers([3, 1], [1, 5, 0, 2.5])).toEqual([1, 3, 5]);
    });
});

describe('recordInvalidSheets', () => {
    it('is a no-op when nothing was skipped', () => {
        const timings = emptyTimings();
        const score = stubScore();
        expect(recordInvalidSheets(timings, score, [])).toBe(score);
        expect(timings.invalidSheets).toBeUndefined();
    });

    it('records timings and adds pages_skipped once', () => {
        const timings = emptyTimings();
        const scored = recordInvalidSheets(timings, stubScore(), [1]);
        expect(scored.warnings).toEqual(['pages_skipped']);
        expect(timings.invalidSheets).toEqual([1]);
        const again = recordInvalidSheets(timings, scored, [1, 4]);
        expect(again.warnings).toEqual(['pages_skipped']);
        expect(timings.invalidSheets).toEqual([1, 4]);
    });
});

describe('collectRangeArtifacts', () => {
    beforeEach(() => {
        runAudiverisTolerant.mockReset();
    });

    it('returns invalidSheets from the tolerant runner and records timings', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'omr-art-'));
        const mxlPath = join(dir, 'a.mxl');
        await writeFile(mxlPath, '<score-partwise/>');
        try {
            runAudiverisTolerant.mockResolvedValue({
                mxlPaths: [mxlPath],
                omrPath: null,
                jvmStartToFirstSheetMs: 1,
                perSheetMs: [2],
                stepCounts: {},
                stepDurationsMs: {},
                audiverisTotalMs: 9,
                invalidSheets: [1],
                failedStubSheets: [],
                exitCode: 0,
            });
            const timings = emptyTimings();
            timings.pageCount = 8;
            const artifacts = await collectRangeArtifacts(
                '/in.pdf',
                dir,
                timings,
                () => undefined,
                undefined,
                undefined,
                true,
            );
            expect(artifacts.invalidSheets).toEqual([1]);
            expect(artifacts.mxlBuffers).toHaveLength(1);
            expect(timings.invalidSheets).toEqual([1]);
            expect(runAudiverisTolerant).toHaveBeenCalledWith(
                '/in.pdf',
                dir,
                expect.objectContaining({ pageCount: 8 }),
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('maps a shard-local all-invalid no_staves_found to omr_crash so serial fallback can run', async () => {
        runAudiverisTolerant.mockRejectedValue(new JobError(ERROR_CODES.noStavesFound, 'All sheets flagged invalid'));
        const timings = emptyTimings();
        timings.pageCount = 4;
        await expect(
            collectRangeArtifacts('/in.pdf', '/tmp/omr-shard', timings, () => undefined, undefined, { from: 1, to: 2 }, true),
        ).rejects.toMatchObject({ code: ERROR_CODES.omrCrash });
    });

    it('keeps no_staves_found when the whole book is staff-less', async () => {
        runAudiverisTolerant.mockRejectedValue(new JobError(ERROR_CODES.noStavesFound, 'All sheets flagged invalid'));
        const timings = emptyTimings();
        timings.pageCount = 3;
        await expect(
            collectRangeArtifacts('/in.pdf', '/tmp/omr-book', timings, () => undefined, undefined, undefined, true),
        ).rejects.toMatchObject({ code: ERROR_CODES.noStavesFound });
    });

    it('passes post-skip sheet bounds so merge does not remap onto the cover', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'omr-art-'));
        const mxlPath = join(dir, 'a.mxl');
        await writeFile(mxlPath, '<score-partwise/>');
        try {
            runAudiverisTolerant.mockResolvedValue({
                mxlPaths: [mxlPath],
                omrPath: null,
                jvmStartToFirstSheetMs: 1,
                perSheetMs: [2],
                stepCounts: {},
                stepDurationsMs: {},
                audiverisTotalMs: 9,
                invalidSheets: [1],
                failedStubSheets: [],
                exitCode: 0,
            });
            const timings = emptyTimings();
            timings.pageCount = 5;
            const artifacts = await collectRangeArtifacts(
                '/in.pdf',
                dir,
                timings,
                () => undefined,
                undefined,
                { from: 1, to: 5 },
                true,
            );
            expect(artifacts.sheets).toEqual({ from: 2, to: 5 });
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('returns every .mxl in filename order, not only the first', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'omr-art-'));
        const first = join(dir, 'a.mxl');
        const second = join(dir, 'b.mxl');
        await writeFile(first, 'one');
        await writeFile(second, 'two');
        try {
            runAudiverisTolerant.mockResolvedValue({
                mxlPaths: [first, second],
                omrPath: null,
                jvmStartToFirstSheetMs: 1,
                perSheetMs: [2],
                stepCounts: {},
                stepDurationsMs: {},
                audiverisTotalMs: 9,
                invalidSheets: [],
                failedStubSheets: [],
                exitCode: 0,
                scoreSheetGroups: [],
            });
            const timings = emptyTimings();
            timings.pageCount = 8;
            const artifacts = await collectRangeArtifacts(
                '/in.pdf',
                dir,
                timings,
                () => undefined,
                undefined,
                undefined,
                true,
            );
            expect(artifacts.mxlBuffers).toHaveLength(2);
            expect(artifacts.mxlBuffers[0]?.toString()).toBe('one');
            expect(artifacts.mxlBuffers[1]?.toString()).toBe('two');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('uses timeoutForPages of the range when timeoutPageCount is set', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'omr-art-'));
        const mxlPath = join(dir, 'a.mxl');
        await writeFile(mxlPath, '<score-partwise/>');
        try {
            runAudiverisTolerant.mockResolvedValue({
                mxlPaths: [mxlPath],
                omrPath: null,
                jvmStartToFirstSheetMs: 1,
                perSheetMs: [2],
                stepCounts: {},
                stepDurationsMs: {},
                audiverisTotalMs: 9,
                invalidSheets: [],
                failedStubSheets: [],
                exitCode: 0,
                scoreSheetGroups: [],
            });
            const timings = emptyTimings();
            timings.pageCount = 20;
            await collectRangeArtifacts(
                '/in.pdf',
                dir,
                timings,
                () => undefined,
                undefined,
                { from: 1, to: 6 },
                true,
                6,
            );
            expect(runAudiverisTolerant).toHaveBeenCalledWith(
                '/in.pdf',
                dir,
                expect.objectContaining({ timeoutMs: timeoutForPages(6), pageCount: 20 }),
            );
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('planMovementRanges', () => {
    it('splits Tempest valid sheets around failed stubs', () => {
        expect(planMovementRanges(20, [11, 12, 18, 19], false)).toEqual([
            { from: 1, to: 10 },
            { from: 13, to: 17 },
            { from: 20, to: 20 },
        ]);
    });

    it('does not invent ranges that include failed stubs', () => {
        const ranges = planMovementRanges(20, [11, 12, 18, 19], false);
        const sheets = ranges.flatMap((range) => {
            const out: number[] = [];
            for (let sheet = range.from; sheet <= range.to; sheet++) {
                out.push(sheet);
            }
            return out;
        });
        expect(sheets).not.toContain(11);
        expect(sheets).not.toContain(12);
        expect(sheets).not.toContain(18);
        expect(sheets).not.toContain(19);
    });

    it('returns no re-run when the first export is already playable', () => {
        expect(planMovementRanges(20, [11, 12, 18, 19], true)).toEqual([]);
    });

    it('uses PAGE log groups and keeps uncovered valid leftover sheets', () => {
        expect(
            planMovementRanges(20, [11, 12, 18, 19], false, [
                { from: 1, to: 6 },
                { from: 7, to: 10 },
            ]),
        ).toEqual([
            { from: 1, to: 6 },
            { from: 7, to: 10 },
            { from: 13, to: 17 },
            { from: 20, to: 20 },
        ]);
    });
});

const TEMPEST_GEOMETRY_PAGES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 19];

const scoreWithPageCoverage = (
    geometryPages: readonly number[],
    soundingPages: readonly number[],
    extras: Partial<ScoreData> = {},
): ScoreData => {
    const systems = geometryPages.flatMap((page) => [
        { page, y0: 0.1, y1: 0.22 },
        { page, y0: 0.28, y1: 0.4 },
        { page, y0: 0.46, y1: 0.58 },
        { page, y0: 0.64, y1: 0.76 },
        { page, y0: 0.82, y1: 0.94 },
        { page, y0: 0.95, y1: 0.99 },
    ]);
    const measures = soundingPages.map((page, i) => ({
        n: i + 1,
        tick: i * 480,
        dTicks: 480,
        page,
        sys: 0,
        x0: 0,
        x1: 1,
    }));
    const notes = soundingPages.map((_, i) => ({ t: i * 480, d: 480, p: 60, h: 0 as const }));
    return {
        version: 3,
        ticksPerQuarter: 480,
        defaultBpm: 90,
        timeSignatures: [{ tick: 0, num: 4, den: 4 }],
        totalTicks: Math.max(480, soundingPages.length * 480),
        notes: notes.length > 0 ? notes : [{ t: 0, d: 480, p: 60, h: 0 }],
        measures:
            measures.length > 0
                ? measures
                : [{ n: 1, tick: 0, dTicks: 480, page: -1, sys: -1, x0: 0, x1: 1 }],
        systems,
        warnings: [],
        ...extras,
    } as ScoreData;
};

describe('score playback usability gate', () => {
    it('accepts a Tempest-shaped book once concatenated parts cover every recovered page', () => {
        const score = scoreWithPageCoverage(TEMPEST_GEOMETRY_PAGES, TEMPEST_GEOMETRY_PAGES, {
            warnings: ['parts_concatenated', 'multi_part_collapsed', 'pages_skipped'],
        });
        expect(scoreIsPlayable(score)).toBe(true);
        expect(() => assertScoreUsable(score)).not.toThrow();
    });

    it('rejects a Tempest-shaped book: many systems, notes on one recovered page', () => {
        const score = scoreWithPageCoverage(TEMPEST_GEOMETRY_PAGES, [0], {
            warnings: ['measure_geometry_mismatch', 'multi_part_collapsed', 'pages_skipped'],
        });
        expect(score.systems).toHaveLength(96);
        expect(scoreIsPlayable(score)).toBe(false);
        try {
            assertScoreUsable(score);
            throw new Error('expected score_unusable');
        } catch (err) {
            expect(err).toBeInstanceOf(JobError);
            expect(err).toMatchObject({ code: ERROR_CODES.scoreUnusable });
        }
    });

    it('rejects one silent recovered music page', () => {
        const sounding = TEMPEST_GEOMETRY_PAGES.slice(0, -1);
        const score = scoreWithPageCoverage(TEMPEST_GEOMETRY_PAGES, sounding);
        expect(scoreIsPlayable(score)).toBe(false);
        expect(() => assertScoreUsable(score)).toThrow(JobError);
    });

    it('accepts Moonlight-shaped full coverage of recovered pages', () => {
        const musicPages = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
        const score = scoreWithPageCoverage(musicPages, musicPages);
        expect(scoreIsPlayable(score)).toBe(true);
        expect(() => assertScoreUsable(score)).not.toThrow();
    });

    it('accepts a staff-less cover skip when remaining pages have notes', () => {
        const musicPages = [1, 2, 3, 4, 5];
        const score = scoreWithPageCoverage(musicPages, musicPages, { warnings: ['pages_skipped'] });
        expect(scoreIsPlayable(score)).toBe(true);
        expect(() => assertScoreUsable(score)).not.toThrow();
    });

    it('accepts no-geometry scores that still have notes', () => {
        const score = scoreWithPageCoverage([], [0], {
            systems: [],
            measures: [{ n: 1, tick: 0, dTicks: 480, page: -1, sys: -1, x0: 0, x1: 1 }],
            warnings: ['no_geometry'],
        });
        expect(scoreIsPlayable(score)).toBe(true);
    });

    it('requires every recovered geometry page to have notes', () => {
        const pages = [0, 1, 2, 3];
        expect(scoreIsPlayable(scoreWithPageCoverage(pages, pages))).toBe(true);
        expect(scoreIsPlayable(scoreWithPageCoverage(pages, [0, 1, 2]))).toBe(false);
    });
});

describe('transcribeAndMergeSheetRanges', () => {
    beforeEach(() => {
        runAudiverisTolerant.mockReset();
    });

    const mxlFromXml = (xml: string): Buffer => {
        const zip = new AdmZip();
        zip.addFile('score.xml', Buffer.from(xml, 'utf8'));
        return zip.toBuffer();
    };

    const oneBar = (beats: number, beatType: number, step: string): string =>
        `<?xml version="1.0"?>
        <score-partwise version="4.0">
          <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
          <part id="P1"><measure number="1">
            <attributes><divisions>4</divisions><staves>2</staves>
              <time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>
            </attributes>
            <note><pitch><step>${step}</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><staff>1</staff></note>
            <backup><duration>16</duration></backup>
            <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><voice>1</voice><staff>2</staff></note>
          </measure></part>
        </score-partwise>`;

    it('merges per-range ScoreData and keeps a later 3/8', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'omr-mv-'));
        const firstPath = join(dir, 'first.mxl');
        const secondPath = join(dir, 'second.mxl');
        await writeFile(firstPath, mxlFromXml(oneBar(4, 4, 'C')));
        await writeFile(secondPath, mxlFromXml(oneBar(3, 8, 'E')));
        try {
            runAudiverisTolerant.mockImplementation(async (_pdf: string, outDir: string) => {
                const path = String(outDir).includes('13-17') ? secondPath : firstPath;
                return {
                    mxlPaths: [path],
                    omrPath: null,
                    jvmStartToFirstSheetMs: 1,
                    perSheetMs: [2],
                    stepCounts: {},
                    stepDurationsMs: {},
                    audiverisTotalMs: 9,
                    invalidSheets: [],
                    failedStubSheets: [],
                    exitCode: 0,
                    scoreSheetGroups: [],
                };
            });
            const timings = emptyTimings();
            timings.pageCount = 20;
            const score = await transcribeAndMergeSheetRanges(
                '/in.pdf',
                dir,
                timings,
                'classical',
                () => undefined,
                undefined,
                [
                    { from: 1, to: 10 },
                    { from: 13, to: 17 },
                ],
            );
            expect(runAudiverisTolerant).toHaveBeenCalledTimes(2);
            const timeouts = runAudiverisTolerant.mock.calls.map((call) => call[2]?.timeoutMs);
            expect(timeouts).toEqual([timeoutForPages(10), timeoutForPages(5)]);
            expect(score.timeSignatures).toEqual(
                expect.arrayContaining([
                    { tick: 0, num: 4, den: 4 },
                    expect.objectContaining({ num: 3, den: 8 }),
                ]),
            );
            expect(score.notes.some((n) => n.p === 72)).toBe(true);
            expect(score.notes.some((n) => n.p === 76)).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
