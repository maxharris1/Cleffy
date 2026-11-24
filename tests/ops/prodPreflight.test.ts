import { describe, expect, it } from 'vitest';

import { LIMITS, PAGES, parseArgs, runPreflight, UTM } from '../../scripts/ops/prod-preflight.mjs';

type Reply = { status: number; headers?: Record<string, string>; body?: string };
type Site = Record<string, Reply>;

const BASE = 'https://cleffy.io';
const WWW = 'https://www.cleffy.io';
const UTM_QUERY = new URLSearchParams(UTM).toString();

const KEY = '0x4AAAAAAAPreflightFixtureKey00';
const DSN_SECRET = 'abc123def';
const INGEST = 'o1.ingest.us.sentry.io';
const DSN = `https://${DSN_SECRET}@${INGEST}/42`;

const HEAD_TAGS = [
    '<script type="module" crossorigin src="/assets/index-E1.js"></script>',
    '<link rel="modulepreload" crossorigin href="/assets/react-R1.js">',
    '<link crossorigin href="/assets/vendor-V1.js" rel="modulepreload">',
].join('');

const page = (ogUrl = `${WWW}/`, head = HEAD_TAGS): Reply => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: `<html><head><meta property="og:url" content="${ogUrl}">${head}</head><body></body></html>`,
});
const js = (body: string): Reply => ({ status: 200, headers: { 'content-type': 'text/javascript' }, body });
const mapDeps = (...names: string[]) =>
    `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=[${names.map((n) => `"assets/${n}"`).join(',')}])))=>i.map(i=>d[i]);`;

type Bundle = Record<string, string>;
const bundle = (): Bundle => ({
    'index-E1.js': `${mapDeps('useTurnstileToken-T1.js', 'Editor-X1.js')}import"./react-R1.js";const dsn="${DSN}";`,
    'react-R1.js': 'export const react=1;',
    'vendor-V1.js': 'export const vendor=1;',
    'useTurnstileToken-T1.js': `const sitekey="${KEY}";export{sitekey};`,
    'Editor-X1.js': 'export const editor=1;',
});
const withBundle = (site: Site, files: Bundle): Site => {
    for (const [name, body] of Object.entries(files)) site[`${WWW}/assets/${name}`] = js(body);
    return site;
};
const moved = (location: string): Reply => ({ status: 308, headers: { location } });

const healthySite = (): Site => {
    const site: Site = {};
    for (const path of PAGES) {
        site[`${BASE}${path}`] = moved(`${WWW}${path}`);
        site[`${WWW}${path}`] = page();
    }
    site[`${BASE}/?${UTM_QUERY}`] = moved(`${WWW}/?${UTM_QUERY}`);
    site[`${WWW}/?${UTM_QUERY}`] = page();
    return withBundle(site, bundle());
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

async function run(site: Site, limits = LIMITS, require: Array<'captcha' | 'sentry'> = []) {
    const stub = stubFetch(site);
    const result = await runPreflight({ baseUrl: BASE, require, fetchImpl: stub.fetchImpl, limits });
    const line = (check: string) => result.lines.find((l) => l.check === check);
    return { ...result, calls: stub.calls, line };
}

describe('prod preflight', () => {
    it('passes a healthy site with one line per check and exit 0', async () => {
        const { lines, exitCode, line } = await run(healthySite());
        expect(lines.map((l) => l.check)).toEqual(['pages', 'utm-redirect', 'canonical-host', 'captcha', 'sentry']);
        expect(lines.map((l) => l.status)).toEqual(['OK', 'OK', 'OK', 'OK', 'OK']);
        expect(line('utm-redirect')?.detail).toContain(`308 ${BASE}/?${UTM_QUERY} -> 200 ${WWW}/?${UTM_QUERY}`);
        expect(line('canonical-host')?.detail).toContain('www.cleffy.io');
        expect(exitCode).toBe(0);
    });

    it('fails pages when one path is not 200 and names it', async () => {
        const site = healthySite();
        site[`${WWW}/refunds`] = { status: 404, body: 'gone' };
        const { line, exitCode, lines } = await run(site);
        expect(lines).toHaveLength(5);
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
        expect(lines.map((l) => l.status)).toEqual(['OK', 'OK', 'OK', 'OK', 'OK']);
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
            require: ['captcha', 'sentry'],
            fetchImpl: hanging,
            limits: { ...LIMITS, timeoutMs: 20 },
        });
        expect(result.lines.map((l) => l.status)).toEqual(['FAIL', 'FAIL', 'FAIL', 'FAIL', 'FAIL']);
        expect(result.exitCode).toBe(1);
    });

    it('parses the base URL and rejects anything else', () => {
        expect(parseArgs(['https://dev.cleffy.io/'])).toEqual({ baseUrl: 'https://dev.cleffy.io', require: [] });
        expect(() => parseArgs([])).toThrow();
        expect(() => parseArgs(['ftp://cleffy.io'])).toThrow();
        expect(() => parseArgs(['https://a.io', 'https://b.io'])).toThrow();
    });

    it('parses --require captcha,sentry and rejects unknown or missing names', () => {
        expect(parseArgs(['https://cleffy.io', '--require', 'captcha,sentry'])).toEqual({
            baseUrl: 'https://cleffy.io',
            require: ['captcha', 'sentry'],
        });
        expect(parseArgs(['https://cleffy.io', '--require', 'sentry'])).toEqual({
            baseUrl: 'https://cleffy.io',
            require: ['sentry'],
        });
        expect(parseArgs(['--require=captcha', 'https://cleffy.io'])).toEqual({
            baseUrl: 'https://cleffy.io',
            require: ['captcha'],
        });
        expect(() => parseArgs(['https://cleffy.io', '--require', 'headers'])).toThrow();
        expect(() => parseArgs(['https://cleffy.io', '--require'])).toThrow();
        expect(() => parseArgs(['https://cleffy.io', '--verbose'])).toThrow();
    });
});

describe('prod preflight bundle scan', () => {
    const output = (lines: Array<{ status: string; check: string; detail: string }>) =>
        lines.map((l) => `${l.status} ${l.check}: ${l.detail}`).join('\n');

    it('finds the key in a lazy chunk named only in the entry dep map', async () => {
        const { line, calls } = await run(healthySite(), LIMITS, ['captcha', 'sentry']);
        expect(HEAD_TAGS).not.toContain('useTurnstileToken');
        expect(calls.map((c) => c.url)).toContain(`${WWW}/assets/useTurnstileToken-T1.js`);
        expect(line('captcha')?.status).toBe('OK');
        expect(line('captcha')?.detail).toContain(`${KEY.length} chars`);
        expect(line('sentry')?.status).toBe('OK');
        expect(line('sentry')?.detail).toContain(INGEST);
    });

    it('scans the entry and every modulepreload', async () => {
        const { calls } = await run(healthySite());
        const urls = calls.map((c) => c.url);
        for (const name of ['index-E1.js', 'react-R1.js', 'vendor-V1.js'])
            expect(urls).toContain(`${WWW}/assets/${name}`);
    });

    it('reports absence as INFO and exit 0 without --require', async () => {
        const files = bundle();
        files['index-E1.js'] = `${mapDeps('Editor-X1.js')}export const app=1;`;
        delete files['useTurnstileToken-T1.js'];
        const { line, exitCode } = await run(withBundle(healthySite(), files));
        expect(line('captcha')?.status).toBe('INFO');
        expect(line('captcha')?.detail).toContain('no Turnstile site key');
        expect(line('sentry')?.status).toBe('INFO');
        expect(line('sentry')?.detail).toContain('no Sentry DSN');
        expect(exitCode).toBe(0);
    });

    it('fails a missing key under --require captcha and a missing DSN under --require sentry', async () => {
        const site = healthySite();
        site[`${WWW}/assets/useTurnstileToken-T1.js`] = js('export const none=1;');
        site[`${WWW}/assets/index-E1.js`] = js(`${mapDeps('useTurnstileToken-T1.js')}export const app=1;`);
        const captcha = await run(site, LIMITS, ['captcha']);
        expect(captcha.line('captcha')?.status).toBe('FAIL');
        expect(captcha.line('sentry')?.status).toBe('INFO');
        expect(captcha.exitCode).toBe(1);
        const sentry = await run(site, LIMITS, ['sentry']);
        expect(sentry.line('captcha')?.status).toBe('INFO');
        expect(sentry.line('sentry')?.status).toBe('FAIL');
        expect(sentry.exitCode).toBe(1);
    });

    it('never prints the site key or the DSN, only the key length and the ingest host', async () => {
        const { lines } = await run(healthySite(), LIMITS, ['captcha', 'sentry']);
        const text = output(lines);
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(DSN);
        expect(text).not.toContain(DSN_SECRET);
        expect(text).toContain(String(KEY.length));
        expect(text).toContain(INGEST);
    });

    it('stops at maxJsFiles on an over-cap bundle and fails --require captcha when the key was not reached', async () => {
        const names = Array.from({ length: 300 }, (_, i) => `chunk-${i}.js`);
        const files: Bundle = {
            'index-E1.js': `${mapDeps(...names)}const dsn="${DSN}";`,
            'react-R1.js': '',
            'vendor-V1.js': '',
        };
        for (const name of names) files[name] = 'export const x=1;';
        files['chunk-299.js'] = `const sitekey="${KEY}";`;
        const site = withBundle(healthySite(), files);
        delete site[`${WWW}/assets/useTurnstileToken-T1.js`];
        const limits = { ...LIMITS, maxJsFiles: 50 };
        const { line, calls, exitCode } = await run(site, limits, ['captcha']);
        const jsCalls = calls.filter((c) => c.url.endsWith('.js'));
        expect(jsCalls.length).toBeLessThanOrEqual(50);
        expect(line('captcha')?.status).toBe('FAIL');
        expect(line('captcha')?.detail).toContain('capped at 50');
        expect(exitCode).toBe(1);
        const unrequired = await run(site, limits);
        expect(unrequired.line('captcha')?.status).toBe('INFO');
    });

    it('fetches same-origin JS only', async () => {
        const site = healthySite();
        const head = `${HEAD_TAGS}<script type="module" src="https://cdn.example.com/assets/evil-Z1.js"></script>`;
        site[`${WWW}/`] = page(`${WWW}/`, head);
        site[`${WWW}/assets/useTurnstileToken-T1.js`] = js('export const none=1;');
        site[`${WWW}/assets/index-E1.js`] = js(
            `${mapDeps('useTurnstileToken-T1.js')}import("https://other.example.com/assets/far-F1.js");const dsn="${DSN}";`,
        );
        const { calls } = await run(site);
        const jsHosts = new Set(calls.filter((c) => c.url.endsWith('.js')).map((c) => new URL(c.url).origin));
        expect([...jsHosts]).toEqual([WWW]);
        expect(calls.map((c) => c.url)).not.toContain(`${WWW}/assets/far-F1.js`);
    });

    it('sends the JS fetches as bare GETs too', async () => {
        const { calls } = await run(healthySite());
        const jsCalls = calls.filter((c) => c.url.endsWith('.js'));
        expect(jsCalls.length).toBeGreaterThan(0);
        for (const { init } of jsCalls) {
            expect(init?.method).toBe('GET');
            expect(init?.credentials).toBe('omit');
            expect(init?.headers).toBeUndefined();
        }
    });
});
