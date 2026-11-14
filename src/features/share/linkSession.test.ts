import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    LinkSession,
    parseShareSessionAnswer,
    pdfUrlOnProject,
    renewDelayMs,
    requestShareSession,
    type LinkSessionEvents,
    type ViewerAnswer,
} from '@/features/share/linkSession';
import type { TypedSupabaseClient } from '@/lib/supabase';

vi.mock('@/lib/supabase', () => ({
    requireSupabaseConfig: () => ({ url: 'https://sb.test', anonKey: 'anon-key' }),
}));

const TOKEN = 'abcdefghijklmnopqrstuv';
const doc = { id: 'd1', title: 'Für Elise', page_count: 2, content_rev: 0 };
const viewerBody = (jwt: string, exp: number) => ({
    state: 'live',
    role: 'viewer',
    session_jwt: jwt,
    exp,
    doc,
    pdf_url: 'https://sb.test/pdf',
    link_expires_at: '2026-11-20T12:00:00Z',
});

describe('parseShareSessionAnswer', () => {
    it('maps every share-session reply', () => {
        expect(parseShareSessionAnswer(200, viewerBody('j', 600))).toEqual({
            kind: 'viewer',
            jwt: 'j',
            exp: 600,
            doc,
            pdfUrl: 'https://sb.test/pdf',
            linkExpiresAt: '2026-11-20T12:00:00Z',
        });
        expect(parseShareSessionAnswer(200, { state: 'live', role: 'editor', link_expires_at: null })).toEqual({
            kind: 'editor',
            linkExpiresAt: null,
        });
        expect(parseShareSessionAnswer(200, { state: 'expired', expired_at: '2026-11-01T00:00:00Z' })).toEqual({
            kind: 'dead',
            state: 'expired',
            expiredAt: '2026-11-01T00:00:00Z',
        });
        for (const state of ['revoked', 'unavailable', 'invalid'] as const) {
            expect(parseShareSessionAnswer(200, { state })).toEqual({ kind: 'dead', state, expiredAt: null });
        }
        expect(parseShareSessionAnswer(429, { reason: 'too_many_viewers', retry_after: 42 })).toEqual({
            kind: 'busy',
            retryAfterSec: 42,
        });
        expect(parseShareSessionAnswer(404, { error: 'not_found' })).toEqual({
            kind: 'dead',
            state: 'invalid',
            expiredAt: null,
        });
        expect(parseShareSessionAnswer(503, { error: 'unavailable' })).toEqual({ kind: 'failed' });
        expect(parseShareSessionAnswer(200, { state: 'live', role: 'viewer' })).toEqual({ kind: 'failed' });
    });
});

describe('requestShareSession', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('posts the token with only the anon key, sending no cookies or referrer', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ state: 'revoked' })));
        vi.stubGlobal('fetch', fetchMock);
        await expect(requestShareSession(TOKEN, 'old-jwt')).resolves.toMatchObject({ kind: 'dead' });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://sb.test/functions/v1/share-session');
        expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN, renew: 'old-jwt' });
        expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    });

    it('is failed when the network is down', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
        await expect(requestShareSession(TOKEN)).resolves.toEqual({ kind: 'failed' });
    });
});

describe('pdfUrlOnProject', () => {
    it('keeps the signed path and token, on the app’s own Supabase URL', () => {
        expect(pdfUrlOnProject('http://kong:8000/storage/v1/object/sign/scores/d/original.pdf?token=t')).toBe(
            'https://sb.test/storage/v1/object/sign/scores/d/original.pdf?token=t',
        );
    });
});

describe('renewDelayMs', () => {
    it('renews at 80% of a 600 s token', () => {
        expect(renewDelayMs(1600, 1000)).toBe(480_000);
        expect(renewDelayMs(900, 1000)).toBe(0);
    });
});

describe('LinkSession', () => {
    const start = new Date('2026-11-13T12:00:00Z');
    const nowSec = start.getTime() / 1000;
    let fetchMock: ReturnType<typeof vi.fn>;
    let events: {
        onRenewed: ReturnType<typeof vi.fn<LinkSessionEvents['onRenewed']>>;
        onDead: ReturnType<typeof vi.fn<LinkSessionEvents['onDead']>>;
        onBusy: ReturnType<typeof vi.fn<LinkSessionEvents['onBusy']>>;
    };
    const first: ViewerAnswer = {
        kind: 'viewer',
        jwt: 'jwt-1',
        exp: nowSec + 600,
        doc,
        pdfUrl: 'https://sb.test/pdf',
        linkExpiresAt: null,
    };
    const fakeClient = (token: () => Promise<string>) => ({ token }) as unknown as TypedSupabaseClient;
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

    beforeEach(() => {
        vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        events = {
            onRenewed: vi.fn<LinkSessionEvents['onRenewed']>(),
            onDead: vi.fn<LinkSessionEvents['onDead']>(),
            onBusy: vi.fn<LinkSessionEvents['onBusy']>(),
        };
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('serves the token from memory and renews it at 480 s', async () => {
        fetchMock.mockResolvedValue(reply(200, viewerBody('jwt-2', nowSec + 1080)));
        const session = new LinkSession(TOKEN, first, events, fakeClient);
        const client = session.client as unknown as { token: () => Promise<string> };
        await expect(client.token()).resolves.toBe('jwt-1');
        session.start();
        await vi.advanceTimersByTimeAsync(479_000);
        expect(fetchMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(events.onRenewed).toHaveBeenCalledWith('jwt-2');
        await expect(client.token()).resolves.toBe('jwt-2');
        session.dispose();
        await expect(client.token()).resolves.toBe('');
    });

    it('renews on becoming visible only when under 2 minutes are left', async () => {
        fetchMock.mockResolvedValue(reply(200, viewerBody('jwt-2', nowSec + 2000)));
        const session = new LinkSession(TOKEN, first, events, fakeClient);
        session.start();
        const visible = () => {
            Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        };
        vi.setSystemTime(new Date(start.getTime() + 470_000));
        visible();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).not.toHaveBeenCalled();
        vi.setSystemTime(new Date(start.getTime() + 490_000));
        visible();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        session.dispose();
    });

    it('keeps going through a 429 and retries after its wait', async () => {
        fetchMock
            .mockResolvedValueOnce(reply(429, { reason: 'too_many_viewers', retry_after: 30 }))
            .mockResolvedValueOnce(reply(200, viewerBody('jwt-2', nowSec + 2000)));
        const session = new LinkSession(TOKEN, first, events, fakeClient);
        session.start();
        await vi.advanceTimersByTimeAsync(480_000);
        expect(events.onBusy).toHaveBeenCalledWith(30);
        expect(events.onDead).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(events.onRenewed).toHaveBeenCalledWith('jwt-2');
        session.dispose();
    });

    it('reports a dead link and stops renewing', async () => {
        fetchMock.mockResolvedValue(reply(200, { state: 'revoked' }));
        const session = new LinkSession(TOKEN, first, events, fakeClient);
        session.start();
        await vi.advanceTimersByTimeAsync(480_000);
        expect(events.onDead).toHaveBeenCalledWith({ kind: 'dead', state: 'revoked', expiredAt: null });
        await vi.advanceTimersByTimeAsync(3_600_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
