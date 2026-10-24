/**
 * Browser zoom, on everywhere — the score viewer included.
 *
 * index.html used to ship `maximum-scale=1, user-scalable=no`, and later the
 * viewer re-applied it while a score was on screen, because it implements
 * pinch-zoom itself (GestureController) and a two-finger gesture that started
 * on its chrome would zoom the whole page instead of the score. Both stopped
 * people enlarging the page (WCAG 1.4.4), and iOS Safari ignores
 * `user-scalable=no` anyway.
 *
 * What keeps pinch on the score is touch-action, not the viewport: the score
 * surface (.ink-surface) is `touch-action: none`, so the browser never zooms
 * the page from there and hands the pointers to GestureController — and every
 * floating viewer control (toolbar, pager, zoom row, notices) sits inside that
 * surface, so it inherits the same none. A pinch on the header or transport
 * bar zooms the page, which is exactly what page zoom is for.
 */
export const VIEWPORT_ZOOMABLE = 'width=device-width, initial-scale=1.0, viewport-fit=cover';
