/**
 * The demo score's constants. A leaf with no imports on purpose: vite.config.ts
 * reads the service worker's cache pattern from here, and the config is
 * bundled without the app's `@/` alias.
 */

/** The demo's score: Für Elise, a US public-domain edition, served from public/demo. */
export const DEMO_PDF_URL = '/demo/fur-elise.pdf';

/**
 * Fixed rather than content-hashed (localDocId), so ink a visitor kept always
 * finds its score, and a non-UUID so isCloudDocId is false and the viewer
 * treats it as a local doc: no sync, nothing leaves the device.
 *
 * Bump the version suffix whenever the PDF changes. Ink is keyed by this id
 * and placed by page coordinates, so marks kept from an old edition would land
 * on the wrong bars of a new one.
 */
export const DEMO_DOC_ID = 'local-demo-v1';

export const DEMO_TITLE = 'Für Elise — demo';

/**
 * What is actually requested: the file, versioned by the doc id. The service
 * worker keeps the demo score CacheFirst (vite.config.ts), so the same URL
 * would serve an old edition forever; bumping DEMO_DOC_ID busts that cache
 * along with the ink.
 */
export const DEMO_PDF_REQUEST_URL = `${DEMO_PDF_URL}?v=${DEMO_DOC_ID}`;

/** The service worker's runtime-cache route for the demo score, query string and all. */
export const DEMO_SCORE_CACHE_PATTERN = /\/demo\/[^/?]+\.pdf(?:\?|$)/;
