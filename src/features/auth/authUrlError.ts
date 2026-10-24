import { useSyncExternalStore } from 'react';

import { mapAuthError } from '@/features/auth/authErrors';

/**
 * An email link the auth server refused, as it reports it: by redirecting to
 * the link's `redirect_to` with the reason in the URL —
 * `#error=access_denied&error_code=otp_expired&error_description=…` for the
 * implicit flow, the same keys in the query string for PKCE.
 *
 * Only /auth/callback and /student/welcome used to look. A password-reset link
 * redirects to /update-password, whose RequireRegistered gate bounced the
 * visitor to /login before anything read the fragment — so an expired or
 * already-used reset link landed on a blank sign-in form with no word about
 * why. The error is now read once at startup, from whatever page the link
 * landed on, and held here for AuthLinkErrorNotice to show; the redirect that
 * follows cannot take it away.
 */
export interface AuthUrlError {
    /** GoTrue's machine code (`otp_expired`, …), when it sent one. */
    code: string | null;
    /** GoTrue's own sentence; mapped to product copy, never shown raw. */
    description: string | null;
    /** The page the link redirected to — /update-password for a reset link. */
    path: string;
}

/** Pages that read the error themselves and show it in their own words. */
const PAGES_WITH_OWN_HANDLING = ['/auth/callback', '/student/welcome'];

const ERROR_KEYS = ['error', 'error_code', 'error_description'] as const;

interface UrlParts {
    pathname: string;
    search: string;
    hash: string;
}

/**
 * The auth error in `url`, or null. Keyed on `error_code` / `error_description`,
 * which GoTrue always sends and nothing else in the app uses: a bare `?error=`
 * is too common a name to claim for auth.
 */
export const parseAuthUrlError = (url: UrlParts): AuthUrlError | null => {
    for (const params of [
        new URLSearchParams(url.hash.replace(/^#/, '')),
        new URLSearchParams(url.search.replace(/^\?/, '')),
    ]) {
        const code = params.get('error_code');
        const description = params.get('error_description');
        if (code || description) {
            return {
                code: code || null,
                description: description ? description.replace(/\+/g, ' ') : null,
                path: url.pathname,
            };
        }
    }
    return null;
};

/**
 * `url` as a path without the auth error keys (other parameters kept), or null
 * when there were none. A part that carries no error key is kept exactly as it
 * was: re-serialising it would turn an anchor like `#section` into `#section=`.
 */
export const withoutAuthErrorParams = (url: UrlParts): string | null => {
    const strip = (raw: string): string | null => {
        const params = new URLSearchParams(raw);
        if (!ERROR_KEYS.some((key) => params.has(key))) {
            return null;
        }
        for (const key of ERROR_KEYS) {
            params.delete(key);
        }
        return params.toString();
    };
    const hash = url.hash.replace(/^#/, '');
    const search = url.search.replace(/^\?/, '');
    const cleanHash = strip(hash);
    const cleanSearch = strip(search);
    if (cleanHash === null && cleanSearch === null) {
        return null;
    }
    const nextHash = cleanHash ?? hash;
    const nextSearch = cleanSearch ?? search;
    return `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${nextHash ? `#${nextHash}` : ''}`;
};

let captured: AuthUrlError | null = null;
const listeners = new Set<() => void>();

const notify = () => {
    for (const listener of listeners) {
        listener();
    }
};

/**
 * Read an auth error out of the address bar, keep it for the notice, and take
 * it out of the URL so a reload or a bookmark does not show it again. Called
 * once from main.tsx before the first render, and before the Supabase client
 * reads the URL — which then has no error to log.
 */
export const captureAuthUrlError = (
    location: UrlParts = window.location,
    history: Pick<History, 'replaceState' | 'state'> = window.history,
): AuthUrlError | null => {
    if (PAGES_WITH_OWN_HANDLING.includes(location.pathname)) {
        return null;
    }
    const error = parseAuthUrlError(location);
    if (!error) {
        return null;
    }
    const clean = withoutAuthErrorParams(location);
    if (clean !== null) {
        try {
            history.replaceState(history.state, '', clean);
        } catch {
            // A URL we cannot rewrite still gets the notice.
        }
    }
    captured = error;
    notify();
    return error;
};

export const dismissAuthUrlError = (): void => {
    captured = null;
    notify();
};

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/** The captured auth error, until dismissed. */
export const useAuthUrlError = (): AuthUrlError | null => useSyncExternalStore(subscribe, () => captured);

const EXPIRED_TITLE = 'This reset link has expired or was already used';
const EXPIRED_BODY =
    'Each link works once, for a limited time. Request a new one and open the newest email we send you.';

/**
 * What the notice says. Almost every email link that can fail outside the two
 * pages above is a password reset (sign-up confirmations land on
 * /auth/callback, student invites on /student/welcome), and GoTrue answers an
 * expired and an already-used link alike, with `otp_expired`.
 */
export const authUrlErrorCopy = (error: AuthUrlError): { title: string; body: string } => {
    if (error.code === 'otp_expired' || error.path === '/update-password') {
        return { title: EXPIRED_TITLE, body: EXPIRED_BODY };
    }
    return {
        title: 'That link didn’t work',
        body: mapAuthError(error.description ?? '', 'The link could not be used. Request a new one and try again.'),
    };
};

/** Tests only. */
export const resetAuthUrlErrorForTests = (): void => {
    captured = null;
    listeners.clear();
};
