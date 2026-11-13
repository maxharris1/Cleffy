/**
 * A view link's token: 32 random bytes, base64url, 43 characters
 * (20261112130000_view_links.sql). The same pattern is in api/view.ts and
 * supabase/functions/_shared/viewLink.ts (tests/viewLinks/viewLinkConfig.test.ts
 * keeps the three equal).
 *
 * The token travels in the URL fragment (`/v#<token>`): browsers never send a
 * fragment to the server, so it is in no request line, server log or Referer.
 */
export const VIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const isViewToken = (value: unknown): value is string =>
    typeof value === 'string' && VIEW_TOKEN_PATTERN.test(value);

/** The token in `location.hash`, or null when there is none or it is malformed. */
export const tokenFromHash = (hash: string): string | null => {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    return isViewToken(raw) ? raw : null;
};

/** The link a teacher copies: `https://<host>/v#<token>`. */
export const viewLinkUrl = (origin: string, token: string): string => `${origin}/v#${token}`;
