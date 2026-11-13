// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, POST } from '../../api/view';

/**
 * The Vercel Function in front of the view-link Edge Function (api/view.ts).
 * The child's browser talks only to it: it must forward the JSON body and
 * nothing that identifies the browser, and answer 404 while switched off.
 */

const TOKEN = 'q'.repeat(43);
const UPSTREAM = 'https://project.supabase.co';

const ENV = {
    VIEW_LINKS_ENABLED: '1',
    VIEW_LINKS_SUPABASE_URL: UPSTREAM,
    VIEW_LINKS_ANON_KEY: 'anon-key',
    VIEW_PROXY_SECRET: 'proxy-secret',
};

const CLIENT_HEADERS = {
    'Content-Type': 'application/json',
    'x-forwarded-for': '203.0.113.9, 10.0.0.1',
    'x-real-ip': '203.0.113.9',
    'cf-connecting-ip': '203.0.113.9',
    'x-vercel-forwarded-for': '203.0.113.9',
    forwarded: 'for=203.0.113.9',
    'user-agent': 'Mozilla/5.0 (child tablet)',
    referer: 'https://cleffy.io/v',
    cookie: 'sb-access-token=abc',
    'accept-language': 'en-GB',
    authorization: 'Bearer someone-elses',
};

const request = (body: unknown, method = 'POST', headers: Record<string, string> = CLIENT_HEADERS) =>
    new Request('https://cleffy.io/api/view', {
        method,
        headers,
        body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) {
        vi.stubEnv(key, value);
    }
    fetchMock = vi.fn(
        async () =>
            new Response(JSON.stringify({ doc: { pages: 1, pdf_rev: 0 }, annotations: [], max_seq: 0 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'tracker=1', 'x-sb-project': 'leak' },
            }),
    );
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const upstreamCall = () => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, init, headers: new Headers(init.headers) };
};

describe('switched off', () => {
    it.each([undefined, '', '0', 'true'])(
        'answers 404 and calls nothing when VIEW_LINKS_ENABLED is %s',
        async (value) => {
            vi.stubEnv('VIEW_LINKS_ENABLED', value as string);
            const res = await POST(request({ token: TOKEN }));
            expect(res.status).toBe(404);
            expect(res.headers.get('Cache-Control')).toBe('no-store');
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    it('answers GET with 404 too', async () => {
        const res = await GET();
        expect(res.status).toBe(404);
    });

    it('answers 404 when its upstream is not configured', async () => {
        vi.stubEnv('VIEW_PROXY_SECRET', '');
        const res = await POST(request({ token: TOKEN }));
        expect(res.status).toBe(404);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('forwarding', () => {
    it('posts to the view-link function with the anon key and the proxy secret', async () => {
        await POST(request({ token: TOKEN, since: 4 }));
        const { url, init, headers } = upstreamCall();
        expect(url).toBe(`${UPSTREAM}/functions/v1/view-link`);
        expect(init.method).toBe('POST');
        expect(headers.get('apikey')).toBe('anon-key');
        expect(headers.get('authorization')).toBe('Bearer anon-key');
        expect(headers.get('x-cleffy-view-proxy')).toBe('proxy-secret');
        expect(headers.get('content-type')).toBe('application/json');
    });

    it('forwards no client header: no IP, user agent, referer, cookie, language or auth', async () => {
        await POST(request({ token: TOKEN }));
        const { headers } = upstreamCall();
        expect([...headers.keys()].sort()).toEqual(['apikey', 'authorization', 'content-type', 'x-cleffy-view-proxy']);
        const sent = JSON.stringify([...headers.entries()]);
        for (const value of ['203.0.113.9', 'Mozilla', 'cleffy.io/v', 'sb-access-token', 'en-GB', 'someone-elses']) {
            expect(sent).not.toContain(value);
        }
    });

    it('forwards only the known body fields, re-serialized', async () => {
        await POST(request({ token: TOKEN, since: 4, pdf: true, ip: '203.0.113.9', extra: { a: 1 } }));
        const { init } = upstreamCall();
        expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN, since: 4, pdf: true });
    });

    it('keeps the token out of the upstream URL', async () => {
        await POST(request({ token: TOKEN }));
        const { url } = upstreamCall();
        expect(url).not.toContain(TOKEN);
        expect(url).not.toContain('?');
    });

    it('answers a malformed token with 410 and no upstream call', async () => {
        const res = await POST(request({ token: 'short' }));
        expect(res.status).toBe(410);
        expect(await res.json()).toEqual({ gone: true });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers a body that is not JSON with 400', async () => {
        const res = await POST(request('{nope'));
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers an oversized body with 413', async () => {
        const res = await POST(request({ token: TOKEN, pad: 'x'.repeat(8192) }));
        expect(res.status).toBe(413);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('the response', () => {
    it('passes the status and body through with no-store, and drops upstream headers', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ gone: true }), {
                status: 410,
                headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'x=1', 'sb-gateway-version': '1' },
            }),
        );
        const res = await POST(request({ token: TOKEN }));
        expect(res.status).toBe(410);
        expect(await res.json()).toEqual({ gone: true });
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(res.headers.get('Set-Cookie')).toBeNull();
        expect(res.headers.get('sb-gateway-version')).toBeNull();
    });

    it('streams a PDF through as application/pdf', async () => {
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
        fetchMock.mockResolvedValueOnce(
            new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
        );
        const res = await POST(request({ token: TOKEN, pdf: true }));
        expect(res.headers.get('Content-Type')).toBe('application/pdf');
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    });

    it('keeps Retry-After on a 429', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ error: 'rate_limited' }), {
                status: 429,
                headers: { 'Content-Type': 'application/json', 'Retry-After': '7' },
            }),
        );
        const res = await POST(request({ token: TOKEN }));
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toBe('7');
    });

    it('answers 502 when the upstream cannot be reached, and logs nothing', async () => {
        const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
            vi.spyOn(console, m).mockImplementation(() => undefined),
        );
        fetchMock.mockRejectedValueOnce(new Error(`network down for ${TOKEN}`));
        const res = await POST(request({ token: TOKEN }));
        expect(res.status).toBe(502);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        for (const spy of spies) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    it('has no console call at all', () => {
        const source = readFileSync(resolve(process.cwd(), 'api/view.ts'), 'utf8');
        expect(source).not.toMatch(/console\./);
    });

    it('uses no path alias (Vercel compiles api/ without tsconfig paths)', () => {
        const source = readFileSync(resolve(process.cwd(), 'api/view.ts'), 'utf8');
        expect(source).not.toMatch(/from '@\//);
    });
});
