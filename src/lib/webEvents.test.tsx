import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureAttribution, resetAttributionForTests } from '@/lib/attribution';
import {
    FLUSH_DELAY_MS,
    MAX_BATCH,
    WEB_SESSION_STORAGE_KEY,
    flushWebEvents,
    installWebEvents,
    resetWebEventsForTests,
    track,
    useTrackPageViews,
} from '@/lib/webEvents';

type Listener = (event: string, session: unknown) => void;

const sb = vi.hoisted(() => ({
    rpc: vi.fn(),
    listener: null as Listener | null,
}));

vi.mock('@/lib/supabase', () => ({
    isSupabaseConfigured: () => true,
    supabaseConfig: () => ({ url: 'https://sb.test', anonKey: 'anon-key' }),
    getSupabase: () => ({
        rpc: sb.rpc,
        auth: {
            onAuthStateChange: (cb: Listener) => {
                sb.listener = cb;
                return { data: { subscription: { unsubscribe: () => undefined } } };
            },
        },
    }),
}));

const teacher = {
    access_token: 'teacher-token',
    user: { id: 'teacher-1', is_anonymous: false, app_metadata: { provider: 'email' } },
};
const student = {
    access_token: 'student-token',
    user: { id: 'student-1', is_anonymous: false, app_metadata: { provider: 'email', user_type: 'student' } },
};
const guest = {
    access_token: 'guest-token',
    user: { id: 'guest-1', is_anonymous: true, app_metadata: { provider: 'anonymous' } },
};

/** The session the app starts with, as supabase-js reports it. */
const startWith = (session: unknown) => {
    installWebEvents();
    act(() => sb.listener!('INITIAL_SESSION', session));
};

type SentEvent = Record<string, unknown>;
const sentBatches = (): SentEvent[][] =>
    sb.rpc.mock.calls.map((call) => {
        const [name, args] = call as [string, { p_events: SentEvent[] }];
        expect(name).toBe('record_web_events');
        return args.p_events;
    });
const sent = (): SentEvent[] => sentBatches().flat();

const mockMedia = (matches: Record<string, boolean>) => {
    window.matchMedia = vi.fn((query: string) => ({
        matches: matches[query] ?? false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
};

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(Date.parse('2026-11-12T10:00:00.000Z'));
    sb.rpc.mockReset();
    sb.rpc.mockResolvedValue({ data: null, error: null });
    sb.listener = null;
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetAttributionForTests();
    resetWebEventsForTests();
    mockMedia({});
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.matchMedia = originalMatchMedia;
});

describe('track', () => {
    it('does nothing until installWebEvents has run (tests, and builds with no backend)', async () => {
        track('demo_visit', '/try');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 2);
        expect(sb.rpc).not.toHaveBeenCalled();
    });

    it('sends a registered teacher’s event after the batching delay, with the first-touch tags', async () => {
        captureAttribution({ pathname: '/try', search: '?utm_campaign=launch_v1&utm_content=hero_a' });
        startWith(teacher);

        track('demo_visit', '/try');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS - 1);
        expect(sb.rpc).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(sent()).toEqual([
            {
                event: 'demo_visit',
                path: '/try',
                session_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
                device_class: 'desktop',
                utm_campaign: 'launch_v1',
                utm_content: 'hero_a',
            },
        ]);
        expect(sent()[0]!['session_key']).toBe(window.sessionStorage.getItem(WEB_SESSION_STORAGE_KEY));
    });

    it('sends at most 20 a call: a full batch at once, the rest after the delay', async () => {
        startWith(null);
        for (let i = 0; i < MAX_BATCH + 5; i += 1) {
            track('page_view', '/');
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(sentBatches().map((b) => b.length)).toEqual([MAX_BATCH]);

        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        expect(sentBatches().map((b) => b.length)).toEqual([MAX_BATCH, 5]);
        expect(new Set(sent().map((e) => e['session_key'])).size).toBe(1);
    });

    it('holds events until the session is known, then sends them', async () => {
        installWebEvents();
        track('demo_visit', '/try');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 2);
        expect(sb.rpc).not.toHaveBeenCalled();

        act(() => sb.listener!('INITIAL_SESSION', null));
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        expect(sent()).toHaveLength(1);
    });

    it.each([
        ['a roster student', student],
        ['a guest', guest],
    ])('sends nothing for %s', async (_name, session) => {
        startWith(session);
        track('demo_visit', '/try');
        track('page_view', '/library');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 2);
        await flushWebEvents({ keepalive: true });
        expect(sb.rpc).not.toHaveBeenCalled();
    });

    it('drops what was queued when a student signs in before it is sent', async () => {
        startWith(null);
        track('page_view', '/');
        act(() => sb.listener!('SIGNED_IN', student));
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 2);
        expect(sb.rpc).not.toHaveBeenCalled();
    });

    it.each([
        '/join/abc123',
        '/auth/callback',
        '/v',
        '/v/abc',
        '/student',
        '/student/claim',
        '/student/welcome',
        '/assignments',
    ])('sends nothing on %s', async (path) => {
        startWith(null);
        track('page_view', path);
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS * 2);
        expect(sb.rpc).not.toHaveBeenCalled();
    });

    it('sends the route pattern, never an id in the path, and * for an unknown path', async () => {
        startWith(teacher);
        track('page_view', '/doc/0b6f6a0e-1b1c-4b8e-9f39-0e8c2f7b1a11');
        track('page_view', '/reset/some-secret');
        track('page_view', '/video');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        expect(sent().map((e) => e['path'])).toEqual(['/doc/:documentId', '*', '*']);
    });

    it('sends the referrer’s host only, and none for its own site', async () => {
        vi.spyOn(document, 'referrer', 'get').mockReturnValue('https://Mail.Example.com/inbox?u=me@example.com');
        startWith(null);
        track('page_view', '/');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        expect(sent()[0]!['referrer_host']).toBe('mail.example.com');

        resetWebEventsForTests();
        sb.rpc.mockClear();
        vi.spyOn(document, 'referrer', 'get').mockReturnValue(`${window.location.origin}/try`);
        startWith(null);
        track('page_view', '/');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        expect(sent()[0]).not.toHaveProperty('referrer_host');
    });

    it('sends only the fields the server accepts: no user id, user agent, URL or query', async () => {
        captureAttribution({ pathname: '/try', search: '?utm_source=newsletter&email=a%40b.c' });
        startWith(teacher);
        track('signup_click', '/try');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        const allowed = [
            'event',
            'path',
            'session_key',
            'device_class',
            'referrer_host',
            'utm_source',
            'utm_medium',
            'utm_campaign',
            'utm_content',
            'utm_term',
        ];
        for (const key of Object.keys(sent()[0]!)) {
            expect(allowed).toContain(key);
        }
        expect(JSON.stringify(sent())).not.toMatch(/teacher-1|Mozilla|a@b\.c|\?/);
    });

    it('names the device class from the pointer and the width, not the user agent', async () => {
        startWith(null);
        mockMedia({ '(pointer: coarse)': true });
        track('page_view', '/');
        mockMedia({ '(pointer: coarse)': true, '(min-width: 600px) and (min-height: 600px)': true });
        track('page_view', '/');
        mockMedia({ '(min-width: 600px) and (min-height: 600px)': true });
        track('page_view', '/');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        expect(sent().map((e) => e['device_class'])).toEqual(['mobile', 'tablet', 'desktop']);
    });

    it('keeps one random session key per tab, and works when sessionStorage throws', async () => {
        startWith(null);
        track('page_view', '/');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        const first = sent()[0]!['session_key'];

        resetWebEventsForTests();
        sb.rpc.mockClear();
        startWith(null);
        track('page_view', '/');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        expect(sent()[0]!['session_key']).toBe(first);

        resetWebEventsForTests();
        sb.rpc.mockClear();
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('denied', 'SecurityError');
        });
        startWith(null);
        track('page_view', '/');
        track('page_view', '/try');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        const keys = sent().map((e) => e['session_key']);
        expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
        expect(keys[1]).toBe(keys[0]);
    });

    it('swallows a failed send', async () => {
        sb.rpc.mockRejectedValue(new TypeError('Failed to fetch'));
        startWith(null);
        track('page_view', '/');
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        expect(sb.rpc).toHaveBeenCalledTimes(1);
    });
});

describe('the pagehide flush', () => {
    it('sends what is queued with fetch keepalive and the session’s token', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
        vi.stubGlobal('fetch', fetchMock);
        startWith(teacher);
        track('signup_click', '/try');

        window.dispatchEvent(new Event('pagehide'));
        await vi.advanceTimersByTimeAsync(0);

        expect(sb.rpc).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
        expect(url).toBe('https://sb.test/rest/v1/rpc/record_web_events');
        expect(init.keepalive).toBe(true);
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual(
            expect.objectContaining({ apikey: 'anon-key', Authorization: 'Bearer teacher-token' }),
        );
        expect(JSON.parse(init.body as string)).toEqual({
            p_events: [expect.objectContaining({ event: 'signup_click', path: '/try' })],
        });

        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
        expect(sb.rpc).not.toHaveBeenCalled();
    });

    it('uses the anon key for a visitor with no session', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
        vi.stubGlobal('fetch', fetchMock);
        startWith(null);
        track('page_view', '/');
        window.dispatchEvent(new Event('pagehide'));
        await vi.advanceTimersByTimeAsync(0);
        const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
        expect(init.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer anon-key' }));
    });
});

describe('useTrackPageViews', () => {
    const Tracker = () => {
        useTrackPageViews();
        return null;
    };

    it('records one page_view per route change, by pattern', async () => {
        startWith(teacher);
        render(
            <StrictMode>
                <MemoryRouter initialEntries={['/']}>
                    <Tracker />
                    <Routes>
                        <Route path="/" element={<Link to="/doc/abc?x=1">open</Link>} />
                        <Route path="/doc/:documentId" element={<Link to="/try">demo</Link>} />
                        <Route path="/try" element={<p>demo page</p>} />
                    </Routes>
                </MemoryRouter>
            </StrictMode>,
        );
        fireEvent.click(screen.getByRole('link', { name: 'open' }));
        fireEvent.click(screen.getByRole('link', { name: 'demo' }));
        await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);

        expect(sent().map((e) => [e['event'], e['path']])).toEqual([
            ['page_view', '/'],
            ['page_view', '/doc/:documentId'],
            ['page_view', '/try'],
        ]);
    });
});
