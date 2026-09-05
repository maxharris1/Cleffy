import { describe, expect, it } from 'vitest';

import {
    ENGINE_VERSION,
    PARALLEL_MIN_MEMORY_BYTES,
    PARALLEL_SHEET_MIN_PAGES,
    cacheKeyFor,
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
