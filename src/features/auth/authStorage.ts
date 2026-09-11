/**
 * Dual storage for the Supabase session.
 *
 * localStorage is still the in-app source of truth (Safari tab, desktop,
 * Android). iOS Home Screen web apps historically do **not** share that
 * partition with Safari, so a teacher who "Add to Home Screen"s while
 * signed in launches a fresh store and looks signed out.
 *
 * iOS 16.4+ Home Screen apps *do* share first-party cookies with Safari for
 * the same registrable domain. On every persist we also write a **compact**
 * restore cookie (refresh token only — no access JWT, no user object) so
 * the standalone app can recover and let GoTrue refresh.
 *
 * The cookie is JS-readable (`document.cookie`, not HttpOnly) because this
 * SPA has no server to set HttpOnly cookies. Same XSS surface as localStorage;
 * Secure + SameSite=Lax + Path=/ matches the rest of the HTTPS-only posture.
 */

export const AUTH_RESTORE_COOKIE = 'cleffy-auth-restore';

/** 60 days — long enough to outlast a typical refresh-token lifetime. */
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 60;

const SESSION_KEY_SUFFIX = '-auth-token';

export interface AuthStorageIo {
    getLocal: (key: string) => string | null;
    setLocal: (key: string, value: string) => void;
    removeLocal: (key: string) => void;
    readCookies: () => string;
    writeCookie: (line: string) => void;
    protocol: () => string;
}

const browserIo = (): AuthStorageIo => ({
    getLocal: (key) => {
        try {
            return globalThis.localStorage.getItem(key);
        } catch {
            return null;
        }
    },
    setLocal: (key, value) => {
        try {
            globalThis.localStorage.setItem(key, value);
        } catch {
            // Private mode / quota: cookie mirror is the remaining persist.
        }
    },
    removeLocal: (key) => {
        try {
            globalThis.localStorage.removeItem(key);
        } catch {
            // Same as setLocal — best-effort.
        }
    },
    readCookies: () => {
        try {
            return document.cookie;
        } catch {
            return '';
        }
    },
    writeCookie: (line) => {
        try {
            document.cookie = line;
        } catch {
            // Cookie jar disabled: in-app localStorage still works.
        }
    },
    protocol: () => {
        try {
            return location.protocol;
        } catch {
            return 'https:';
        }
    },
});

export const isAuthSessionKey = (key: string): boolean => key.endsWith(SESSION_KEY_SUFFIX);

/**
 * Strip the session down to what GoTrue needs to call refresh: a refresh
 * token, plus the keys `_isValidSession` checks. `expires_at: 0` forces a
 * refresh on recover so we never put an access JWT in the cookie.
 */
export const compactAuthSession = (value: string): string | null => {
    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object') {
            return null;
        }
        const refresh = (parsed as { refresh_token?: unknown }).refresh_token;
        if (typeof refresh !== 'string' || refresh.length === 0) {
            return null;
        }
        return JSON.stringify({
            access_token: '',
            refresh_token: refresh,
            expires_at: 0,
        });
    } catch {
        return null;
    }
};

export const cookieAttributeSuffix = (protocol: string): string => {
    const secure = protocol === 'https:' ? '; Secure' : '';
    return `; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SEC}${secure}`;
};

export const readNamedCookie = (cookieHeader: string, name: string): string | null => {
    const prefix = `${name}=`;
    for (const part of cookieHeader.split(';')) {
        const trimmed = part.trim();
        if (!trimmed.startsWith(prefix)) {
            continue;
        }
        try {
            return decodeURIComponent(trimmed.slice(prefix.length));
        } catch {
            return null;
        }
    }
    return null;
};

const writeRestoreCookie = (io: AuthStorageIo, compact: string): void => {
    io.writeCookie(`${AUTH_RESTORE_COOKIE}=${encodeURIComponent(compact)}${cookieAttributeSuffix(io.protocol())}`);
};

const clearRestoreCookie = (io: AuthStorageIo): void => {
    const secure = io.protocol() === 'https:' ? '; Secure' : '';
    io.writeCookie(`${AUTH_RESTORE_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0${secure}`);
};

/** Supabase `auth.storage` adapter: localStorage first, restore cookie as fallback. */
export const createAuthStorage = (io: AuthStorageIo = browserIo()) => ({
    getItem: (key: string): string | null => {
        const local = io.getLocal(key);
        if (local) {
            return local;
        }
        if (!isAuthSessionKey(key)) {
            return null;
        }
        return readNamedCookie(io.readCookies(), AUTH_RESTORE_COOKIE);
    },
    setItem: (key: string, value: string): void => {
        io.setLocal(key, value);
        if (!isAuthSessionKey(key)) {
            return;
        }
        const compact = compactAuthSession(value);
        if (compact) {
            writeRestoreCookie(io, compact);
        }
    },
    removeItem: (key: string): void => {
        io.removeLocal(key);
        if (isAuthSessionKey(key)) {
            clearRestoreCookie(io);
        }
    },
});
