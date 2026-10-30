/**
 * Register the service worker (vite-plugin-pwa's generated /sw.js), at a time
 * that suits a first visit.
 *
 * Installing it precaches the whole app for offline use — every chunk, the
 * pdf.js worker and decoders, the fonts: about 6.5 MB, 2.6 MB compressed.
 * The plugin's own snippet registered at `load`, which on a first visit is the
 * moment the library starts fetching its covers and a teacher taps their first
 * score, so the precache competed with both for the connection. A page the
 * worker does not control yet (a first visit) therefore registers once things
 * have settled; a page it already controls registers at `load` as before,
 * which is only the browser's cheap check for a newer sw.js.
 */
const FIRST_VISIT_DELAY_MS = 8000;

type IdleWindow = Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
};

export const registerServiceWorker = (): void => {
    if (!import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
        return;
    }
    const register = () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err: unknown) => {
            console.warn('Could not register the service worker', err);
        });
    };
    const whenLoaded = (run: () => void) => {
        if (document.readyState === 'complete') {
            run();
        } else {
            window.addEventListener('load', run, { once: true });
        }
    };
    if (navigator.serviceWorker.controller) {
        whenLoaded(register);
        return;
    }
    whenLoaded(() => {
        setTimeout(() => {
            const idle = window as IdleWindow;
            if (typeof idle.requestIdleCallback === 'function') {
                idle.requestIdleCallback(register, { timeout: FIRST_VISIT_DELAY_MS });
            } else {
                register();
            }
        }, FIRST_VISIT_DELAY_MS);
    });
};
