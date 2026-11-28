import { afterEach, describe, expect, it, vi } from 'vitest';

import { IMSLP_IMPORT_MARKS, perfImportSummaryIfDev, perfMark, perfReport } from '@/lib/perf';

afterEach(() => {
    performance.clearMarks();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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

describe('IMSLP import summary', () => {
    const tableSpy = () => vi.spyOn(console, 'table').mockImplementation(() => undefined);

    it('prints every mark from the latest Add click on, in order, with its offset from that click', () => {
        vi.stubEnv('DEV', true);
        const table = tableSpy();
        perfMark('imslp-add-click');
        perfMark('imslp-edge-start');
        for (const mark of IMSLP_IMPORT_MARKS) {
            perfMark(mark);
        }

        perfImportSummaryIfDev();

        expect(table).toHaveBeenCalledTimes(1);
        const rows = table.mock.calls[0]?.[0] as Array<{ mark: string; ms: number; deltaMs: number }>;
        expect(rows.map((row) => row.mark)).toEqual(
            IMSLP_IMPORT_MARKS.slice(IMSLP_IMPORT_MARKS.indexOf('imslp-add-click')),
        );
        expect(rows[0]?.deltaMs).toBe(0);
        expect(rows.every((row) => row.deltaMs >= 0 && row.deltaMs === row.ms - rows[0]!.ms)).toBe(true);
    });

    it('prints nothing outside dev', () => {
        vi.stubEnv('DEV', false);
        const table = tableSpy();
        for (const mark of IMSLP_IMPORT_MARKS) {
            perfMark(mark);
        }

        perfImportSummaryIfDev();

        expect(table).not.toHaveBeenCalled();
    });

    it('prints nothing when no Add click was recorded', () => {
        vi.stubEnv('DEV', true);
        const table = tableSpy();
        perfMark('viewer-mount');
        perfMark('pdf-page1-painted');

        perfImportSummaryIfDev();

        expect(table).not.toHaveBeenCalled();
    });
});
