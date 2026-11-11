/**
 * The demo's session rules: each visitor gets a private sandbox that starts
 * blank in every new browser session, survives a refresh, and is kept on the
 * device only if they ask. The ink itself is ordinary local-doc ink (Dexie,
 * keyed by DEMO_DOC_ID); this module decides only whether to wipe it before
 * the viewer mounts.
 *
 * Every storage access is wrapped, as in viewerPrefs: Safari in private mode
 * and browsers with site data disabled THROW on `sessionStorage` and
 * `localStorage` rather than returning null. The safe default is always the
 * blank sandbox — a visitor must never land on someone's leftover ink because
 * a preference could not be read.
 *
 * Known and accepted: two demo tabs share DEMO_DOC_ID, so a new tab (a new
 * sessionStorage) wipes the ink an older tab is still showing. Per-tab ids
 * would fix it, and would also break "keep my markings" across tabs; the demo
 * is one visitor, one tab.
 */

/** sessionStorage: '1' once this tab's browser session has started the demo. */
export const DEMO_SESSION_KEY = 'cleffy:demo-session';

/** localStorage: '1' when the visitor chose to keep their markings on this device. */
export const DEMO_KEEP_KEY = 'cleffy:demo-keep';

/** sessionStorage: '1' once the visitor has put away the "what Cleffy does" card in this browser session. */
export const DEMO_VALUE_CARD_KEY = 'cleffy:demo-value-card';

/**
 * Whether the value card was put away earlier in this session (a reload, or
 * a return to /try). Unreadable storage reads as no: the card is a nudge, so
 * the worst a refusing browser costs is seeing it once more.
 */
export const readValueCardDismissed = (): boolean => {
    try {
        return window.sessionStorage.getItem(DEMO_VALUE_CARD_KEY) === '1';
    } catch {
        return false;
    }
};

/** Remembers the card was put away. Quietly does nothing when storage refuses: the page still hides it. */
export const writeValueCardDismissed = (): void => {
    try {
        window.sessionStorage.setItem(DEMO_VALUE_CARD_KEY, '1');
    } catch {
        // Private mode or site data blocked: the card stays away for this page load only.
    }
};

/** Whether the visitor asked to keep their markings. Unreadable storage reads as no. */
export const readKeepMarkings = (): boolean => {
    try {
        return window.localStorage.getItem(DEMO_KEEP_KEY) === '1';
    } catch {
        return false;
    }
};

/**
 * Persists the keep choice and says whether it stuck: the stored value is read
 * back, so a browser that refuses or drops the write (private mode, site data
 * blocked, full) reports false rather than a toggle showing a promise the next
 * session would break. Turning it off deletes nothing now: it only means the
 * next new session starts blank.
 */
export const writeKeepMarkings = (keep: boolean): boolean => {
    try {
        if (keep) {
            window.localStorage.setItem(DEMO_KEEP_KEY, '1');
        } else {
            window.localStorage.removeItem(DEMO_KEEP_KEY);
        }
    } catch {
        // Storage disabled or full: the read below says what actually holds.
    }
    return readKeepMarkings() === keep;
};

/** A refresh or an in-app return in this tab. Unreadable storage reads as a new session. */
const readSessionStarted = (): boolean => {
    try {
        return window.sessionStorage.getItem(DEMO_SESSION_KEY) === '1';
    } catch {
        return false;
    }
};

/** False when it did not stick: every load then counts as a new session and wipes, the safe default. */
const markSessionStarted = (): boolean => {
    try {
        window.sessionStorage.setItem(DEMO_SESSION_KEY, '1');
        return true;
    } catch {
        return false;
    }
};

/** The decision itself: only a new session that did not ask to keep its ink starts blank. */
export const shouldWipeDemo = ({ keep, sessionStarted }: { keep: boolean; sessionStarted: boolean }): boolean =>
    !keep && !sessionStarted;

/**
 * Runs before the demo's viewport mounts: wipes the demo's stored ink if this
 * is a new session that did not ask to keep it, then marks the session
 * started. The marker goes on only after the wipe has finished, so a wipe
 * that fails (rejects) is tried again on the next load rather than skipped.
 *
 * `remembered` is false when the marker could not be stored: a reload will
 * count as a new session and wipe, which the visitor should hear about.
 */
export const startDemoSession = async (wipe: () => Promise<void>): Promise<{ wiped: boolean; remembered: boolean }> => {
    const wiped = shouldWipeDemo({ keep: readKeepMarkings(), sessionStarted: readSessionStarted() });
    if (wiped) {
        await wipe();
    }
    return { wiped, remembered: markSessionStarted() };
};
