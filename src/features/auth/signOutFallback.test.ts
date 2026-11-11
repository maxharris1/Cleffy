import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_RESTORE_COOKIE, createAuthStorage, readNamedCookie } from '@/features/auth/authStorage';

/**
 * BL-5: sign-out must end the session on this device even when the server
 * cannot be told. These run the real supabase-js client over the app's own
 * storage adapter (jsdom localStorage + document.cookie) and fake only the
 * network, so "signed out" means what the next page load would find.
 */

const URL = 'http://127.0.0.1:54321';
const ANON = 'anon-key-for-tests';
const STORAGE_KEY = 'sb-127-auth-token';

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const network = vi.hoisted(() => ({ fetch: null as null | FetchImpl }));

const newClient = (): SupabaseClient =>
    createClient(URL, ANON, {
        auth: {
            persistSession: true,
            autoRefreshToken: false,
            detectSessionInUrl: false,
            storageKey: STORAGE_KEY,
            storage: createAuthStorage(),
        },
        global: { fetch: (input, init) => network.fetch!(input, init) },
    });

const live = vi.hoisted(() => ({ client: null as null | SupabaseClient }));
vi.mock('@/lib/supabase', () => ({ getSupabase: () => live.client }));

import { signOut } from '@/features/auth/session';

const nowSec = () => Math.floor(Date.now() / 1000);

const storeSession = (expiresAt: number) => {
    const session = {
        access_token: 'header.payload.signature',
        refresh_token: 'refresh-abc',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: expiresAt,
        user: { id: 'u-1', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: 'x' },
    };
    // Through the adapter, so the iOS restore cookie is written as in the app.
    createAuthStorage().setItem(STORAGE_KEY, JSON.stringify(session));
};

const restoreCookie = () => readNamedCookie(document.cookie, AUTH_RESTORE_COOKIE);

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** What a reload finds: a brand-new client reading the same storage. */
const sessionAfterReload = async () => (await newClient().auth.getSession()).data.session;

beforeEach(() => {
    localStorage.clear();
    document.cookie = `${AUTH_RESTORE_COOKIE}=; Path=/; Max-Age=0`;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    live.client = null;
    network.fetch = null;
});

describe('signOut when the server cannot be told', () => {
    it('offline with an expired token: forgets the session here and after a reload', async () => {
        // The refresh supabase-js attempts on the way fails, and it returns
        // { error } with the session still stored.
        network.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
        storeSession(nowSec() - 60);
        live.client = newClient();
        const events: string[] = [];
        live.client.auth.onAuthStateChange((event) => events.push(event));
        expect(restoreCookie()).not.toBeNull();

        // supabase-js retries an unreachable refresh with backoff for up to
        // 30 s before it gives up; let that time pass.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const done = signOut();
        await vi.advanceTimersByTimeAsync(31_000);
        vi.useRealTimers();
        await expect(done).resolves.toBeUndefined();

        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        expect(restoreCookie()).toBeNull();
        expect((await live.client.auth.getSession()).data.session).toBeNull();
        expect(events).toContain('SIGNED_OUT');
        expect(await sessionAfterReload()).toBeNull();
    });

    it('logout answers 503: forgets the session here and after a reload', async () => {
        const calls: string[] = [];
        network.fetch = (input) => {
            calls.push(String(input));
            return Promise.resolve(json(503, { code: 503, msg: 'Service Unavailable' }));
        };
        storeSession(nowSec() + 3600);
        live.client = newClient();
        expect((await live.client.auth.getSession()).data.session).not.toBeNull();

        await expect(signOut()).resolves.toBeUndefined();

        expect(calls.some((url) => url.includes('/auth/v1/logout'))).toBe(true);
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        expect(restoreCookie()).toBeNull();
        expect((await live.client.auth.getSession()).data.session).toBeNull();
        expect(await sessionAfterReload()).toBeNull();
    });

    it('auth.signOut throws: forgets the session without a second request', async () => {
        network.fetch = () => Promise.resolve(json(204, {}));
        storeSession(nowSec() + 3600);
        live.client = newClient();
        const real = live.client.auth.signOut.bind(live.client.auth);
        const spy = vi
            .spyOn(live.client.auth, 'signOut')
            .mockRejectedValueOnce(new Error('Acquiring an exclusive Navigator LockManager lock timed out'))
            .mockImplementation(real);
        const fetchSpy = vi.fn(network.fetch);
        network.fetch = fetchSpy;

        await expect(signOut()).resolves.toBeUndefined();

        expect(spy).toHaveBeenCalledTimes(2);
        // Storage was already empty for the second call, so it asked no one.
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
        expect(restoreCookie()).toBeNull();
        expect((await live.client.auth.getSession()).data.session).toBeNull();
        expect(await sessionAfterReload()).toBeNull();
    });

    it('a restore cookie alone does not sign the next load back in', async () => {
        // localStorage gone (an iOS Home Screen app's own partition) but the
        // cookie copy left behind would recover the session on reload.
        network.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
        storeSession(nowSec() - 60);
        localStorage.removeItem(STORAGE_KEY);
        live.client = newClient();

        await signOut();

        expect(restoreCookie()).toBeNull();
        expect(await sessionAfterReload()).toBeNull();
    });

    it('a server that answers still signs out normally, with one request', async () => {
        const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
        network.fetch = fetchSpy;
        storeSession(nowSec() + 3600);
        live.client = newClient();

        await signOut();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(console.warn).not.toHaveBeenCalledWith(
            expect.stringContaining('Sign-out could not reach the server'),
            expect.anything(),
        );
        expect(await sessionAfterReload()).toBeNull();
    });
});
