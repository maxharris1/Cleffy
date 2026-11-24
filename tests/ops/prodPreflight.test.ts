import { describe, expect, it } from 'vitest';

import { LIMITS, PAGES, parseArgs, runPreflight, UTM } from '../../scripts/ops/prod-preflight.mjs';

type Reply = { status: number; headers?: Record<string, string>; body?: string };
type Site = Record<string, Reply>;

const BASE = 'https://cleffy.io';
const WWW = 'https://www.cleffy.io';
const UTM_QUERY = new URLSearchParams(UTM).toString();

const page = (ogUrl = `${WWW}/`): Reply => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: `<html><head><meta property="og:url" content="${ogUrl}"></head><body></body></html>`,
});
const moved = (location: string): Reply => ({ status: 308, headers: { location } });

const healthySite = (): Site => {
    const site: Site = {};
    for (const path of PAGES) {
        site[`${BASE}${path}`] = moved(`${WWW}${path}`);
        site[`${WWW}${path}`] = page();
    }
    site[`${BASE}/?${UTM_QUERY}`] = moved(`${WWW}/?${UTM_QUERY}`);
    site[`${WWW}/?${UTM_QUERY}`] = page();
    return site;
};

type Call = { url: string; init: RequestInit | undefined };

function stubFetch(site: Site) {
    const calls: Call[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        const reply = site[url] ?? { status: 404, body: 'not found' };
        return new Response(reply.body ?? null, {
            status: reply.status,
            headers: reply.headers,
        });
    };
    return { calls, fetchImpl: fetchImpl as typeof fetch };
}

async function run(site: Site, limits = LIMITS) {
    const stub = stubFetch(site);
    const result = await runPreflight({ baseUrl: BASE, fetchImpl: stub.fetchImpl, limits });
    const line = (check: string) => result.lines.find((l) => l.check === check);
    return { ...result, calls: stub.calls, line };
}

describe('prod preflight', () => {
    it('passes a healthy site with one line per check and exit 0', async () => {
        const { lines, exitCode, line } = await run(healthySite());
        expect(lines.map((l) => l.check)).toEqual(['pages', 'utm-redirect', 'canonical-host']);
        expect(lines.map((l) => l.status)).toEqual(['OK', 'OK', 'OK']);
        expect(line('utm-redirect')?.detail).toContain(`308 ${BASE}/?${UTM_QUERY} -> 200 ${WWW}/?${UTM_QUERY}`);
        expect(line('canonical-host')?.detail).toContain('www.cleffy.io');
        expect(exitCode).toBe(0);
    });

    it('fails pages when one path is not 200 and names it', async () => {
        const site = healthySite();
        site[`${WWW}/refunds`] = { status: 404, body: 'gone' };
        const { line, exitCode, lines } = await run(site);
        expect(lines).toHaveLength(3);
        expect(line('pages')?.status).toBe('FAIL');
        expect(line('pages')?.detail).toContain('/refunds 404');
        expect(line('pages')?.detail).not.toContain('/terms');
        expect(exitCode).toBe(1);
    });

    it('fails the redirect when it drops a utm_ tag', async () => {
        const site = healthySite();
        const dropped = `${WWW}/?utm_source=preflight&utm_medium=check`;
        site[`${BASE}/?${UTM_QUERY}`] = moved(dropped);
        site[dropped] = page();
        const { line, exitCode } = await run(site);
        expect(line('utm-redirect')?.status).toBe('FAIL');
        expect(line('utm-redirect')?.detail).toContain('utm_campaign');
        expect(line('utm-redirect')?.detail).toContain(`-> 200 ${dropped}`);
        expect(exitCode).toBe(1);
    });

    it('fails the redirect when it changes the path', async () => {
        const site = healthySite();
        const landing = `${WWW}/home?${UTM_QUERY}`;
        site[`${BASE}/?${UTM_QUERY}`] = moved(landing);
        site[landing] = page();
        const { line, exitCode } = await run(site);
        expect(line('utm-redirect')?.status).toBe('FAIL');
        expect(line('utm-redirect')?.detail).toContain('path / became /home');
        expect(exitCode).toBe(1);
    });

    it.each([300, 304, 305, 399])('treats a %i with Location as final and exits 1', async (status) => {
        const site = healthySite();
        for (const path of [...PAGES, `/?${UTM_QUERY}`])
            site[`${BASE}${path}`] = { status, headers: { location: `${WWW}${path}` } };
        const { line, exitCode, calls } = await run(site);
        expect(calls.every((c) => c.url.startsWith(BASE))).toBe(true);
        expect(line('pages')?.status).toBe('FAIL');
        expect(line('pages')?.detail).toContain(`/ ${status}`);
        expect(line('utm-redirect')?.status).toBe('FAIL');
        expect(line('utm-redirect')?.detail).toContain(`landed on ${status}`);
        expect(exitCode).toBe(1);
    });

    it.each([301, 302, 303, 307, 308])('follows a %i redirect', async (status) => {
        const site = healthySite();
        for (const path of [...PAGES, `/?${UTM_QUERY}`])
            site[`${BASE}${path}`] = { status, headers: { location: `${WWW}${path}` } };
        const { lines, exitCode } = await run(site);
        expect(lines.map((l) => l.status)).toEqual(['OK', 'OK', 'OK']);
        expect(exitCode).toBe(0);
    });

    it('reports INFO, not FAIL, when og:url names another host', async () => {
        const site = healthySite();
        site[`${WWW}/`] = page('https://cleffy.io/');
        site[`${WWW}/?${UTM_QUERY}`] = page('https://cleffy.io/');
        const { line, exitCode } = await run(site);
        expect(line('canonical-host')?.status).toBe('INFO');
        expect(line('canonical-host')?.detail).toContain('www.cleffy.io');
        expect(line('canonical-host')?.detail).toContain('og:url host cleffy.io');
        expect(exitCode).toBe(0);
    });

    it('fails the canonical host when the home page cannot be reached', async () => {
        const site = healthySite();
        site[`${BASE}/`] = moved(`${BASE}/`);
        const { line, exitCode } = await run(site);
        expect(line('canonical-host')?.status).toBe('FAIL');
        expect(line('canonical-host')?.detail).toContain('redirects');
        expect(exitCode).toBe(1);
    });

    it('sends only bare GETs with a timeout signal and no credentials', async () => {
        const { calls } = await run(healthySite());
        expect(calls.length).toBeGreaterThan(PAGES.length);
        for (const { init } of calls) {
            expect(init?.method).toBe('GET');
            expect(init?.redirect).toBe('manual');
            expect(init?.credentials).toBe('omit');
            expect(init?.headers).toBeUndefined();
            expect(init?.signal).toBeInstanceOf(AbortSignal);
        }
    });

    it('ends with FAIL lines when a request hangs past the timeout', async () => {
        const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
            })) as typeof fetch;
        const result = await runPreflight({
            baseUrl: BASE,
            fetchImpl: hanging,
            limits: { ...LIMITS, timeoutMs: 20 },
        });
        expect(result.lines.map((l) => l.status)).toEqual(['FAIL', 'FAIL', 'FAIL']);
        expect(result.exitCode).toBe(1);
    });

    it('parses the base URL and rejects anything else', () => {
        expect(parseArgs(['https://dev.cleffy.io/'])).toEqual({ baseUrl: 'https://dev.cleffy.io' });
        expect(() => parseArgs([])).toThrow();
        expect(() => parseArgs(['ftp://cleffy.io'])).toThrow();
        expect(() => parseArgs(['https://a.io', 'https://b.io'])).toThrow();
    });
});
