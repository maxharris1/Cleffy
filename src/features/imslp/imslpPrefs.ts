export type ImslpView = 'grid' | 'list';

/** Storage key for the IMSLP find page's grid/list choice. */
const STORAGE_KEY = 'cleffy:imslp-view';

/**
 * Rows by default: search is a snippet-driven disambiguation task, and every
 * cover here is a typeset stand-in (IMSLP hits carry no image), so density
 * beats shelf recognition until the user says otherwise.
 */
const DEFAULT_VIEW: ImslpView = 'list';

/**
 * Reads the saved card/row choice, falling back to rows.
 *
 * Every access is wrapped: Safari in private mode and any browser with site
 * data disabled THROW on `localStorage` rather than returning null, and a
 * user who cannot persist a preference must still get a search page. An
 * unrecognised stored value (hand-edited, or written by a future version) is
 * treated the same as nothing stored.
 */
export const readImslpView = (): ImslpView => {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return stored === 'grid' || stored === 'list' ? stored : DEFAULT_VIEW;
    } catch {
        return DEFAULT_VIEW;
    }
};

/** Persists the choice, best-effort — a preference is never worth an error state. */
export const writeImslpView = (view: ImslpView): void => {
    try {
        window.localStorage.setItem(STORAGE_KEY, view);
    } catch {
        // Storage disabled or full: the view still switched for this session.
    }
};
