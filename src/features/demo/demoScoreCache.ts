/**
 * The service worker's runtime-cache rule for the demo score (vite.config.ts).
 * Kept here, with no imports, so the config can read it and demoScore.test.ts
 * can check it against the URL the demo actually requests: a pattern that
 * stopped matching `?v=<doc id>` would quietly drop offline support.
 *
 * PDFs under /demo/ only, query or not, and nothing else: vercel.json answers
 * every other path with index.html.
 */
export const DEMO_SCORE_URL_PATTERN = /\/demo\/[^/?]+\.pdf(?:\?|$)/;
