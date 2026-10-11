// Time to page 1 of a first open (nothing on the device) of a large scanned
// score, under Chrome DevTools "Fast 3G" and 4x CPU throttling: the
// measurement behind src/features/viewer/pdf/progressiveDownload.ts.
//
// Everything is local. A generated scan (default 150 pages, about 16.7 MB:
// one ~111 KB JPEG per page, flat page tree, cross-reference table
// at the end, as IMSLP scans come) is served by a stand-in for Supabase
// (HTTP/2 over TLS like Supabase behind Cloudflare; auth, the PostgREST reads
// a cold open makes, a signed Storage URL answering GET and Range with 206,
// and CORS that exposes no response headers). The app is a production build
// served the way Vercel serves it: SPA rewrite, every vercel.json header
// (Content-Security-Policy included, its Supabase hosts swapped for the stand-
// in), text assets gzipped.
//
// DevTools network emulation set on the page does not reach a dedicated
// worker's own requests, so the pdf.js worker's script would load at local
// speed; the app server paces requests with `Sec-Fetch-Dest: worker` at Fast
// 3G's latency and rate itself (not shared with the page's budget, so this is
// still a little optimistic).
//
// Run (the build must call the stand-in, so it is built for this):
//   VITE_SUPABASE_URL=https://127.0.0.1:54521 VITE_SUPABASE_ANON_KEY=bench \
//       npx vite build --outDir /tmp/bench-dist
//   node scripts/bench-first-page.mjs /tmp/bench-dist
// Env: BENCH_RUNS (default 3), BENCH_PAGES (150), BENCH_SUPABASE_PORT (54521,
//      must match the build), BENCH_TTFB_MS (0): every Storage read waits this
//      long before its first byte, BENCH_MAX_CONCURRENT (unlimited): Storage
//      reads served at once, the rest queue; CHROMIUM_PATH; BENCH_VERBOSE=1
//      (page console on stderr); BENCH_SAVE_PDF=<file> (keep the score).
// Prints one JSON line per run and the medians. Needs `openssl` (a throwaway
// certificate for the two local HTTPS servers).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

import { chromium } from 'playwright';

const DIST = path.resolve(process.argv[2] ?? 'dist');
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const PAGES = Number(process.env.BENCH_PAGES ?? 150);
const SB_PORT = Number(process.env.BENCH_SUPABASE_PORT ?? 54521);
const TTFB = Number(process.env.BENCH_TTFB_MS ?? 0);
const MAX_CONCURRENT = Number(process.env.BENCH_MAX_CONCURRENT ?? 0) || Infinity;
const PAGE_BYTES = 111_000;

const FAST_3G = {
    offline: false,
    latency: 562.5,
    downloadThroughput: ((1.6 * 1024 * 1024) / 8) * 0.9,
    uploadThroughput: ((750 * 1024) / 8) * 0.9,
};

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`${DIST}/index.html is missing: build first (see the top of this file)`);
}
const SUPABASE = `https://127.0.0.1:${SB_PORT}`;
const builtFor = fs
    .readdirSync(path.join(DIST, 'assets'))
    .some(
        (name) => name.endsWith('.js') && fs.readFileSync(path.join(DIST, 'assets', name), 'utf8').includes(SUPABASE),
    );
if (!builtFor) {
    throw new Error(`${DIST} was not built with VITE_SUPABASE_URL=${SUPABASE}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-first-page-'));
const keyFile = path.join(tmp, 'key.pem');
const certFile = path.join(tmp, 'cert.pem');
execFileSync(
    'openssl',
    [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-keyout',
        keyFile,
        '-out',
        certFile,
    ],
    { stdio: 'ignore' },
);
const tls = { allowHTTP1: true, key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };

const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--ignore-certificate-errors'],
});

// ---- The score: page images drawn and JPEG-encoded by the browser. ----

const jpegs = await (async () => {
    const page = await browser.newPage();
    const pages = await page.evaluate(
        async ({ count, target }) => {
            let seed = 1;
            const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
            const canvas = document.createElement('canvas');
            canvas.width = 1275;
            canvas.height = 1650;
            const ctx = canvas.getContext('2d');
            const draw = (n) => {
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, 1275, 1650);
                ctx.fillStyle = '#000';
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 2;
                ctx.font = '28px serif';
                ctx.fillText(`page ${n + 1}`, 580, 50);
                for (let system = 0; system < 11; system++) {
                    const top = 90 + system * 140;
                    for (let i = 0; i < 5; i++) {
                        ctx.beginPath();
                        ctx.moveTo(70, top + i * 13);
                        ctx.lineTo(1205, top + i * 13);
                        ctx.stroke();
                    }
                    for (let k = 0; k < 30; k++) {
                        const x = 100 + k * 36 + random() * 12 - 6;
                        const y = top - 10 + random() * 60;
                        ctx.beginPath();
                        ctx.ellipse(x + 7, y + 5, 7, 5, 0, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.fillRect(x + 12, y - 36, 2, 41);
                    }
                }
                // Scanner grain: what makes a scan's pages ~100 KB each.
                for (let i = 0; i < 9000; i++) {
                    const v = (random() * 160) | 0;
                    ctx.fillStyle = `rgb(${v},${v},${v})`;
                    ctx.fillRect((random() * 1275) | 0, (random() * 1650) | 0, 2, 2);
                }
            };
            const encode = (quality) =>
                new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality)).then(
                    async (blob) => new Uint8Array(await blob.arrayBuffer()),
                );
            // The quality that makes page 1 about `target` bytes, for every page.
            draw(0);
            let low = 0.05;
            let high = 0.95;
            for (let i = 0; i < 12; i++) {
                const mid = (low + high) / 2;
                if ((await encode(mid)).byteLength > target) {
                    high = mid;
                } else {
                    low = mid;
                }
            }
            const out = [];
            for (let n = 0; n < count; n++) {
                draw(n);
                const bytes = await encode(low);
                let binary = '';
                for (let i = 0; i < bytes.length; i += 0x8000) {
                    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                }
                out.push(globalThis.btoa(binary));
            }
            return out;
        },
        { count: PAGES, target: PAGE_BYTES },
    );
    await page.close();
    return pages.map((b64) => Buffer.from(b64, 'base64'));
})();

const pdf = (() => {
    const objects = new Map();
    const kids = [];
    for (let p = 0; p < PAGES; p++) {
        const [pageObj, contentObj, imageObj] = [3 + 3 * p, 4 + 3 * p, 5 + 3 * p];
        kids.push(`${pageObj} 0 R`);
        const content = Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q');
        objects.set(
            pageObj,
            Buffer.from(
                `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObj} 0 R ` +
                    `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> >>`,
            ),
        );
        objects.set(
            contentObj,
            Buffer.concat([
                Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
                content,
                Buffer.from('\nendstream'),
            ]),
        );
        objects.set(
            imageObj,
            Buffer.concat([
                Buffer.from(
                    '<< /Type /XObject /Subtype /Image /Width 1275 /Height 1650 /ColorSpace /DeviceRGB ' +
                        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegs[p].length} >>\nstream\n`,
                ),
                jpegs[p],
                Buffer.from('\nendstream'),
            ]),
        );
    }
    objects.set(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
    objects.set(2, Buffer.from(`<< /Type /Pages /Count ${PAGES} /Kids [${kids.join(' ')}] >>`));
    const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let size = parts[0].length;
    const offsets = [];
    for (const n of [...objects.keys()].sort((a, b) => a - b)) {
        offsets[n] = size;
        const part = Buffer.concat([Buffer.from(`${n} 0 obj\n`), objects.get(n), Buffer.from('\nendobj\n')]);
        parts.push(part);
        size += part.length;
    }
    const count = objects.size + 1;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let n = 1; n < count; n++) {
        xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    parts.push(Buffer.from(xref));
    return Buffer.concat(parts);
})();
const pdfSha = createHash('sha256').update(pdf).digest('hex').slice(0, 16);
if (process.env.BENCH_SAVE_PDF) {
    fs.writeFileSync(process.env.BENCH_SAVE_PDF, pdf);
}

// ---- Supabase stand-in. ----

const USER_ID = '5f0e1d2c-3b4a-4968-8776-655443322110';
const DOC_ID = '0b7c2a8e-4f1d-4c3a-9e2b-5d6f7a8b9c01';
const docRow = {
    id: DOC_ID,
    owner_id: USER_ID,
    title: 'Bench score',
    storage_path: `${DOC_ID}/original.pdf`,
    page_count: PAGES,
    content_rev: 0,
    thumb_rev: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    archived_at: null,
    source_url: null,
    source_filename: null,
    source_license: null,
    source_attribution: null,
};
const storageLog = [];
let active = 0;
const queue = [];
const takeSlot = () =>
    new Promise((resolve) => {
        if (active < MAX_CONCURRENT) {
            active++;
            resolve();
        } else {
            queue.push(resolve);
        }
    });
const giveSlot = () => {
    const next = queue.shift();
    if (next) {
        next();
    } else {
        active--;
    }
};

const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
};

/** Piped in 64 KiB pieces: one 16 MB write overruns HTTP/2 session memory and resets the other streams. */
const send = (res, bytes) => {
    const pieces = function* () {
        for (let at = 0; at < bytes.length; at += 65536) {
            yield bytes.subarray(at, at + 65536);
        }
    };
    Readable.from(pieces()).pipe(res);
};

const serveScore = async (req, res) => {
    let closed = false;
    let holding = false;
    const done = () => {
        closed = true;
        if (holding) {
            holding = false;
            giveSlot();
        }
    };
    res.on('close', done);
    res.on('finish', done);
    await takeSlot();
    if (closed) {
        giveSlot();
        return;
    }
    holding = true;
    if (TTFB) {
        await new Promise((resolve) => setTimeout(resolve, TTFB));
        if (closed) {
            return;
        }
    }
    const range = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    storageLog.push(req.headers.range ?? null);
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), pdf.length - 1) : pdf.length - 1;
        res.writeHead(206, {
            ...cors,
            'Content-Type': 'application/pdf',
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${pdf.length}`,
        });
        send(res, pdf.subarray(start, end + 1));
        return;
    }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/pdf', 'Content-Length': pdf.length });
    send(res, pdf);
};

const supabase = http2.createSecureServer(tls, (req, res) => {
    const p = new URL(req.url, 'https://x').pathname;
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*',
            'Access-Control-Allow-Methods': 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS',
            'Access-Control-Max-Age': '3600',
        });
        res.end();
    } else if (p === `/storage/v1/object/sign/scores/${DOC_ID}/original.pdf`) {
        if (req.method === 'POST') {
            json(res, 200, { signedURL: `/object/sign/scores/${DOC_ID}/original.pdf?token=bench` });
        } else {
            void serveScore(req, res);
        }
    } else if (p === '/rest/v1/documents') {
        json(res, 200, [docRow]);
    } else if (p === '/rest/v1/document_members') {
        json(res, 200, [{ document_id: DOC_ID, user_id: USER_ID, role: 'owner', created_at: docRow.created_at }]);
    } else if (p.startsWith('/rest/v1/rpc/')) {
        json(res, 200, null);
    } else if (p.startsWith('/rest/v1/')) {
        json(res, 200, []);
    } else if (p === '/auth/v1/user') {
        json(res, 200, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'bench@example.com' });
    } else {
        json(res, 404, { error: 'not_found' });
    }
});
await new Promise((resolve) => supabase.listen(SB_PORT, '127.0.0.1', resolve));

// ---- The app, served like Vercel serves it. ----

const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const headersFor = (urlPath) => {
    const out = {};
    for (const rule of vercel.headers ?? []) {
        if (new RegExp(`^${rule.source}$`).test(urlPath)) {
            for (const { key, value } of rule.headers) {
                out[key] =
                    key === 'Content-Security-Policy'
                        ? value.replace(/(https|wss):\/\/[a-z]+\.supabase\.co/g, `$1://127.0.0.1:${SB_PORT}`)
                        : value;
            }
        }
    }
    return out;
};
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
};
const gzipped = new Map();
const app = http2.createSecureServer(tls, (req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'https://x').pathname);
    let file = path.join(DIST, urlPath);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html');
    }
    const ext = path.extname(file);
    let body = fs.readFileSync(file);
    const extra = {};
    if (['.html', '.js', '.mjs', '.css', '.json', '.svg', '.wasm'].includes(ext)) {
        if (!gzipped.has(file)) {
            gzipped.set(file, zlib.gzipSync(body, { level: 9 }));
        }
        body = gzipped.get(file);
        extra['Content-Encoding'] = 'gzip';
    }
    res.writeHead(200, {
        ...headersFor(urlPath),
        ...extra,
        'Content-Type': TYPES[ext] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    if (req.headers['sec-fetch-dest'] !== 'worker') {
        res.end(body);
        return;
    }
    // A worker's own requests escape the page's network emulation: pace them here.
    const rate = FAST_3G.downloadThroughput;
    let at = 0;
    const send = () => {
        if (res.closed) {
            return;
        }
        const piece = body.subarray(at, at + 16384);
        at += piece.length;
        if (at >= body.length) {
            res.end(piece);
        } else {
            res.write(piece);
            setTimeout(send, (piece.length / rate) * 1000);
        }
    };
    setTimeout(send, FAST_3G.latency);
});
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
const APP = `https://127.0.0.1:${app.address().port}`;

// ---- Runs. ----

const now = Math.floor(Date.now() / 1000);
const session = {
    access_token: 'bench.jwt.token',
    refresh_token: 'bench-refresh',
    token_type: 'bearer',
    expires_in: 36000,
    expires_at: now + 36000,
    user: {
        id: USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'bench@example.com',
        app_metadata: { provider: 'email' },
        user_metadata: {},
        is_anonymous: false,
        created_at: '2026-10-01T00:00:00Z',
    },
};

/** Page 1 counts as shown once its raster has ink on it. */
const pageOneShown = (page) =>
    page.waitForFunction(
        () => {
            const canvas = document.querySelector('canvas[data-page-index="0"]');
            if (!canvas || canvas.width === 0) {
                return false;
            }
            const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, Math.min(canvas.height, 400));
            for (let i = 0; i < data.length; i += 4 * 97) {
                if (data[i] < 100) {
                    return true;
                }
            }
            return false;
        },
        null,
        { timeout: 300_000, polling: 100 },
    );

/** The offline copy's hash, once the whole score is in IndexedDB. */
const offlineCopy = (page) =>
    page.evaluate(async (docId) => {
        const db = await new Promise((resolve) => {
            const req = globalThis.indexedDB.open('scribbler');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
        if (!db || !db.objectStoreNames.contains('pdfCache')) {
            db?.close();
            return null;
        }
        const row = await new Promise((resolve) => {
            const req = db.transaction('pdfCache').objectStore('pdfCache').get(docId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
        db.close();
        if (!row?.bytes) {
            return null;
        }
        const bytes = row.bytes instanceof Blob ? await row.bytes.arrayBuffer() : row.bytes;
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
            .slice(0, 16);
    }, DOC_ID);

const runOnce = async (run) => {
    const context = await browser.newContext({
        serviceWorkers: 'block',
        viewport: { width: 1200, height: 900 },
        ignoreHTTPSErrors: true,
    });
    await context.addInitScript(
        ([key, value]) => {
            if (!localStorage.getItem(key)) {
                localStorage.setItem(key, value);
            }
            window.__cspViolations = [];
            document.addEventListener('securitypolicyviolation', (e) =>
                window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`),
            );
        },
        ['sb-127-auth-token', JSON.stringify(session)],
    );
    const page = await context.newPage();
    if (process.env.BENCH_VERBOSE) {
        page.on('console', (message) => console.error(`[page ${message.type()}] ${message.text().slice(0, 300)}`));
        page.on('pageerror', (error) => console.error(`[page error] ${error.message}`));
    }
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', FAST_3G);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    storageLog.length = 0;

    const t0 = Date.now();
    let streamStart = null;
    page.on('request', (request) => {
        if (
            streamStart === null &&
            request.method() === 'GET' &&
            request.url().includes('/object/sign/') &&
            !request.headers().range
        ) {
            streamStart = Date.now() - t0;
        }
    });
    await page.goto(`${APP}/doc/${DOC_ID}`, { waitUntil: 'commit' });
    await pageOneShown(page);
    const firstPage = Date.now() - t0;
    const rangesBeforeFirstPage = storageLog.filter(Boolean);

    let copy = await offlineCopy(page);
    while (!copy) {
        if (Date.now() - t0 > 600_000) {
            throw new Error('the offline copy was never stored');
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        copy = await offlineCopy(page);
    }
    const offlineCopyAt = Date.now() - t0;
    const cspViolations = await page.evaluate(() => window.__cspViolations);
    await context.close();
    const bytes = rangesBeforeFirstPage.reduce((sum, range) => {
        const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range) ?? [];
        return sum + (to ? Number(to) - Number(from) + 1 : 0);
    }, 0);
    return {
        run,
        firstPage_ms: firstPage,
        firstPageAfterStreamStart_ms: streamStart === null ? null : firstPage - streamStart,
        rangeRequestsBeforeFirstPage: rangesBeforeFirstPage.length,
        rangeBytesBeforeFirstPage: bytes,
        offlineCopyStored_ms: offlineCopyAt,
        offlineCopyMatches: copy === pdfSha,
        cspViolations,
    };
};

console.log(
    JSON.stringify({ pages: PAGES, pdfBytes: pdf.length, ttfb_ms: TTFB, maxConcurrent: MAX_CONCURRENT, dist: DIST }),
);
const results = [];
try {
    for (let run = 1; run <= RUNS; run++) {
        const result = await runOnce(run);
        results.push(result);
        console.log(JSON.stringify(result));
    }
} finally {
    await browser.close();
    supabase.close();
    app.close();
    fs.unlinkSync(keyFile);
    fs.unlinkSync(certFile);
    fs.rmdirSync(tmp);
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(
    JSON.stringify({
        median_firstPage_ms: median(results.map((r) => r.firstPage_ms)),
        median_firstPageAfterStreamStart_ms: median(results.map((r) => r.firstPageAfterStreamStart_ms)),
        median_offlineCopyStored_ms: median(results.map((r) => r.offlineCopyStored_ms)),
        allOfflineCopiesMatch: results.every((r) => r.offlineCopyMatches),
        cspViolations: results.flatMap((r) => r.cspViolations),
    }),
);
process.exit(0);
