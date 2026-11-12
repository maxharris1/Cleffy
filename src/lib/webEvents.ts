import { useEffect } from 'react';
import { useLocation } from 'react-router';

import { routePatternOf } from '@/app/routePatterns';
import { readAttribution, UTM_KEYS, type UtmTags } from '@/lib/attribution';
import { getSupabase, isSupabaseConfigured, supabaseConfig } from '@/lib/supabase';
import type { WebEventInput } from '@/types/database';

/**
 * First-party web events: page views and a few funnel actions, batched to
 * public.record_web_events (20261112120000_web_events.sql) in our own
 * database. No IP address, no user agent, no third-party tracker; the server
 * adds the account id itself, and only for a signed-in teacher.
 *
 * Nothing is recorded, here or (independently) on the server, for a roster
 * student or a guest, nor on the invite, auth and student pages. Until the
 * session is known, events wait: a tab that turns out to be a student's
 * sends nothing at all.
 *
 * Inert until installWebEvents() runs, which only main.tsx calls: tests and a
 * build with no backend send nothing.
 */

type WebEvent = WebEventInput;

export type WebEventName = WebEvent['event'];

type DeviceClass = NonNullable<WebEvent['device_class']>;

/** sessionStorage: this tab's random key. */
export const WEB_SESSION_STORAGE_KEY = 'cleffy:web-session';

export const FLUSH_DELAY_MS = 5_000;

/** The server's limit per call. */
export const MAX_BATCH = 20;

/** Events held while the session is unknown or the network is down; the oldest go first. */
const MAX_QUEUE = 100;

/** Invite links, auth callbacks, short links and every student surface. */
const EXCLUDED_PREFIXES = ['/join', '/auth', '/v', '/student', '/assignments'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HOST = /^[a-z0-9.-]{1,253}$/;

/** The part of a Supabase session this module reads. */
interface SessionLike {
    access_token?: string;
    user: { is_anonymous?: boolean; app_metadata?: Record<string, unknown> };
}

let installed = false;
/** counted: a visitor or a registered account. excluded: a roster student or a guest. */
let audience: 'unknown' | 'counted' | 'excluded' = 'unknown';
let accessToken: string | null = null;
let queue: WebEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let tabKey: string | null = null;
let lastPageView: string | null = null;
let unsubscribe: (() => void) | null = null;

/** The same flags userTypeOf() and isRegisteredSession() read. */
const isExcludedSession = (session: SessionLike | null): boolean =>
    Boolean(session && (session.user.is_anonymous || session.user.app_metadata?.['user_type'] === 'student'));

const isExcludedPath = (pathname: string): boolean =>
    EXCLUDED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

const sessionKey = (): string => {
    if (tabKey) {
        return tabKey;
    }
    try {
        const stored = window.sessionStorage.getItem(WEB_SESSION_STORAGE_KEY);
        if (stored && UUID.test(stored)) {
            tabKey = stored;
            return stored;
        }
    } catch {
        // Unreadable storage: a key for this page load.
    }
    tabKey = crypto.randomUUID();
    try {
        window.sessionStorage.setItem(WEB_SESSION_STORAGE_KEY, tabKey);
    } catch {
        // Kept in memory only.
    }
    return tabKey;
};

const matches = (query: string): boolean => typeof window.matchMedia === 'function' && window.matchMedia(query).matches;

/** From the pointer and the screen's short side, never the user agent. */
const deviceClass = (): DeviceClass => {
    if (!matches('(pointer: coarse)')) {
        return 'desktop';
    }
    return matches('(min-width: 600px) and (min-height: 600px)') ? 'tablet' : 'mobile';
};

/** The referring site's host name, or nothing for none or for this site. */
const referrerHost = (): string | null => {
    try {
        if (!document.referrer) {
            return null;
        }
        const host = new URL(document.referrer).hostname.toLowerCase();
        return host && host !== window.location.hostname.toLowerCase() && HOST.test(host) ? host : null;
    } catch {
        return null;
    }
};

const buildEvent = (event: WebEventName, pathname: string): WebEvent => {
    const attribution = readAttribution();
    const tags: UtmTags = {};
    for (const key of UTM_KEYS) {
        const value = attribution?.[key];
        if (value) {
            tags[key] = value;
        }
    }
    const referrer = referrerHost();
    return {
        event,
        path: routePatternOf(pathname),
        session_key: sessionKey(),
        device_class: deviceClass(),
        ...(referrer ? { referrer_host: referrer } : {}),
        ...tags,
    };
};

const clearTimer = (): void => {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
};

const schedule = (): void => {
    if (timer) {
        return;
    }
    timer = setTimeout(() => {
        timer = null;
        void flushWebEvents();
    }, FLUSH_DELAY_MS);
};

/** A page being put away cannot wait for supabase-js: one keepalive request per batch. */
const sendKeepalive = (batch: WebEvent[]): void => {
    const { url, anonKey } = supabaseConfig();
    if (!url || !anonKey) {
        return;
    }
    fetch(`${url}/rest/v1/rpc/record_web_events`, {
        method: 'POST',
        keepalive: true,
        headers: {
            apikey: anonKey,
            Authorization: `Bearer ${accessToken ?? anonKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_events: batch }),
    }).catch(() => undefined);
};

/**
 * Send what is queued: one batch now (and the rest on the next tick of the
 * timer), or everything at once with keepalive when the page is going away.
 * A failed send is dropped, not retried: these are counts, not records anyone
 * relies on.
 */
export const flushWebEvents = async ({ keepalive = false }: { keepalive?: boolean } = {}): Promise<void> => {
    if (audience !== 'counted') {
        if (audience === 'excluded') {
            queue = [];
        }
        return;
    }
    if (keepalive) {
        clearTimer();
        while (queue.length > 0) {
            sendKeepalive(queue.splice(0, MAX_BATCH));
        }
        return;
    }
    const batch = queue.splice(0, MAX_BATCH);
    if (queue.length > 0) {
        schedule();
    }
    if (batch.length === 0) {
        return;
    }
    try {
        await getSupabase().rpc('record_web_events', { p_events: batch });
    } catch {
        // Offline or refused: dropped.
    }
};

const noteSession = (session: SessionLike | null): void => {
    accessToken = session?.access_token ?? null;
    if (isExcludedSession(session)) {
        audience = 'excluded';
        queue = [];
        clearTimer();
        return;
    }
    audience = 'counted';
    if (queue.length > 0) {
        schedule();
    }
};

const onPageHide = (): void => {
    void flushWebEvents({ keepalive: true });
};

/** Called once from main.tsx. */
export const installWebEvents = (): void => {
    if (installed || !isSupabaseConfigured()) {
        return;
    }
    installed = true;
    const { data } = getSupabase().auth.onAuthStateChange((_event, session) => noteSession(session));
    unsubscribe = () => data.subscription.unsubscribe();
    window.addEventListener('pagehide', onPageHide);
};

/** Record an event on this page (by default the current one). */
export const track = (event: WebEventName, pathname: string = window.location.pathname): void => {
    if (!installed || audience === 'excluded' || isExcludedPath(pathname)) {
        return;
    }
    queue.push(buildEvent(event, pathname));
    if (queue.length > MAX_QUEUE) {
        queue.splice(0, queue.length - MAX_QUEUE);
    }
    if (audience === 'counted' && queue.length >= MAX_BATCH) {
        void flushWebEvents();
        return;
    }
    schedule();
};

/** A page_view per route change. Mounted once, inside the router (App.tsx). */
export const useTrackPageViews = (): void => {
    const { pathname } = useLocation();
    useEffect(() => {
        // StrictMode runs this twice on mount; a route change always changes the path.
        if (pathname === lastPageView) {
            return;
        }
        lastPageView = pathname;
        track('page_view', pathname);
    }, [pathname]);
};

export const resetWebEventsForTests = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    window.removeEventListener('pagehide', onPageHide);
    clearTimer();
    installed = false;
    audience = 'unknown';
    accessToken = null;
    queue = [];
    tabKey = null;
    lastPageView = null;
};
