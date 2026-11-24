#!/usr/bin/env node
/* global AbortSignal, URLSearchParams */
import { pathToFileURL } from 'node:url';

export const PAGES = ['/', '/try', '/privacy', '/terms', '/refunds', '/copyright'];
export const UTM = { utm_source: 'preflight', utm_medium: 'check', utm_campaign: 'preflight' };
export const LIMITS = { timeoutMs: 10_000, maxRedirects: 5 };

const USAGE = 'usage: npm run ops:preflight -- <base-url>';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export function makeVisit(fetchImpl, limits) {
    return async (url) => {
        const hops = [];
        let current = url;
        try {
            for (;;) {
                const res = await fetchImpl(current, {
                    method: 'GET',
                    redirect: 'manual',
                    credentials: 'omit',
                    signal: AbortSignal.timeout(limits.timeoutMs),
                });
                const location = res.headers.get('location');
                const redirected = REDIRECTS.has(res.status) && location;
                const body = redirected ? '' : await res.text();
                hops.push({ url: current, status: res.status, body });
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

export async function runPreflight({ baseUrl, fetchImpl = fetch, limits = LIMITS }) {
    const visit = makeVisit(fetchImpl, limits);
    const pageVisits = await Promise.all(PAGES.map(async (path) => [path, await visit(new URL(path, baseUrl).href)]));
    const utmUrl = new URL(`/?${new URLSearchParams(UTM)}`, baseUrl).href;
    const home = pageVisits[0][1];
    const lines = [checkPages(pageVisits), checkUtmRedirect(utmUrl, await visit(utmUrl)), checkCanonical(home)];
    return { lines, exitCode: lines.some((l) => l.status === 'FAIL') ? 1 : 0 };
}

export function parseArgs(argv) {
    if (argv.length !== 1) throw new Error(USAGE);
    let url;
    try {
        url = new URL(argv[0]);
    } catch {
        throw new Error(`${USAGE}\nnot a URL: ${argv[0]}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${USAGE}\nnot http(s): ${argv[0]}`);
    return { baseUrl: url.origin };
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
