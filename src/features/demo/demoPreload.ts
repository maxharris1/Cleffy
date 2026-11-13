import { loadDemoScore } from '@/features/demo/loadDemoScore';
import { lazyModule } from '@/ui/lazyModule';

/**
 * The viewer (pdf.js, the ink stack, Dexie) is its own chunk. One instance,
 * shared by DemoPage, which requests it the moment /try mounts, and by the
 * landing page, which warms it when a visitor reaches for the demo. A
 * lazyModule rather than React.lazy, so a failed import shows the demo's own
 * error state rather than the app's crash screen.
 */
export const demoViewerModule = lazyModule(() => import('@/features/demo/DemoViewer'));

/** Visitors who asked their browser to save data get nothing they did not click for. */
const savesData = (): boolean =>
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

/**
 * Start fetching what /try needs: its route chunk, the viewer chunk and the
 * score. Called on intent (a pointer entering, focus or a touch on a link to
 * /try), never on page load. Every failure is dropped: a failed import is
 * remembered by the browser for the life of the page, and DemoPage shows its
 * own error state for that when the visitor arrives. Always resolves.
 */
export const preloadDemo = async (): Promise<void> => {
    try {
        if (savesData()) {
            return;
        }
        await Promise.allSettled([import('@/features/demo/DemoPage'), demoViewerModule.load(), loadDemoScore()]);
    } catch {
        // Nothing to report: this is a head start, not the load itself.
    }
};
