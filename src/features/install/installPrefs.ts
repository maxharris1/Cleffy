/** Storage key for dismissing the library Home Screen banner. */
const STORAGE_KEY = 'cleffy:home-screen-prompt-dismissed';

/**
 * Whether this device already hid the library Home Screen banner.
 *
 * Every access is wrapped: Safari in private mode and any browser with site
 * data disabled THROW on `localStorage` rather than returning null.
 */
export const readHomeScreenPromptDismissed = (): boolean => {
    try {
        return window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
        return false;
    }
};

/** Persists the dismissal, best-effort — a preference is never worth an error state. */
export const writeHomeScreenPromptDismissed = (): void => {
    try {
        window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
        // Storage disabled or full: the banner still hid for this session.
    }
};
