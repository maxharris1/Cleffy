/**
 * A share-link visit (/s, /join/…): the visitor may be a signed-out viewer
 * whom nothing may be kept about, so boot skips the campaign-tag capture and
 * the service worker there.
 */
export const isLinkSessionPath = (pathname: string): boolean =>
    pathname === '/s' || pathname === '/s/' || pathname.startsWith('/join/');
