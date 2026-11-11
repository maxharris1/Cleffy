/**
 * Recovering a tab that outlived its own build.
 *
 * Every route and dialog past the shell is a lazy chunk with a content hash in
 * its name. A deploy replaces them all, and the service worker (autoUpdate:
 * skipWaiting + clientsClaim + cleanupOutdatedCaches) takes over tabs that are
 * already open and deletes the old precache. A tab loaded before the deploy
 * still asks for `AccountPage-<old hash>.js`, which no longer exists anywhere:
 * the import rejects, React.lazy rethrows it at render, and the page used to go
 * blank. The fix is the one the error asks for — load the page again, so the
 * new index.html names the new chunks.
 *
 * Reloading is safe for the user's work: annotations and the sync outbox are
 * written to IndexedDB as they are made, and the fresh page drains the outbox
 * as any page load does.
 *
 * Once per short window, and never blind: a chunk that fails again straight
 * after the reload is not a stale build but a real outage (offline with no
 * cached copy, a blocked CDN), and reloading again would only loop. Then the
 * crash screen shows, with its own Reload button. The guard lives in
 * sessionStorage because a reload wipes memory; a tab whose storage is
 * unusable gets no automatic reload at all, since a loop it could not detect
 * is worse than one manual click.
 */

const RELOAD_KEY = 'cleffy:stale-chunk-reload-at';

/**
 * How long after an automatic reload a second chunk failure counts as the same
 * incident. Long enough to cover a slow page load on a poor connection (the
 * QA's Fast 3G runs took ~7 s to a rendered viewer), short enough that the next
 * deploy, hours later, is recovered from again.
 */
export const STALE_CHUNK_RELOAD_WINDOW_MS = 60_000;

/**
 * The messages a missing chunk produces, per engine and bundler path:
 *  * Chromium: "Failed to fetch dynamically imported module: <url>"
 *  * Firefox: "error loading dynamically imported module: <url>"
 *  * Safari: "Importing a module script failed."
 *  * Vite's preload helper (a chunk's CSS or a dependency it preloads):
 *    "Unable to preload CSS for <url>"
 *  * webpack-style names, for completeness: ChunkLoadError / "Loading chunk N failed"
 */
const CHUNK_ERROR_PATTERNS = [
    /failed to fetch dynamically imported module/i,
    /error loading dynamically imported module/i,
    /importing a module script failed/i,
    /unable to preload css/i,
    /loading (css )?chunk [\w-]+ failed/i,
];

/** True when `error` says a lazy chunk (or a file it preloads) could not be fetched. */
export const isChunkLoadError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const { name, message } = error as { name?: unknown; message?: unknown };
    if (name === 'ChunkLoadError') {
        return true;
    }
    return typeof message === 'string' && CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(message));
};

/** Set once this page has started an automatic reload; the page is going away. */
let reloadPending = false;

/** True while the page is being reloaded for a stale chunk (render "updating", report nothing). */
export const isStaleChunkReloadPending = (): boolean => reloadPending;

const readLastReload = (): number | null => {
    const raw = window.sessionStorage.getItem(RELOAD_KEY);
    const at = raw === null ? NaN : Number(raw);
    return Number.isFinite(at) ? at : null;
};

/**
 * Whether an automatic reload is allowed right now: online, storage usable, and
 * no automatic reload in the last STALE_CHUNK_RELOAD_WINDOW_MS. Reads only.
 */
export const canReloadForStaleChunk = (now = Date.now()): boolean => {
    if (reloadPending) {
        return true;
    }
    // Offline, the chunk is missing because the network is: a reload would
    // trade a crash screen with a Reload button for the browser's own offline
    // page when no service worker is serving the shell.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return false;
    }
    try {
        const last = readLastReload();
        return last === null || now - last < 0 || now - last >= STALE_CHUNK_RELOAD_WINDOW_MS;
    } catch {
        return false;
    }
};

/**
 * Reload the page to pick up the current build, unless that was already tried
 * moments ago. Returns true when a reload is under way (also when another call
 * already started it), false when the caller should show the crash screen.
 */
export const reloadForStaleChunk = (now = Date.now(), reload: () => void = () => window.location.reload()): boolean => {
    if (reloadPending) {
        return true;
    }
    if (!canReloadForStaleChunk(now)) {
        return false;
    }
    try {
        window.sessionStorage.setItem(RELOAD_KEY, String(now));
    } catch {
        // Unwritable: the next page could not tell it had already reloaded.
        return false;
    }
    reloadPending = true;
    reload();
    return true;
};

/**
 * Prefetches still in flight (lib/idlePrefetch.ts), and the errors they ended
 * in. A prefetch is a guess made in the background: one that meets a chunk
 * from an older build must not reload the page under a teacher who is
 * mid-upload or has a dialog open on a page that works. Its failure is
 * dropped, and the navigation that needs the chunk imports it again and
 * recovers then, as it did before there was a prefetch.
 */
let prefetchesInFlight = 0;
const prefetchErrors = new WeakSet<object>();

/** Run `load` as a prefetch: a stale chunk it meets does not reload the page. */
export const loadAsPrefetch = async <T>(load: () => Promise<T>): Promise<T> => {
    prefetchesInFlight += 1;
    try {
        return await load();
    } catch (err) {
        if (err !== null && typeof err === 'object') {
            prefetchErrors.add(err);
        }
        throw err;
    } finally {
        prefetchesInFlight -= 1;
    }
};

/**
 * Vite's own signal for a failed lazy import in a built bundle: its preload
 * helper dispatches `vite:preloadError` on window for the chunk itself and for
 * every file the chunk preloads, before the import rejects. Reloading here
 * catches the dialogs and background imports that never reach an error
 * boundary as well. The error is left to propagate (no preventDefault): the
 * importer's own handling still runs, and the error boundary renders an
 * "updating" frame rather than a crash while the reload is under way.
 *
 * While a prefetch is in flight, the reload waits one task: the helper rejects
 * the import with the event's own payload, in microtasks straight after the
 * event, so by then loadAsPrefetch has marked it if the failure was its own.
 */
export const installStaleChunkRecovery = (
    target: Window = window,
    reload: () => void = () => window.location.reload(),
): (() => void) => {
    const onPreloadError = (event: Event) => {
        const payload = (event as Event & { payload?: unknown }).payload;
        // The helper only ever dispatches for a failed fetch; checking the
        // payload anyway keeps an unrelated error from reloading the page.
        if (payload !== undefined && !isChunkLoadError(payload)) {
            return;
        }
        if (prefetchesInFlight === 0) {
            reloadForStaleChunk(Date.now(), reload);
            return;
        }
        setTimeout(() => {
            if (payload !== null && typeof payload === 'object' && prefetchErrors.has(payload)) {
                return;
            }
            reloadForStaleChunk(Date.now(), reload);
        }, 0);
    };
    target.addEventListener('vite:preloadError', onPreloadError);
    return () => target.removeEventListener('vite:preloadError', onPreloadError);
};

/** Tests only: forget that a reload was started. */
export const resetStaleChunkStateForTests = (): void => {
    reloadPending = false;
    prefetchesInFlight = 0;
};
