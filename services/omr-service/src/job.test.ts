import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES, JobError } from './errors.js';
import {
    ENGINE_VERSION,
    PARALLEL_MIN_MEMORY_BYTES,
    PARALLEL_SHEET_MIN_PAGES,
    cacheKeyFor,
    collectRangeArtifacts,
    parseCgroupMemoryLimit,
    recordInvalidSheets,
    shouldRunParallelShards,
    unionSheetNumbers,
} from './job.js';
import type { ScoreData } from './scoreData.js';
import { emptyTimings } from './timings.js';

const runAudiverisTolerant = vi.fn();

vi.mock('./audiveris.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./audiveris.js')>();
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
});
