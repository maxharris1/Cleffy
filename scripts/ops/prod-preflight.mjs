#!/usr/bin/env node
/* global AbortSignal, URLSearchParams */
import { pathToFileURL } from 'node:url';

export const PAGES = ['/', '/try', '/privacy', '/terms', '/refunds', '/copyright'];
export const UTM = { utm_source: 'preflight', utm_medium: 'check', utm_campaign: 'preflight' };
export const LIMITS = { timeoutMs: 10_000, maxRedirects: 5, maxJsFiles: 200 };

const USAGE = 'usage: npm run ops:preflight -- <base-url> [--require captcha,sentry]';
const REQUIREMENTS = ['captcha', 'sentry'];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function makeVisit(fetchImpl, limits) {
    return async (url, refuse = () => null) => {
        const hops = [];
        let current = url;
        try {
            for (;;) {
                const refusal = refuse(current);
                if (refusal) return { hops, error: refusal };
                const res = await fetchImpl(current, {
                    method: 'GET',
                    redirect: 'manual',
                    credentials: 'omit',
                    signal: AbortSignal.timeout(limits.timeoutMs),
                });
                const location = res.headers.get('location');
                const redirected = REDIRECTS.has(res.status) && location;
                const body = redirected ? '' : await res.text();
                hops.push({ url: current, status: res.status, headers: res.headers, body });
                if (!redirected) return { hops, error: null };
                if (hops.length > limits.maxRedirects) {
                    return { hops, error: `more than ${limits.maxRedirects} redirects` };
                }
                current = new URL(location, current).href;
            }
        } catch (err) {
            return { hops, error: `${current}: ${err instanceof Error ? err.message : String(err)}` };
        }
    };
}

const finalHop = (visit) => visit.hops.at(-1);
const chain = (visit) => visit.hops.map((h) => `${h.status} ${h.url}`).join(' -> ');

export function checkPages(visitsByPath) {
    const problems = visitsByPath.flatMap(([path, visit]) => {
        if (visit.error) return [`${path} error: ${visit.error}`];
        const { status } = finalHop(visit);
        return status === 200 ? [] : [`${path} ${status}`];
    });
    if (problems.length > 0) return { status: 'FAIL', check: 'pages', detail: problems.join('; ') };
    return { status: 'OK', check: 'pages', detail: `${visitsByPath.length} pages return 200` };
}

export function checkUtmRedirect(requestUrl, visit) {
    const fail = (why) => ({ status: 'FAIL', check: 'utm-redirect', detail: `${why}; chain ${chain(visit)}` });
    if (visit.error) return fail(visit.error);
    const final = finalHop(visit);
    if (final.status !== 200) return fail(`landed on ${final.status}`);
    const asked = new URL(requestUrl);
    const landed = new URL(final.url);
    if (landed.pathname !== asked.pathname) return fail(`path ${asked.pathname} became ${landed.pathname}`);
    const lost = Object.entries(UTM)
        .filter(([key, value]) => landed.searchParams.get(key) !== value)
        .map(([key]) => key);
    if (lost.length > 0) return fail(`lost ${lost.join(', ')}`);
    return { status: 'OK', check: 'utm-redirect', detail: `path and utm_ tags kept; chain ${chain(visit)}` };
}

const OG_URL = /<meta\s[^>]*property=["']og:url["'][^>]*>/i;
const CONTENT = /content=["']([^"']+)["']/i;

function ogUrlHost(html) {
    const content = html.match(OG_URL)?.[0].match(CONTENT)?.[1];
    if (!content) return null;
    try {
        return new URL(content).host;
    } catch {
        return null;
    }
}

export function checkCanonical(visit) {
    if (visit.error) return { status: 'FAIL', check: 'canonical-host', detail: visit.error };
    const final = finalHop(visit);
    const host = new URL(final.url).host;
    const ogHost = ogUrlHost(final.body);
    if (ogHost === null) return { status: 'INFO', check: 'canonical-host', detail: `final host ${host}; no og:url` };
    if (ogHost !== host) {
        return { status: 'INFO', check: 'canonical-host', detail: `final host ${host}; og:url host ${ogHost}` };
    }
    return { status: 'OK', check: 'canonical-host', detail: `final host ${host} matches og:url` };
}

const REQUIRED_HEADERS = [
    ['content-security-policy', null],
    ['strict-transport-security', null],
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['cross-origin-opener-policy', null],
    ['permissions-policy', null],
];

const TURNSTILE = 'https://challenges.cloudflare.com';
const HOST_SOURCE =
    /^https:\/\/((?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+|\*))?((?:\/(?:[\w.~!$&'()*+=:@-]|%[0-9a-f]{2})*)*)$/i;
const SENTRY_INGEST_HOST = /^(\*|[a-z0-9-]+)\.([a-z0-9-]+\.)*ingest\.([a-z0-9-]+\.)?sentry\.io$/;
const isTurnstile = ({ host, port, path }) => host === 'challenges.cloudflare.com' && port === '443' && path === '/';
const REQUIRED_CSP_SOURCES = [
    [['script-src', 'default-src'], TURNSTILE, isTurnstile],
    [['frame-src', 'child-src', 'default-src'], TURNSTILE, isTurnstile],
    [['connect-src', 'default-src'], 'a Sentry ingest host', ({ host }) => SENTRY_INGEST_HOST.test(host)],
];

function parseSource(source) {
    const match = HOST_SOURCE.exec(source);
    return match && { host: match[1].toLowerCase(), port: match[2] ?? '443', path: match[3] || '/' };
}

function parseCsp(csp) {
    return csp
        .split(',')
        .map((policy) => {
            const directives = new Map();
            for (const part of policy.split(';')) {
                const [name, ...sources] = part.trim().split(/\s+/);
                const key = name.toLowerCase();
                if (name && !directives.has(key)) directives.set(key, sources.map(parseSource).filter(Boolean));
            }
            return directives;
        })
        .filter((directives) => directives.size > 0);
}

function covers(allowed, candidate) {
    const hostOk =
        allowed.host === candidate.host ||
        (allowed.host.startsWith('*.') && candidate.host.endsWith(allowed.host.slice(1)));
    const portOk = allowed.port === '*' || allowed.port === candidate.port;
    const pathOk =
        allowed.path === candidate.path || (allowed.path.endsWith('/') && candidate.path.startsWith(allowed.path));
    return hostOk && portOk && pathOk;
}

function allows(policy, chain, candidate) {
    const effective = chain.find((name) => policy.has(name));
    return effective === undefined || policy.get(effective).some((source) => covers(source, candidate));
}

function headerProblems(headers) {
    return REQUIRED_HEADERS.flatMap(([name, expected]) => {
        const actual = headers.get(name);
        if (actual === null) return [`missing ${name}`];
        if (expected !== null && actual.trim().toLowerCase() !== expected.toLowerCase())
            return [`${name} is ${actual}`];
        return [];
    });
}

function cspProblems(csp) {
    const policies = parseCsp(csp);
    return REQUIRED_CSP_SOURCES.filter(([chain, , isCandidate]) => {
        const candidates = policies.flatMap((policy) => policy.get(chain[0]) ?? []).filter(isCandidate);
        return !candidates.some((candidate) => policies.every((policy) => allows(policy, chain, candidate)));
    }).map(([[directive], wanted]) => `CSP ${directive} lacks ${wanted}`);
}

export function checkHeaders(visit) {
    if (visit.error) return { status: 'FAIL', check: 'security-headers', detail: visit.error };
    const { headers } = finalHop(visit);
    const csp = headers.get('content-security-policy');
    const problems = [...headerProblems(headers), ...(csp === null ? [] : cspProblems(csp))];
    if (problems.length > 0) return { status: 'FAIL', check: 'security-headers', detail: problems.join('; ') };
    return {
        status: 'OK',
        check: 'security-headers',
        detail: `${REQUIRED_HEADERS.length} headers present; CSP allows Turnstile and Sentry ingest`,
    };
}

const TAG = /<(script|link)\s[^>]*>/gi;
const ATTR = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const ROOT_ASSET = /(?<=["'`]\/?)assets\/[\w.-]+\.js\b/g;
const RELATIVE_JS = /["'`](\.\/[\w.-]+\.js)["'`]/g;
const SITE_KEY = /["'`](0x4[A-Za-z0-9_-]{18,40})["'`]/;
const DSN = /https:\/\/[0-9a-f]+@([a-z0-9.-]*ingest[a-z0-9.-]*\.sentry\.io)\/\d+/;

function attributes(tag) {
    const inner = tag.slice(1, -1).replace(/^\w+/, '');
    return new Map(Array.from(inner.matchAll(ATTR), (m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']));
}

function entryScripts(html) {
    return Array.from(html.matchAll(TAG)).flatMap(([tag, name]) => {
        const attrs = attributes(tag);
        if (name.toLowerCase() === 'script' && attrs.get('type') === 'module' && attrs.has('src'))
            return [attrs.get('src')];
        if (name.toLowerCase() === 'link' && attrs.get('rel') === 'modulepreload' && attrs.has('href')) {
            return [attrs.get('href')];
        }
        return [];
    });
}

function referencedScripts(js, jsUrl) {
    const root = Array.from(js.matchAll(ROOT_ASSET), ([path]) => new URL(`/${path}`, jsUrl).href);
    const relative = Array.from(js.matchAll(RELATIVE_JS), (m) => new URL(m[1], jsUrl).href);
    return [...root, ...relative];
}

export async function scanBundle(page, visit, limits) {
    const origin = new URL(page.url).origin;
    const queue = [];
    const seen = new Set();
    const enqueue = (refs, base) => {
        for (const ref of refs) {
            let url;
            try {
                url = new URL(ref, base);
            } catch {
                continue;
            }
            if (url.origin !== origin || !url.pathname.endsWith('.js') || seen.has(url.href)) continue;
            seen.add(url.href);
            queue.push(url.href);
        }
    };
    enqueue(entryScripts(page.body), page.url);
    let scanned = 0;
    let budgetHit = false;
    const refuse = (url) => {
        if (new URL(url).origin !== origin) return `${url}: cross-origin JS not fetched`;
        if (scanned >= limits.maxJsFiles) {
            budgetHit = true;
            return `${url}: JS fetch budget spent`;
        }
        scanned += 1;
        return null;
    };
    let next = 0;
    let keyLength = null;
    let ingestHost = null;
    while (next < queue.length && scanned < limits.maxJsFiles && (keyLength === null || ingestHost === null)) {
        const jsUrl = queue[next];
        next += 1;
        const result = await visit(jsUrl, refuse);
        const final = finalHop(result);
        if (result.error || final.status !== 200) continue;
        keyLength ??= final.body.match(SITE_KEY)?.[1].length ?? null;
        ingestHost ??= final.body.match(DSN)?.[1] ?? null;
        enqueue(referencedScripts(final.body, jsUrl), jsUrl);
    }
    const capped = budgetHit || (scanned === limits.maxJsFiles && next < queue.length);
    return { scanned, capped, keyLength, ingestHost };
}

function absent(check, scan, required, what) {
    const status = required ? 'FAIL' : 'INFO';
    if (scan === null) return { status, check, detail: 'not scanned: home page unreachable' };
    const where = scan.capped
        ? `the first ${scan.scanned} JS files (capped at ${scan.scanned})`
        : `${scan.scanned} JS files`;
    return { status, check, detail: `no ${what} in ${where}` };
}

export function checkCaptcha(scan, required) {
    if (scan?.keyLength == null) return absent('captcha', scan, required, 'Turnstile site key');
    const detail = `Turnstile site key compiled in (${scan.keyLength} chars); ${scan.scanned} JS files scanned`;
    return { status: 'OK', check: 'captcha', detail };
}

export function checkSentry(scan, required) {
    if (scan?.ingestHost == null) return absent('sentry', scan, required, 'Sentry DSN');
    return { status: 'OK', check: 'sentry', detail: `Sentry DSN compiled in; ingest host ${scan.ingestHost}` };
}

export async function runPreflight({ baseUrl, require = [], fetchImpl = fetch, limits = LIMITS }) {
    const visit = makeVisit(fetchImpl, limits);
    const pageVisits = await Promise.all(PAGES.map(async (path) => [path, await visit(new URL(path, baseUrl).href)]));
    const utmUrl = new URL(`/?${new URLSearchParams(UTM)}`, baseUrl).href;
    const home = pageVisits[0][1];
    const homeReached = !home.error && finalHop(home).status === 200;
    const [utmVisit, scan] = await Promise.all([
        visit(utmUrl),
        homeReached ? scanBundle(finalHop(home), visit, limits) : null,
    ]);
    const lines = [
        checkPages(pageVisits),
        checkUtmRedirect(utmUrl, utmVisit),
        checkCanonical(home),
        checkHeaders(home),
        checkCaptcha(scan, require.includes('captcha')),
        checkSentry(scan, require.includes('sentry')),
    ];
    return { lines, exitCode: lines.some((l) => l.status === 'FAIL') ? 1 : 0 };
}

function parseRequirements(list) {
    const names = list.split(',');
    const unknown = names.find((name) => !REQUIREMENTS.includes(name));
    if (unknown !== undefined) throw new Error(`${USAGE}\nunknown requirement: ${unknown || '(empty)'}`);
    return names;
}

export function parseArgs(argv) {
    const positional = [];
    const require = [];
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        let list;
        if (arg === '--require') {
            i += 1;
            list = argv[i];
            if (list === undefined) throw new Error(`${USAGE}\n--require needs a value`);
        } else if (arg.startsWith('--require=')) {
            list = arg.slice('--require='.length);
        } else if (arg.startsWith('-')) {
            throw new Error(`${USAGE}\nunknown flag: ${arg}`);
        } else {
            positional.push(arg);
            continue;
        }
        for (const name of parseRequirements(list)) if (!require.includes(name)) require.push(name);
    }
    if (positional.length !== 1) throw new Error(USAGE);
    let url;
    try {
        url = new URL(positional[0]);
    } catch {
        throw new Error(`${USAGE}\nnot a URL: ${positional[0]}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new Error(`${USAGE}\nnot http(s): ${positional[0]}`);
    return { baseUrl: url.origin, require };
}

async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 2;
        return;
    }
    const { lines, exitCode } = await runPreflight(args);
    for (const { status, check, detail } of lines) console.log(`${status} ${check}: ${detail}`);
    process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
