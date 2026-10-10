import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    canReloadForStaleChunk,
    installStaleChunkRecovery,
    isChunkLoadError,
    isStaleChunkReloadPending,
    reloadForStaleChunk,
    resetStaleChunkStateForTests,
    STALE_CHUNK_RELOAD_WINDOW_MS,
} from '@/lib/staleChunk';

const T0 = 1_760_000_000_000;

const chromeChunkError = () =>
    new TypeError('Failed to fetch dynamically imported module: https://dev.cleffy.io/assets/AccountPage-Dk3l2Qa1.js');

describe('isChunkLoadError', () => {
    it('recognises a missing chunk in every engine, and the preload helper’s CSS failure', () => {
        expect(isChunkLoadError(chromeChunkError())).toBe(true);
        expect(
            isChunkLoadError(new TypeError('error loading dynamically imported module: https://x/assets/a.js')),
        ).toBe(true);
        expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
        expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/PricingDialog-x.css'))).toBe(true);
        expect(isChunkLoadError(Object.assign(new Error('Loading chunk 7 failed.'), { name: 'ChunkLoadError' }))).toBe(
            true,
        );
    });

    it('leaves every other error to the crash screen', () => {
        expect(isChunkLoadError(new Error("Cannot destructure property 'basename' of 'useContext(...)'"))).toBe(false);
        expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false);
        expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
        expect(isChunkLoadError(null)).toBe(false);
    });
});

describe('reloadForStaleChunk', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        resetStaleChunkStateForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetStaleChunkStateForTests();
    });

    it('reloads once, then refuses a second time inside the window instead of looping', () => {
        const reload = vi.fn();
        expect(reloadForStaleChunk(T0, reload)).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(isStaleChunkReloadPending()).toBe(true);

        // The page that loads after that reload starts with fresh memory.
        resetStaleChunkStateForTests();
        expect(canReloadForStaleChunk(T0 + 5_000)).toBe(false);
        expect(reloadForStaleChunk(T0 + 5_000, reload)).toBe(false);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('recovers again from the next deploy, once the window has passed', () => {
        const reload = vi.fn();
        reloadForStaleChunk(T0, reload);
        resetStaleChunkStateForTests();
        expect(reloadForStaleChunk(T0 + STALE_CHUNK_RELOAD_WINDOW_MS, reload)).toBe(true);
        expect(reload).toHaveBeenCalledTimes(2);
    });

    it('a second failure while the reload is already under way does not reload twice', () => {
        const reload = vi.fn();
        expect(reloadForStaleChunk(T0, reload)).toBe(true);
        expect(reloadForStaleChunk(T0 + 1, reload)).toBe(true);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('does not reload while offline: the chunk is missing because the network is', () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const reload = vi.fn();
        expect(reloadForStaleChunk(T0, reload)).toBe(false);
        expect(reload).not.toHaveBeenCalled();
    });

    it('does not reload when the guard cannot be stored, since a loop could not be detected', () => {
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('quota', 'QuotaExceededError');
        });
        const reload = vi.fn();
        expect(reloadForStaleChunk(T0, reload)).toBe(false);
        expect(reload).not.toHaveBeenCalled();
        expect(isStaleChunkReloadPending()).toBe(false);
    });
});

describe('installStaleChunkRecovery', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        resetStaleChunkStateForTests();
    });

    afterEach(() => {
        resetStaleChunkStateForTests();
    });

    const preloadError = (payload: unknown) =>
        Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload });

    it('reloads on Vite’s preload error for a missing chunk, and leaves the error to propagate', () => {
        const reload = vi.fn();
        const uninstall = installStaleChunkRecovery(window, reload);
        const event = preloadError(chromeChunkError());
        window.dispatchEvent(event);
        uninstall();

        expect(reload).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(false);
    });

    it('ignores a preload event carrying some other error', () => {
        const reload = vi.fn();
        const uninstall = installStaleChunkRecovery(window, reload);
        window.dispatchEvent(preloadError(new Error('something else')));
        uninstall();
        expect(reload).not.toHaveBeenCalled();
    });
});
