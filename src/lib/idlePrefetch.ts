/**
 * Load a lazy chunk while the page is idle, so the navigation that needs it
 * finds it already downloaded and evaluated.
 *
 * Opening a score is what a library visit is for, and the viewer is the
 * heaviest chunk in the app (the viewer itself plus pdf.js): fetched only on
 * the tap, it was downloaded, parsed and run before the score could even
 * start to load. React.lazy imports the same module, so once this has run the
 * route renders without suspending.
 *
 * Once per key per page load. Skipped when the browser asks to save data;
 * failures are ignored — the navigation imports the chunk again itself and
 * meets the error there, as it did before.
 */
const started = new Set<string>();

type IdleWindow = Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
};

/** Longest a prefetch waits for the main thread to go quiet. */
const IDLE_TIMEOUT_MS = 3000;
/** Browsers without requestIdleCallback (Safari): after the first paint has settled. */
const FALLBACK_DELAY_MS = 1500;

export const prefetchWhenIdle = (key: string, load: () => Promise<unknown>): void => {
    if (started.has(key) || typeof window === 'undefined') {
        return;
    }
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (connection?.saveData) {
        return;
    }
    started.add(key);
    const run = () => {
        void load().catch(() => undefined);
    };
    const idle = window as IdleWindow;
    if (typeof idle.requestIdleCallback === 'function') {
        idle.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    } else {
        setTimeout(run, FALLBACK_DELAY_MS);
    }
};
