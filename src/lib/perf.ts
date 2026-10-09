/**
 * Perceived-load instrumentation: a handful of User Timing marks on the paths
 * this app optimises (session known, library painted from cache / from the
 * network, viewer painted / confirmed). They cost nothing in production and
 * show up in any browser's Performance panel; in dev, the library's network
 * paint also logs a table of every mark's offset from navigation start so a
 * change to the load path can be measured instead of guessed at.
 */

export type PerfMark =
    'session-known' | 'library-cache-paint' | 'library-network-paint' | 'viewer-cache-paint' | 'viewer-confirmed';

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
