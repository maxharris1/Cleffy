import type { CachedClearance } from './imslpImportFlow.ts';
import { LICENSE_TTL_MS } from './imslpLicense.ts';

/** A byte-cache hit is never a substitute for current license clearance. */
export const imslpCachedClearance = (
    row: {
        downloadable?: unknown;
        fetched_at?: unknown;
        restriction?: unknown;
        license_label?: unknown;
        work_title?: unknown;
    } | null,
    now = Date.now(),
): CachedClearance | null => {
    if (
        !row ||
        typeof row.fetched_at !== 'string' ||
        !(now - new Date(row.fetched_at).getTime() < LICENSE_TTL_MS) ||
        typeof row.downloadable !== 'boolean'
    ) {
        return null;
    }
    return {
        downloadable: row.downloadable,
        restriction: typeof row.restriction === 'string' ? row.restriction : null,
        licenseLabel: typeof row.license_label === 'string' ? row.license_label : null,
        workTitle: typeof row.work_title === 'string' && row.work_title ? row.work_title : null,
    };
};
