import { afterEach, describe, expect, it } from 'vitest';

import {
    AUTH_RESTORE_COOKIE,
    compactAuthSession,
    cookieAttributeSuffix,
    createAuthStorage,
    isAuthSessionKey,
    readNamedCookie,
    type AuthStorageIo,
} from '@/features/auth/authStorage';

const SESSION_KEY = 'sb-example-auth-token';
const FULL_SESSION = JSON.stringify({
    access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
    refresh_token: 'refresh-xyz',
    expires_at: 1_800_000_000,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: 'user-1', email: 'teacher@cleffy.local' },
});

const memoryIo = (protocol = 'https:'): AuthStorageIo & { local: Map<string, string>; cookies: string } => {
    const local = new Map<string, string>();
    const jar: { cookies: string } = { cookies: '' };
    const io: AuthStorageIo & { local: Map<string, string>; cookies: string } = {
        local,
        get cookies() {
            return jar.cookies;
        },
        set cookies(value: string) {
            jar.cookies = value;
        },
        getLocal: (key) => local.get(key) ?? null,
        setLocal: (key, value) => {
            local.set(key, value);
        },
        removeLocal: (key) => {
            local.delete(key);
        },
        readCookies: () => jar.cookies,
        writeCookie: (line) => {
            const [pair] = line.split(';');
            if (!pair) {
                return;
            }
            const eq = pair.indexOf('=');
            if (eq < 0) {
                return;
            }
            const name = pair.slice(0, eq).trim();
            const expired = /max-age=0/i.test(line);
            const parts = jar.cookies
                .split(';')
                .map((part) => part.trim())
                .filter((part) => part.length > 0 && !part.startsWith(`${name}=`));
            if (!expired) {
                parts.push(`${name}=${pair.slice(eq + 1)}`);
            }
            jar.cookies = parts.join('; ');
        },
        protocol: () => protocol,
    };
    return io;
};

afterEach(() => {
    // Keep jsdom's cookie jar from leaking between document.cookie tests below.
    document.cookie.split(';').forEach((part) => {
        const name = part.split('=')[0]?.trim();
        if (name) {
            document.cookie = `${name}=; Path=/; Max-Age=0`;
        }
    });
});

describe('compactAuthSession', () => {
    it('keeps only the refresh token and forces an expired access token', () => {
        const compact = compactAuthSession(FULL_SESSION);
        expect(compact).not.toBeNull();
        const parsed = JSON.parse(compact as string) as {
            access_token: string;
            refresh_token: string;
            expires_at: number;
        };
        expect(parsed).toEqual({
            access_token: '',
            refresh_token: 'refresh-xyz',
            expires_at: 0,
        });
        expect(compact).not.toContain('eyJ');
        expect(compact).not.toContain('teacher@cleffy.local');
    });

    it('returns null for garbage or a session without a refresh token', () => {
        expect(compactAuthSession('not-json')).toBeNull();
        expect(compactAuthSession(JSON.stringify({ access_token: 'a' }))).toBeNull();
        expect(compactAuthSession(JSON.stringify({ refresh_token: '' }))).toBeNull();
    });
});

describe('cookie helpers', () => {
    it('marks HTTPS cookies Secure and http cookies not', () => {
        expect(cookieAttributeSuffix('https:')).toContain('Secure');
        expect(cookieAttributeSuffix('https:')).toContain('Path=/');
        expect(cookieAttributeSuffix('https:')).toContain('SameSite=Lax');
        expect(cookieAttributeSuffix('http:')).not.toContain('Secure');
    });

    it('reads a named cookie out of a header', () => {
        expect(readNamedCookie(`${AUTH_RESTORE_COOKIE}=abc; other=1`, AUTH_RESTORE_COOKIE)).toBe('abc');
        expect(readNamedCookie('other=1', AUTH_RESTORE_COOKIE)).toBeNull();
    });

    it('recognizes the GoTrue session key and ignores verifier/user suffixes', () => {
        expect(isAuthSessionKey(SESSION_KEY)).toBe(true);
        expect(isAuthSessionKey(`${SESSION_KEY}-code-verifier`)).toBe(false);
        expect(isAuthSessionKey(`${SESSION_KEY}-user`)).toBe(false);
    });
});

describe('createAuthStorage', () => {
    it('round-trips through the restore cookie after localStorage is emptied', () => {
        const io = memoryIo();
        const storage = createAuthStorage(io);

        storage.setItem(SESSION_KEY, FULL_SESSION);
        expect(io.local.get(SESSION_KEY)).toBe(FULL_SESSION);
        expect(io.cookies).toContain(AUTH_RESTORE_COOKIE);
        expect(io.cookies).not.toContain('eyJ');

        io.local.clear();
        const restored = storage.getItem(SESSION_KEY);
        expect(restored).toBe(compactAuthSession(FULL_SESSION));
        expect(JSON.parse(restored as string)).toMatchObject({
            refresh_token: 'refresh-xyz',
            access_token: '',
            expires_at: 0,
        });
    });

    it('prefers localStorage when both stores have a value', () => {
        const io = memoryIo();
        const storage = createAuthStorage(io);
        storage.setItem(SESSION_KEY, FULL_SESSION);
        expect(storage.getItem(SESSION_KEY)).toBe(FULL_SESSION);
    });

    it('does not feed the restore cookie to PKCE keys', () => {
        const io = memoryIo();
        const storage = createAuthStorage(io);
        storage.setItem(SESSION_KEY, FULL_SESSION);
        io.local.clear();
        expect(storage.getItem(`${SESSION_KEY}-code-verifier`)).toBeNull();
    });

    it('clears the restore cookie on removeItem', () => {
        const io = memoryIo();
        const storage = createAuthStorage(io);
        storage.setItem(SESSION_KEY, FULL_SESSION);
        storage.removeItem(SESSION_KEY);
        expect(io.local.get(SESSION_KEY)).toBeUndefined();
        expect(readNamedCookie(io.cookies, AUTH_RESTORE_COOKIE)).toBeNull();
    });

    it('writes Secure cookies on https via document.cookie', () => {
        const storage = createAuthStorage();
        storage.setItem(SESSION_KEY, FULL_SESSION);
        // jsdom records the name/value; attributes are applied on write.
        expect(document.cookie).toContain(AUTH_RESTORE_COOKIE);
        const compact = compactAuthSession(FULL_SESSION);
        expect(readNamedCookie(document.cookie, AUTH_RESTORE_COOKIE)).toBe(compact);
        storage.removeItem(SESSION_KEY);
        expect(readNamedCookie(document.cookie, AUTH_RESTORE_COOKIE)).toBeNull();
    });
});
