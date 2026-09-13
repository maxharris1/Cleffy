import type { PageColumns } from '@/features/viewer/geometry';

/** Storage key for the viewer's one-page / two-page choice. */
const STORAGE_KEY = 'cleffy:page-columns';

/** Storage key for the two-page spread's "first page is a cover" choice. */
const COVER_STORAGE_KEY = 'cleffy:spread-cover';

/** A single column reads best on a phone or a portrait tablet — the common case. */
const DEFAULT_COLUMNS: PageColumns = 1;

/** Most PDFs start on music, not a title page — pair from page 1 until told otherwise. */
const DEFAULT_SPREAD_COVER = false;

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

/**
 * Reads whether the two-page spread should hold its first page back as a
 * cover. Same guarded access as the column count: a browser that refuses
 * storage gets the default rather than an exception.
 */
export const readSpreadCover = (): boolean => {
    try {
        const stored = window.localStorage.getItem(COVER_STORAGE_KEY);
        return stored === '1' ? true : stored === '0' ? false : DEFAULT_SPREAD_COVER;
    } catch {
        return DEFAULT_SPREAD_COVER;
    }
};

/** Persists the cover choice, best-effort. */
export const writeSpreadCover = (coverPage: boolean): void => {
    try {
        window.localStorage.setItem(COVER_STORAGE_KEY, coverPage ? '1' : '0');
    } catch {
        // Storage disabled or full: the layout still switched for this session.
    }
};
