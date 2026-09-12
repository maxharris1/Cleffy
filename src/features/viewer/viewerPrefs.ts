import type { PageColumns } from '@/features/viewer/geometry';

/** Storage key for the viewer's one-page / two-page choice. */
const STORAGE_KEY = 'cleffy:page-columns';

/** A single column reads best on a phone or a portrait tablet — the common case. */
const DEFAULT_COLUMNS: PageColumns = 1;

/**
 * Reads the saved page-column choice, falling back to one column.
 *
 * Every access is wrapped: Safari in private mode and any browser with site
 * data disabled THROW on `localStorage` rather than returning null, and a
 * reader who cannot persist a preference must still get a score. An
 * unrecognised stored value (hand-edited, or written by a future version) is
 * treated the same as nothing stored.
 */
export const readPageColumns = (): PageColumns => {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return stored === '2' ? 2 : stored === '1' ? 1 : DEFAULT_COLUMNS;
    } catch {
        return DEFAULT_COLUMNS;
    }
};

/** Persists the choice, best-effort — a preference is never worth an error state. */
export const writePageColumns = (columns: PageColumns): void => {
    try {
        window.localStorage.setItem(STORAGE_KEY, String(columns));
    } catch {
        // Storage disabled or full: the layout still switched for this session.
    }
};
