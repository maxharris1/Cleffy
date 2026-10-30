// Load-time and smoothness benchmarks for the library and the score viewer,
// against a production build and the local Supabase stack. See README.md in
// this directory for setup (seed data, fixtures, serving the build).
//
//   node scripts/perf/bench.mjs <label> [scenario,...] [--runs N] [--no-throttle]
//
// Device profile: iPad-landscape viewport (1180x820 @2x, touch), CPU 4x
// slowdown, network 100 ms RTT / 10 Mbit down / 3 Mbit up — a mid-range
// tablet on decent 4G. Every scenario runs in a fresh browser context. DevTools
// network emulation does not reach a dedicated worker's own requests (the
// pdf.js worker script loads at local speed), so viewer numbers are a little
// optimistic. Results append to $CLEFFY_PERF_DIR/results.jsonl; compare two
// labels with report.mjs.
/* global requestAnimationFrame, innerHeight, scrollY, getComputedStyle, history, dispatchEvent,
   PopStateEvent, WheelEvent, PerformanceObserver, indexedDB, HTMLInputElement, Event, setInterval,
   clearInterval */
import { createRequire } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.CLEFFY_PERF_BASE ?? 'http://localhost:4173';
const OUT = process.env.CLEFFY_PERF_DIR ?? '/tmp/cleffy-perf';
mkdirSync(OUT, { recursive: true });
const STATE = `${OUT}/state.json`;
const RESULTS = `${OUT}/results.jsonl`;
const NEWEST = 'e0000000-0000-4000-8000-000000000001';
const OLD = 'e0000000-0000-4000-8000-0000000001c2'; // #450, reached only by "load more"

const args = process.argv.slice(2);
const label = args[0] ?? 'unnamed';
const runsArg = args.indexOf('--runs');
const RUNS = runsArg >= 0 ? Number(args[runsArg + 1]) : 5;
const only = args[1] && !args[1].startsWith('--') ? args[1].split(',') : null;
const NO_THROTTLE = args.includes('--no-throttle');
const CPU = NO_THROTTLE ? 1 : 4;
const NET = NO_THROTTLE
    ? null
    : { offline: false, latency: 100, downloadThroughput: (10e6 / 8) | 0, uploadThroughput: (3e6 / 8) | 0 };

const DEVICE = {
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
};

// The project's Playwright may want a browser build that is not installed;
// cloud sessions ship one at /opt/pw-browsers/chromium.
const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] }).catch(() =>
    chromium.launch({
        args: ['--enable-precise-memory-info'],
        executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    }),
);

const median = (xs) => {
    const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** In-page instrumentation, installed before any app script runs. */
const INSTRUMENT = () => {
    window.__long = [];
    try {
        new PerformanceObserver((list) => {
            for (const e of list.getEntries()) window.__long.push({ start: e.startTime, dur: e.duration });
        }).observe({ type: 'longtask', buffered: true });
    } catch {
        // No long-task timing in this browser: TBT reads 0.
    }
    window.__lcp = 0;
    try {
        new PerformanceObserver((list) => {
            for (const e of list.getEntries()) window.__lcp = e.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
        // No LCP in this browser.
    }
    // Each library page request, and when its rows became visible.
    window.__pages = [];
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input?.url ?? '');
        if (url.includes('rpc/library_documents')) {
            const rec = {
                start: performance.now(),
                end: null,
                cardsBefore: document.querySelectorAll('.library-card').length,
                shown: null,
            };
            window.__pages.push(rec);
            return origFetch.call(this, input, init).then((r) => {
                rec.end = performance.now();
                const poll = () => {
                    const c = document.querySelectorAll('.library-card')[rec.cardsBefore];
                    if (c && getComputedStyle(c).opacity === '1') rec.shown = performance.now();
                    else if (performance.now() - rec.start < 30000) requestAnimationFrame(poll);
                };
                requestAnimationFrame(poll);
                return r;
            });
        }
        return origFetch.call(this, input, init);
    };
    window.__frames = null;
    window.__startFrames = () => {
        window.__frames = [];
        const tick = (t) => {
            if (!window.__frames) return;
            window.__frames.push(t);
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    };
    window.__stopFrames = () => {
        const f = window.__frames ?? [];
        window.__frames = null;
        const d = [];
        for (let i = 1; i < f.length; i++) d.push(f[i] - f[i - 1]);
        d.sort((a, b) => a - b);
        const total = f.length > 1 ? f[f.length - 1] - f[0] : 0;
        return {
            frames: d.length,
            p95: d.length ? d[Math.floor(d.length * 0.95)] : 0,
            max: d.length ? d[d.length - 1] : 0,
            janky: d.filter((x) => x > 50).length,
            // Time spent in frames longer than ~2 vsyncs, beyond the budget.
            jankMs: d.filter((x) => x > 34).reduce((s, x) => s + (x - 16.7), 0),
            fps: total > 0 ? (d.length / total) * 1000 : 0,
        };
    };
};

const newContext = async ({ state = true, sw = 'block' } = {}) => {
    const context = await browser.newContext({
        ...DEVICE,
        storageState: state && existsSync(STATE) ? STATE : undefined,
        serviceWorkers: sw,
    });
    await context.addInitScript(INSTRUMENT);
    return context;
};

const throttle = async (page) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
    if (NET) {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', NET);
    }
    return cdp;
};

const waitMark = (page, name, timeout = 60000) =>
    page.waitForFunction((n) => performance.getEntriesByName(`cleffy:${n}`).length > 0, name, { timeout });

const markTime = (page, name) =>
    page.evaluate((n) => {
        const e = performance.getEntriesByName(`cleffy:${n}`);
        return e.length ? e[e.length - 1].startTime : null;
    }, name);

/** Every card in the viewport shows its cover image. */
const coversVisible = (page, timeout = 60000) =>
    page.waitForFunction(
        () => {
            const cards = [...document.querySelectorAll('.library-card')].filter((c) => {
                const r = c.getBoundingClientRect();
                return r.bottom > 0 && r.top < innerHeight && r.width > 0;
            });
            if (cards.length === 0) return false;
            return cards.every((c) => {
                const img = c.querySelector('.library-card-cover img');
                return img && img.complete && img.naturalWidth > 0;
            });
        },
        null,
        { timeout, polling: 50 },
    );

const resourceStats = (page) =>
    page.evaluate(() => {
        const r = performance.getEntriesByType('resource');
        const nav = performance.getEntriesByType('navigation')[0];
        const js = r.filter((e) => e.initiatorType === 'script' || /\.js(\?|$)/.test(e.name));
        return {
            jsKB: Math.round(js.reduce((s, e) => s + (e.transferSize || 0), 0) / 1024),
            jsFiles: js.length,
            requests: r.length + 1,
            transferKB: Math.round(
                (r.reduce((s, e) => s + (e.transferSize || 0), 0) + (nav?.transferSize ?? 0)) / 1024,
            ),
        };
    });

const longTaskMs = (page, until = Infinity) =>
    page.evaluate(
        (u) => window.__long.filter((l) => l.start < u).reduce((s, l) => s + Math.max(0, l.dur - 50), 0),
        until,
    );

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** Logged out, first visit to the storefront. */
const landingCold = async () => {
    const context = await newContext({ state: false });
    const page = await context.newPage();
    await throttle(page);
    const t0 = Date.now();
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('main h1, h1'), null, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const paint = await page.evaluate(() => {
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
        return { fcp, lcp: window.__lcp };
    });
    const res = await resourceStats(page);
    const tbt = await longTaskMs(page);
    await context.close();
    return { ...paint, ...res, tbt, wall: Date.now() - t0 };
};

/** Signed in, first visit on this device: empty IndexedDB and HTTP cache. */
const libraryCold = async ({ sw = 'block' } = {}) => {
    const context = await newContext({ sw });
    const page = await context.newPage();
    await throttle(page);
    await page.goto(BASE + '/library', { waitUntil: 'commit' });
    await waitMark(page, 'library-network-paint');
    const networkPaint = await markTime(page, 'library-network-paint');
    await coversVisible(page);
    const coversAt = await page.evaluate(() => performance.now());
    await page.waitForTimeout(500);
    const fcp = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null);
    const res = await resourceStats(page);
    const tbt = await longTaskMs(page, coversAt);
    const lcp = await page.evaluate(() => window.__lcp);
    await context.close();
    return { fcp, networkPaint, coversAt, lcp, tbt, ...res };
};

/** Signed in, a return visit: IndexedDB snapshot + HTTP cache (+ service worker) warm. */
const libraryWarm = async () => {
    const context = await newContext({ sw: 'allow' });
    const page = await context.newPage();
    await throttle(page);
    await page.goto(BASE + '/library', { waitUntil: 'commit' });
    await waitMark(page, 'library-network-paint');
    await coversVisible(page);
    // Let the service worker finish precaching and Dexie writes settle.
    await page.waitForTimeout(NET ? 15000 : 4000);
    await page.goto(BASE + '/library', { waitUntil: 'commit' });
    await waitMark(page, 'library-network-paint');
    const cachePaint = await markTime(page, 'library-cache-paint');
    const networkPaint = await markTime(page, 'library-network-paint');
    await coversVisible(page);
    const coversAt = await page.evaluate(() => performance.now());
    const fcp = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null);
    const tbt = await longTaskMs(page, coversAt);
    await context.close();
    return { fcp, cachePaint, networkPaint, coversAt, tbt };
};

/**
 * Scroll the shelf to the end of a 650-score library: every "load more" page,
 * then measure what a long list costs an interaction (a favorite tap, typing).
 */
const libraryScroll = async () => {
    const context = await newContext();
    const page = await context.newPage();
    await throttle(page);
    await page.goto(BASE + '/library', { waitUntil: 'commit' });
    await waitMark(page, 'library-network-paint');
    await coversVisible(page);
    await page.waitForTimeout(500);

    await page.evaluate(() => window.__startFrames());
    const longBefore = await page.evaluate(() => window.__long.length);
    const scrollStart = Date.now();
    let stallMs = 0;
    for (let guard = 0; guard < 600; guard++) {
        // Steady scroll, ~2400 px/s, like a long fling.
        await page.evaluate(
            () =>
                new Promise((resolve) => {
                    let n = 0;
                    const step = () => {
                        window.scrollBy(0, 40);
                        if (++n < 30) requestAnimationFrame(step);
                        else resolve();
                    };
                    requestAnimationFrame(step);
                }),
        );
        // textContent on the buttons, not body.innerText: innerText lays out
        // the whole document (off-screen cards included) on every check.
        const done = await page.evaluate(
            () =>
                innerHeight + scrollY >= document.documentElement.scrollHeight - 4 &&
                ![...document.querySelectorAll('button')].some((b) =>
                    /Load more scores|Loading more/.test(b.textContent ?? ''),
                ),
        );
        if (done) break;
        const waiting = await page.evaluate(() => innerHeight + scrollY >= document.documentElement.scrollHeight - 4);
        if (waiting) {
            // At the bottom with more to come: the reader is waiting on older scores.
            const t = Date.now();
            await page.waitForTimeout(50);
            stallMs += Date.now() - t;
        }
    }
    await page.waitForTimeout(1000);
    const pageRecs = await page.evaluate(() => window.__pages.filter((p) => p.end && p.shown));
    const pageLoads = pageRecs.map((p) => p.shown - p.start);
    const rpcMs = pageRecs.map((p) => p.end - p.start);
    const scrollMs = Date.now() - scrollStart;
    const frames = await page.evaluate(() => window.__stopFrames());
    const scrollLong = await page.evaluate(
        (from) => window.__long.slice(from).reduce((s, l) => s + Math.max(0, l.dur - 50), 0),
        longBefore,
    );
    const cards = await page.evaluate(() => document.querySelectorAll('.library-card').length);
    const domNodes = await page.evaluate(() => document.getElementsByTagName('*').length);
    const heapMB = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null));

    // Interaction on a long list: tap a favorite star near the bottom, time to next frame.
    const favMs = await page.evaluate(async () => {
        const btns = [...document.querySelectorAll('.library-card button[aria-pressed]')].filter((b) => {
            const r = b.getBoundingClientRect();
            return r.top > 0 && r.bottom < innerHeight;
        });
        const b = btns[0];
        if (!b) return null;
        const t = performance.now();
        b.click();
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        return performance.now() - t;
    });
    // Typing into the search box: keystroke to next frame, averaged over 5 keys.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    const typeMs = await page.evaluate(async () => {
        const input = document.getElementById('library-search');
        if (!input) return null;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        let total = 0;
        const text = 'study';
        for (let i = 1; i <= text.length; i++) {
            const t = performance.now();
            setter.call(input, text.slice(0, i));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
            total += performance.now() - t;
        }
        return total / text.length;
    });
    await context.close();
    return {
        pages: pageLoads.length,
        pageLoadMed: median(pageLoads),
        pageLoadMax: Math.max(...pageLoads),
        rpcMed: median(rpcMs),
        stallMs,
        scrollMs,
        fps: frames.fps,
        p95Frame: frames.p95,
        maxFrame: frames.max,
        jankyFrames: frames.janky,
        scrollLongTaskMs: scrollLong,
        cards,
        domNodes,
        heapMB,
        favMs,
        typeMs,
    };
};

/**
 * A fast reader: fling down the shelf at ~3000 px/s (by the clock, whatever the
 * frame rate) until every page of the 650-score library is in. Measures how
 * long the reader sits at the bottom waiting for older scores.
 */
const libraryFling = async () => {
    const context = await newContext();
    const page = await context.newPage();
    await throttle(page);
    await page.goto(BASE + '/library', { waitUntil: 'commit' });
    await waitMark(page, 'library-network-paint');
    await coversVisible(page);
    await page.waitForTimeout(500);
    const r = await page.evaluate(
        () =>
            new Promise((resolve) => {
                const SPEED = 3; // px per ms
                let last = performance.now();
                let stall = 0;
                let stalls = 0;
                let atBottom = false;
                const start = last;
                const more = () =>
                    [...document.querySelectorAll('button')].some((b) =>
                        /Load more scores|Loading more/.test(b.textContent ?? ''),
                    );
                const step = (t) => {
                    const dt = t - last;
                    last = t;
                    const bottom = document.documentElement.scrollHeight - innerHeight;
                    if (scrollY >= bottom - 2) {
                        if (!more()) {
                            resolve({ stallMs: stall, stalls, totalMs: t - start });
                            return;
                        }
                        if (!atBottom) stalls++;
                        atBottom = true;
                        stall += dt;
                    } else {
                        atBottom = false;
                    }
                    window.scrollTo(0, Math.min(bottom, scrollY + dt * SPEED));
                    if (t - start > 120000) {
                        resolve({ stallMs: stall, stalls, totalMs: t - start, timedOut: 1 });
                        return;
                    }
                    requestAnimationFrame(step);
                };
                requestAnimationFrame(step);
            }),
    );
    await context.close();
    return r;
};

/** Pixel probe: has this page's pdf canvas been painted (dark ink on it)? */
const PAGE_PAINTED = (index) => {
    const c = document.querySelector(`canvas[data-page-index="${index}"]`);
    if (!c || c.width === 0 || c.height === 0) return false;
    const probe = document.createElement('canvas');
    probe.width = 48;
    probe.height = 64;
    const g = probe.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0, 48, 64);
    const d = g.getImageData(0, 0, 48, 64).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 140) dark++;
    return dark > 20;
};

/**
 * Library → score: tap the newest score's card and wait for page 1's pixels.
 * `warm`: the score was opened (and cached) before, in this same context.
 */
const openScore =
    (docId, { warm = false, sw = 'block', afterMs = 300 } = {}) =>
    async () => {
        const context = await newContext({ sw });
        const page = await context.newPage();
        await throttle(page);
        await page.goto(BASE + '/library', { waitUntil: 'commit' });
        await waitMark(page, 'library-network-paint');
        if (warm) {
            await page.goto(`${BASE}/doc/${docId}`, { waitUntil: 'commit' });
            await page.waitForFunction(PAGE_PAINTED, 0, { timeout: 120000, polling: 50 });
            // Wait for the full download to land in the offline cache.
            await page.waitForFunction(
                async (id) => {
                    const req = indexedDB.open('scribbler');
                    const db = await new Promise((r, j) => {
                        req.onsuccess = () => r(req.result);
                        req.onerror = () => j(req.error);
                    });
                    if (!db.objectStoreNames.contains('pdfCache')) return false;
                    const got = await new Promise((r) => {
                        const g = db.transaction('pdfCache').objectStore('pdfCache').get(id);
                        g.onsuccess = () => r(g.result);
                        g.onerror = () => r(null);
                    });
                    db.close();
                    return Boolean(got);
                },
                docId,
                { timeout: 120000, polling: 500 },
            );
            await page.goto(BASE + '/library', { waitUntil: 'commit' });
            await waitMark(page, 'library-network-paint');
        }
        await page.waitForTimeout(afterMs);
        const t0 = await page.evaluate(() => performance.now());
        await page.evaluate((id) => {
            const a = document.querySelector(`a[href="/doc/${id}"]`);
            if (a) a.click();
            else (history.pushState({}, '', `/doc/${id}`), dispatchEvent(new PopStateEvent('popstate')));
        }, docId);
        await page.waitForFunction(() => document.querySelector('canvas[data-page-index="0"]'), null, {
            timeout: 120000,
            polling: 16,
        });
        const canvasAt = await page.evaluate(() => performance.now());
        await page.waitForFunction(PAGE_PAINTED, 0, { timeout: 120000, polling: 16 });
        const paintedAt = await page.evaluate(() => performance.now());
        // The server's answer applied (role confirmed): editing and sync are live.
        const confirmedAt = await page
            .waitForFunction(
                (from) => performance.getEntriesByName('cleffy:viewer-confirmed').some((e) => e.startTime >= from),
                t0,
                { timeout: 30000, polling: 16 },
            )
            .then(() =>
                page.evaluate(
                    (from) =>
                        performance.getEntriesByName('cleffy:viewer-confirmed').find((e) => e.startTime >= from)
                            .startTime,
                    t0,
                ),
            )
            .catch(() => null);
        await page.waitForTimeout(1000);
        const tbt = await page.evaluate(
            (from) => window.__long.filter((l) => l.start >= from).reduce((s, l) => s + Math.max(0, l.dur - 50), 0),
            t0,
        );
        await context.close();
        return {
            toCanvas: canvasAt - t0,
            toFirstPage: paintedAt - t0,
            toConfirmed: confirmedAt === null ? null : confirmedAt - t0,
            tbt,
        };
    };

/**
 * Score reading: wheel down through the 24-page scan at reading speed and back
 * up, sampling how often a page in view is still blank, and frame pacing.
 */
const viewerScroll = async () => {
    const context = await newContext();
    const page = await context.newPage();
    await throttle(page);
    await page.goto(`${BASE}/doc/${NEWEST}`, { waitUntil: 'commit' });
    await page.waitForFunction(PAGE_PAINTED, 0, { timeout: 120000, polling: 50 });
    // Let the whole file land so the scroll measures rendering, not download.
    await page.waitForTimeout(NET ? 25000 : 3000);
    const result = await page.evaluate(async (paintedSrc) => {
        const painted = new Function(`return (${paintedSrc})`)();
        const surface = document.querySelector('.ink-surface');
        const r = surface.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        window.__startFrames();
        const longFrom = window.__long.length;
        let samples = 0;
        let blank = 0;
        const blankPages = new Set();
        const sampler = setInterval(() => {
            const vis = [...document.querySelectorAll('canvas[data-page-index]')].filter((c) => {
                const b = c.getBoundingClientRect();
                return b.bottom > r.top + 40 && b.top < r.bottom - 40;
            });
            samples++;
            const anyBlank = vis.some((c) => {
                const i = Number(c.dataset.pageIndex);
                const p = painted(i);
                if (!p) blankPages.add(i);
                return !p;
            });
            if (anyBlank || vis.length === 0) blank++;
        }, 100);
        const wheel = (dy) =>
            surface.dispatchEvent(
                new WheelEvent('wheel', { deltaY: dy, clientX: cx, clientY: cy, bubbles: true, cancelable: true }),
            );
        // Down: ~1800 px/s for 9 s, then back up for 5 s.
        const run = (dy, ms) =>
            new Promise((resolve) => {
                const end = performance.now() + ms;
                const step = () => {
                    wheel(dy);
                    if (performance.now() < end) requestAnimationFrame(step);
                    else resolve();
                };
                requestAnimationFrame(step);
            });
        await run(30, 9000);
        await run(-30, 5000);
        await new Promise((res) => setTimeout(res, 300));
        clearInterval(sampler);
        const frames = window.__stopFrames();
        const longMs = window.__long.slice(longFrom).reduce((s, l) => s + Math.max(0, l.dur - 50), 0);
        return { ...frames, blankRatio: blank / samples, blankPages: blankPages.size, longMs };
    }, PAGE_PAINTED.toString());
    await context.close();
    return result;
};

/**
 * The Account page with three scores downloaded to this device: time from
 * navigation until its offline-storage summary ("N scores downloaded…") shows.
 */
const accountWithCache = async () => {
    const context = await newContext();
    const page = await context.newPage();
    // Fill the offline cache first, unthrottled: two copies of the 23 MB scan
    // and the small vector score.
    for (const id of [
        'e0000000-0000-4000-8000-000000000001',
        'e0000000-0000-4000-8000-000000000002',
        'e0000000-0000-4000-8000-0000000001c2',
    ]) {
        await page.goto(`${BASE}/doc/${id}`, { waitUntil: 'commit' });
        await page.waitForFunction(
            async (docId) => {
                const req = indexedDB.open('scribbler');
                const db = await new Promise((r, j) => {
                    req.onsuccess = () => r(req.result);
                    req.onerror = () => j(req.error);
                });
                if (!db.objectStoreNames.contains('pdfCache')) return false;
                const got = await new Promise((r) => {
                    const g = db.transaction('pdfCache').objectStore('pdfCache').count(docId);
                    g.onsuccess = () => r(g.result);
                    g.onerror = () => r(0);
                });
                db.close();
                return got > 0;
            },
            id,
            { timeout: 120000, polling: 500 },
        );
    }
    await throttle(page);
    await page.goto(BASE + '/library', { waitUntil: 'commit' });
    await waitMark(page, 'library-network-paint');
    await page.waitForTimeout(1500);
    const t0 = await page.evaluate(() => performance.now());
    await page.evaluate(() => {
        history.pushState({}, '', '/account');
        dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForFunction(() => /downloaded to this device/.test(document.body.textContent ?? ''), null, {
        timeout: 60000,
        polling: 16,
    });
    const shownAt = await page.evaluate(() => performance.now());
    const tbt = await page.evaluate(
        (from) => window.__long.filter((l) => l.start >= from).reduce((s, l) => s + Math.max(0, l.dur - 50), 0),
        t0,
    );
    await context.close();
    return { toStorageSummary: shownAt - t0, tbt };
};

const SCENARIOS = {
    landingCold,
    libraryCold,
    // First visit as it really happens: the service worker installs and
    // precaches while the page loads its content.
    libraryColdSW: () => libraryCold({ sw: 'allow' }),
    libraryWarm,
    libraryScroll,
    libraryFling,
    openNewestCold: openScore(NEWEST),
    // The usual way in: look over the shelf for a few seconds, then tap.
    openNewestBrowse: openScore(NEWEST, { afterMs: 3000 }),
    openNewestWarmBrowse: openScore(NEWEST, { warm: true, afterMs: 3000 }),
    // Tap a score 3 s after the library appears, on a first visit with the
    // service worker precaching in the background.
    openNewestColdSW: openScore(NEWEST, { sw: 'allow', afterMs: 3000 }),
    openOldCold: openScore(OLD),
    openNewestWarm: openScore(NEWEST, { warm: true }),
    viewerScroll,
    accountWithCache,
};

// ---------------------------------------------------------------------------

const ensureLogin = async () => {
    if (existsSync(STATE)) return;
    const context = await browser.newContext(DEVICE);
    const page = await context.newPage();
    await page.goto(BASE + '/login');
    await page.fill('#login-email', 'teacher@cleffy.local');
    await page.fill('#login-password', 'cleffy-local-test');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/library', { timeout: 60000 });
    await page.waitForTimeout(1000);
    await context.storageState({ path: STATE });
    await context.close();
};

await ensureLogin();
const names = only ?? Object.keys(SCENARIOS);
const summary = {};
for (const name of names) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
        try {
            runs.push(await SCENARIOS[name]());
        } catch (err) {
            console.error(`${name} run ${i} failed:`, err.message.split('\n')[0]);
        }
    }
    const keys = [...new Set(runs.flatMap((r) => Object.keys(r)))];
    const med = Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]))]));
    summary[name] = med;
    const fmt = Object.entries(med)
        .map(([k, v]) => `${k}=${v === null ? '-' : Number.isInteger(v) ? v : v.toFixed(1)}`)
        .join(' ');
    console.log(`[${label}] ${name} (n=${runs.length}): ${fmt}`);
    appendFileSync(RESULTS, JSON.stringify({ label, name, at: new Date().toISOString(), runs, median: med }) + '\n');
}
writeFileSync(`${OUT}/summary-${label}.json`, JSON.stringify(summary, null, 2));
await browser.close();
