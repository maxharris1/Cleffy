import { afterEach, describe, expect, it } from 'vitest';

import { perfMark, perfReport } from '@/lib/perf';

afterEach(() => {
    performance.clearMarks();
});

describe('perf marks', () => {
    it('records marks under the app prefix and reports them in order', () => {
        perfMark('session-known');
        perfMark('library-cache-paint');
        perfMark('library-network-paint');
        expect(perfReport().map((row) => row.mark)).toEqual([
            'session-known',
            'library-cache-paint',
            'library-network-paint',
        ]);
        expect(perfReport().every((row) => Number.isFinite(row.ms) && row.ms >= 0)).toBe(true);
    });

    it('leaves marks from other code out of the report', () => {
        performance.mark('someone-elses-mark');
        perfMark('viewer-cache-paint');
        expect(perfReport().map((row) => row.mark)).toEqual(['viewer-cache-paint']);
    });
});
