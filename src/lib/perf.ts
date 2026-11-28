/**
 * Perceived-load instrumentation: a handful of User Timing marks on the paths
 * this app optimises (session known, library painted from cache / from the
 * network, viewer painted / confirmed). They cost nothing in production and
 * show up in any browser's Performance panel; in dev, the library's network
 * paint also logs a table of every mark's offset from navigation start so a
 * change to the load path can be measured instead of guessed at.
 */

export const IMSLP_IMPORT_MARKS = [
    'imslp-work-click',
    'imslp-work-ready',
    'imslp-add-click',
    'imslp-edge-start',
    'imslp-edge-done',
    'imslp-fetch-doc-done',
    'imslp-storage-dl-done',
    'imslp-dexie-put-done',
    'imslp-page-count-done',
    'imslp-page-count-db-done',
    'imslp-navigate',
    'viewer-mount',
    'pdf-doc-open',
    'pdf-sizes-ready',
    'pdf-page1-painted',
] as const;

export type PerfMark =
    | 'session-known'
    | 'library-cache-paint'
    | 'library-network-paint'
    | 'viewer-cache-paint'
    | 'viewer-confirmed'
    | (typeof IMSLP_IMPORT_MARKS)[number];

const PREFIX = 'cleffy:';

const supported = (): boolean =>
    typeof performance !== 'undefined' &&
    typeof performance.mark === 'function' &&
    typeof performance.getEntriesByType === 'function';

/** Record a mark; repeats of the same name (SPA navigations) are kept, the panel shows them in order. */
export const perfMark = (name: PerfMark): void => {
    if (!supported()) {
        return;
    }
    try {
        performance.mark(`${PREFIX}${name}`);
    } catch {
        // A browser that refuses the mark has nothing to measure with anyway.
    }
};

/** Every recorded mark as {name, ms since navigation start}, oldest first. */
export const perfReport = (): Array<{ mark: string; ms: number }> => {
    if (!supported()) {
        return [];
    }
    return performance
        .getEntriesByType('mark')
        .filter((entry) => entry.name.startsWith(PREFIX))
        .map((entry) => ({ mark: entry.name.slice(PREFIX.length), ms: Math.round(entry.startTime) }));
};

/** Dev only: print the report once the network has painted the library. */
export const perfLogIfDev = (): void => {
    if (!import.meta.env.DEV) {
        return;
    }
    const rows = perfReport();
    if (rows.length > 0) {
        console.table(rows);
    }
};

export const perfImportSummaryIfDev = (): void => {
    if (!import.meta.env.DEV) {
        return;
    }
    const rows = perfReport();
    const start = rows.map((row) => row.mark).lastIndexOf('imslp-add-click');
    const addClick = rows[start];
    if (!addClick) {
        return;
    }
    console.table(rows.slice(start).map((row) => ({ ...row, deltaMs: row.ms - addClick.ms })));
};
