export type LibraryView = 'grid' | 'list';

/** Storage key for the library's grid/list choice. */
const STORAGE_KEY = 'cleffy:library-view';

/** The shelf is the point of the library — covers are how a teacher recognises repertoire. */
const DEFAULT_VIEW: LibraryView = 'grid';

/**
 * Reads the saved shelf/list choice, falling back to the shelf.
 *
 * Every access is wrapped: Safari in private mode and any browser with site
 * data disabled THROW on `localStorage` rather than returning null, and a
 * teacher who cannot persist a preference must still get a library. An
 * unrecognised stored value (hand-edited, or written by a future version) is
 * treated the same as nothing stored.
 */
export const readLibraryView = (): LibraryView => {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return stored === 'grid' || stored === 'list' ? stored : DEFAULT_VIEW;
    } catch {
        return DEFAULT_VIEW;
    }
};

/** Persists the choice, best-effort — a preference is never worth an error state. */
export const writeLibraryView = (view: LibraryView): void => {
    try {
        window.localStorage.setItem(STORAGE_KEY, view);
    } catch {
        // Storage disabled or full: the view still switched for this session.
    }
};
