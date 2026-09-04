import { describe, expect, it } from 'vitest';

import {
    PARALLEL_MIN_MEMORY_BYTES,
    PARALLEL_SHEET_MIN_PAGES,
    parseCgroupMemoryLimit,
    shouldRunParallelShards,
} from './job.js';

const GIB = 1024 * 1024 * 1024;

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

    it('stays serial on Cloud Run 4Gi and typical 8Gi Docker', () => {
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
