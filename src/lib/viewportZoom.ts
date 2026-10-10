import { useEffect } from 'react';

/**
 * Browser zoom, on everywhere except over the score.
 *
 * index.html used to ship `maximum-scale=1, user-scalable=no` for the whole
 * app, which stops anyone from enlarging the sign-in form, the library or the
 * pricing dialog (WCAG 1.4.4). Only the viewer has a reason for it: it
 * implements pinch-zoom itself (GestureController), and a two-finger gesture
 * that starts on its floating controls — page counter, zoom buttons, toolbar —
 * rather than on the `touch-action: none` surface would otherwise zoom the
 * whole page instead of the score. So the page is zoomable by default, and
 * PdfViewport locks it only while a score is on screen; leaving the viewer
 * gives zoom back. (iOS Safari ignores `user-scalable=no` either way; it is
 * the surface's touch-action and gesture handling that keep pinch on the score
 * there.)
 */
export const VIEWPORT_ZOOMABLE = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
export const VIEWPORT_ZOOM_LOCKED =
    'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';

/** Mounted viewers holding the lock (StrictMode and a viewer replacing a viewer overlap). */
let holders = 0;

const viewportMeta = (): HTMLMetaElement | null => document.querySelector('meta[name="viewport"]');

/** Lock page zoom while the calling component is mounted. */
export const useLockedPageZoom = (): void => {
    useEffect(() => {
        const meta = viewportMeta();
        if (!meta) {
            return;
        }
        holders += 1;
        meta.setAttribute('content', VIEWPORT_ZOOM_LOCKED);
        return () => {
            holders = Math.max(0, holders - 1);
            if (holders === 0) {
                meta.setAttribute('content', VIEWPORT_ZOOMABLE);
            }
        };
    }, []);
};
