import { expect } from 'vitest';

/**
 * The regex literals in a `navigateFallbackDenylist: [...]` (source or built
 * sw.js), as RegExps, so a URL can be tried against what actually ships.
 */
export const denylistOf = (text: string): RegExp[] => {
    const list = text.match(/navigateFallbackDenylist:\s*\[([^\]]*)\]/)?.[1] ?? '';
    return [...list.matchAll(/\/((?:\\.|[^/\\\n])+)\/([a-z]*)/g)].map((m) => new RegExp(m[1] ?? '', m[2]));
};

/** What Workbox's NavigationRoute tests a denylist against: pathname + search, never the fragment. */
export const navigationKey = (path: string): string => {
    const url = new URL(path, 'https://cleffy.test');
    return url.pathname + url.search;
};

const VIEWER_URLS = [
    '/v',
    '/v#' + 'T'.repeat(43),
    '/v?x=1',
    '/v?x=1#tok',
    '/v/',
    '/v/anything',
    '/view.html',
    '/view.html?x=1',
];
const APP_URLS = ['/', '/library', '/video', '/viewer', '/vault', '/join/abc', '/children-privacy'];

/** Every viewer and /api URL is denied the app shell; every app URL is not. */
export const expectDenylist = (text: string) => {
    const denylist = denylistOf(text);
    expect(denylist.length).toBeGreaterThanOrEqual(3);
    const denied = (path: string) => denylist.some((re) => re.test(navigationKey(path)));
    for (const path of VIEWER_URLS) {
        expect(denied(path), path).toBe(true);
    }
    for (const path of ['/api/view', '/api/view?x=1']) {
        expect(denied(path), path).toBe(true);
    }
    for (const path of APP_URLS) {
        expect(denied(path), path).toBe(false);
    }
};
