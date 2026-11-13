import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    loadDemoScore: vi.fn<() => Promise<ArrayBuffer>>(),
    viewerImported: vi.fn(),
    pageImported: vi.fn(),
}));

vi.mock('@/features/demo/loadDemoScore', () => ({ loadDemoScore: h.loadDemoScore }));
vi.mock('@/features/demo/DemoViewer', () => {
    h.viewerImported();
    return { DemoViewer: () => null };
});
vi.mock('@/features/demo/DemoPage', () => {
    h.pageImported();
    return { DemoPage: () => null };
});

const setSaveData = (saveData: boolean | undefined) => {
    Object.defineProperty(navigator, 'connection', {
        configurable: true,
        value: saveData === undefined ? undefined : { saveData },
    });
};

beforeEach(() => {
    vi.resetModules();
    h.loadDemoScore.mockReset();
    h.viewerImported.mockReset();
    h.pageImported.mockReset();
    window.sessionStorage.clear();
});

afterEach(() => {
    setSaveData(undefined);
});

describe('preloadDemo', () => {
    it('does nothing when the browser asks to save data', async () => {
        setSaveData(true);
        const { preloadDemo } = await import('@/features/demo/demoPreload');

        await preloadDemo();

        expect(h.loadDemoScore).not.toHaveBeenCalled();
        expect(h.viewerImported).not.toHaveBeenCalled();
        expect(h.pageImported).not.toHaveBeenCalled();
    });

    it('starts the route chunk, the viewer chunk and the score', async () => {
        h.loadDemoScore.mockResolvedValue(new ArrayBuffer(8));
        const { preloadDemo, demoViewerModule } = await import('@/features/demo/demoPreload');

        await preloadDemo();

        expect(h.loadDemoScore).toHaveBeenCalledTimes(1);
        expect(h.viewerImported).toHaveBeenCalledTimes(1);
        expect(h.pageImported).toHaveBeenCalledTimes(1);
        expect(demoViewerModule.get()).not.toBeNull();
    });

    it('never rejects, whatever fails', async () => {
        h.loadDemoScore.mockRejectedValue(new TypeError('Failed to fetch'));
        const { preloadDemo, demoViewerModule } = await import('@/features/demo/demoPreload');
        vi.spyOn(demoViewerModule, 'load').mockRejectedValue(
            new TypeError('Failed to fetch dynamically imported module'),
        );

        await expect(preloadDemo()).resolves.toBeUndefined();
    });

    it('never rejects when reading the connection throws', async () => {
        Object.defineProperty(navigator, 'connection', {
            configurable: true,
            get: () => {
                throw new Error('blocked');
            },
        });
        const { preloadDemo } = await import('@/features/demo/demoPreload');

        await expect(preloadDemo()).resolves.toBeUndefined();
    });

    /**
     * What Vite's preload helper does when a chunk is gone (lib/staleChunk.test):
     * dispatch vite:preloadError on window with the error, then reject the
     * import with that same error.
     */
    const viteImport = (error: Error) => () =>
        Promise.resolve().then((): never => {
            window.dispatchEvent(
                Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload: error }),
            );
            throw error;
        });

    it('does not reload the page when a chunk it warms is from an older build', async () => {
        vi.useFakeTimers();
        h.loadDemoScore.mockResolvedValue(new ArrayBuffer(8));
        // Imported after resetModules, so the recovery shares demoPreload's
        // copy of lib/staleChunk, as it does in the app (main.tsx).
        const { installStaleChunkRecovery, resetStaleChunkStateForTests } = await import('@/lib/staleChunk');
        const { preloadDemo, demoChunks } = await import('@/features/demo/demoPreload');
        const stale = (name: string) =>
            new TypeError(`Failed to fetch dynamically imported module: https://cleffy.io/assets/${name}-Dk3l2Qa1.js`);
        const page = vi.spyOn(demoChunks, 'page').mockImplementation(viteImport(stale('DemoPage')));
        const viewer = vi.spyOn(demoChunks, 'viewer').mockImplementation(viteImport(stale('DemoViewer')));
        const reload = vi.fn();
        const uninstall = installStaleChunkRecovery(window, reload);
        try {
            await expect(preloadDemo()).resolves.toBeUndefined();
            await vi.runAllTimersAsync();

            expect(page).toHaveBeenCalledTimes(1);
            expect(viewer).toHaveBeenCalledTimes(1);
            expect(reload).not.toHaveBeenCalled();
        } finally {
            uninstall();
            resetStaleChunkStateForTests();
            vi.useRealTimers();
        }
    });
});
