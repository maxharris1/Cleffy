// Production-build smoke test for the security headers in vercel.json.
//
// Serves dist/ the way Vercel does (filesystem first, then the SPA rewrite to
// index.html) with EVERY header vercel.json declares, opens the public pages
// and a real score in Chromium, and fails on any Content-Security-Policy
// violation. The score is rendered through the app's own viewer: Supabase is
// answered by Playwright route handlers (signed-in owner, one document, the PDF
// bytes), which still exercises the policy — the browser checks connect-src
// before a request ever reaches a route handler.
//
// The fixture PDF is chosen to drive pdf.js down its fetched-data paths: a
// JPEG 2000 image (openjpeg.wasm via wasmUrl, needs 'wasm-unsafe-eval') and
// non-embedded Symbol (standardFontDataUrl; pdf.js substitutes system fonts for
// Helvetica and friends in a browser, but always fetches Symbol/ZapfDingbats).
//
// Also covered: the legal pages (/privacy, /terms, /account-deleted), the
// Account page and its delete-account dialog, the IMSLP "Source" dialog on an
// imported score, the fail-closed PDF export claim (claim_pdf_export) and the
// keyset library (library_documents).
//
// Run: npm run build && node scripts/csp-smoke.mjs
// Env: CSP_SMOKE_PDF (default e2e-fixtures/csp-jpx-standard-font.pdf),
//      CSP_SMOKE_DIST (default dist),
//      CSP_SMOKE_SENTRY=1 — the build was made with VITE_SENTRY_DSN pointing at
//      an *.ingest.us.sentry.io host: throw an uncaught error on the score and
//      require the SDK's report to leave the page (connect-src) with no
//      violation. The ingest request is answered locally, never sent.
//      CSP_SMOKE_SHOT_DIR (default: no screenshots),
//      CHROMIUM_PATH (default: Playwright's own browser),
//      CSP_SMOKE_OLD_BROWSER=1 — delete, in the page AND in the pdf.js worker,
//      every built-in src/lib/polyfills.ts provides, before any app code runs,
//      so the same run proves the polyfills carry a browser that lacks them
//      (Safari 17.x / iPadOS 17 is the oldest such target).
import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(process.env.CSP_SMOKE_DIST ?? 'dist');
const PDF = process.env.CSP_SMOKE_PDF ?? 'e2e-fixtures/csp-jpx-standard-font.pdf';
const SHOT_DIR = process.env.CSP_SMOKE_SHOT_DIR ?? '';
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

const OLD_BROWSER = process.env.CSP_SMOKE_OLD_BROWSER === '1';
const SENTRY = process.env.CSP_SMOKE_SENTRY === '1';

/**
 * Removes what an older Safari does not have. Kept in step with
 * src/lib/polyfills.ts: anything polyfilled there belongs here, or the
 * simulation proves less than it claims.
 */
const OLD_BROWSER_SHIM = `(() => {
    const iteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
    const slots = [
        [globalThis, 'Iterator'],
        [iteratorPrototype, 'some'],
        [iteratorPrototype, 'find'],
        [iteratorPrototype, 'filter'],
        [iteratorPrototype, 'toArray'],
        [Math, 'sumPrecise'],
        [Promise, 'try'],
        [Promise, 'withResolvers'],
        [Uint8Array.prototype, 'toHex'],
        [Map.prototype, 'getOrInsert'],
        [Map.prototype, 'getOrInsertComputed'],
        [WeakMap.prototype, 'getOrInsert'],
        [WeakMap.prototype, 'getOrInsertComputed'],
        [URL, 'parse'],
        [ArrayBuffer.prototype, 'transferToFixedLength'],
    ];
    for (const [target, name] of slots) {
        delete target[name];
        if (name in target) {
            throw new Error('old-browser simulation could not remove ' + name);
        }
    }
})();
`;

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    throw new Error('dist/index.html is missing — run `npm run build` first');
}

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
    '.mp3': 'audio/mpeg',
    '.ttf': 'font/ttf',
};

/** vercel.json `source` patterns are path-to-regexp; the ones we use are `/(.*)`-style. */
const headersFor = (urlPath) => {
    const out = {};
    for (const rule of vercel.headers ?? []) {
        if (new RegExp(`^${rule.source}$`).test(urlPath)) {
            for (const { key, value } of rule.headers) {
                out[key] = value;
            }
        }
    }
    return out;
};

const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        // Vercel serves the filesystem first; only a miss reaches the rewrite.
        file = path.join(ROOT, 'index.html');
    }
    res.writeHead(200, {
        ...headersFor(urlPath),
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    });
    fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, 'localhost', resolve));
const APP = `http://localhost:${server.address().port}`;

// localhost resolves to the dev project (src/lib/supabase.ts), so that is the
// host the app calls and the host the policy must allow.
const env = Object.fromEntries(
    fs
        .readFileSync('.env.production', 'utf8')
        .split('\n')
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);
const SUPABASE = env.VITE_SUPABASE_DEV_URL;
const REF = new URL(SUPABASE).hostname.split('.')[0];

const USER_ID = '11111111-1111-4111-8111-111111111111';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const now = new Date().toISOString();
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 3600;
const accessToken = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({
    sub: USER_ID,
    role: 'authenticated',
    aud: 'authenticated',
    email: 'csp-smoke@example.com',
    exp,
})}.c2lnbmF0dXJl`;
const user = {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'csp-smoke@example.com',
    app_metadata: { provider: 'email' },
    user_metadata: { display_name: 'CSP Smoke' },
    is_anonymous: false,
    created_at: now,
};
const session = {
    access_token: accessToken,
    refresh_token: 'csp-smoke-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: exp,
    user,
};
const docRow = {
    id: DOC_ID,
    owner_id: USER_ID,
    title: 'CSP smoke score',
    storage_path: `${DOC_ID}/original.pdf`,
    page_count: 1,
    content_rev: 0,
    thumb_rev: null,
    created_at: now,
    updated_at: now,
    archived_at: null,
    // An IMSLP import, so the viewer offers its "Source" dialog.
    source_url: 'https://imslp.org/wiki/Piano_Sonata_No.14_(Beethoven,_Ludwig_van)',
    source_filename: 'PMLP01458-Beethoven_Sonata_14.pdf',
    source_license: 'Public Domain',
    source_attribution: {
        source: 'imslp',
        work: 'Piano Sonata No.14 (Beethoven, Ludwig van)',
        composer: 'Beethoven, Ludwig van',
        editor: null,
        arranger: null,
        publisher: null,
        year: null,
    },
};
const entitlements = {
    user_id: USER_ID,
    tier: 'free',
    status: null,
    source: 'free',
    current_period_end: null,
    limits: {},
};

const json = (route, body, status = 200) =>
    route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(body),
    });

/** One PostgREST answer per table; anything else is an empty result. */
const restAnswer = (url, single) => {
    const table = url.pathname.replace('/rest/v1/', '');
    let rows = [];
    if (table === 'documents') {
        rows = [docRow];
    } else if (table === 'document_members') {
        rows = [{ document_id: DOC_ID, user_id: USER_ID, role: 'owner', created_at: now }];
    } else if (table === 'rpc/get_entitlements') {
        return entitlements;
    } else if (table === 'rpc/claim_pdf_export' || table === 'rpc/consume_pdf_export') {
        // The export is claimed before it is built and fails closed, so the
        // smoke must answer the claim or the PDF export never runs.
        return { ok: true, count: 1, limit: 10, tier: 'free', unlimited: false };
    } else if (table === 'rpc/library_documents') {
        return { documents: [docRow], has_more: false };
    } else if (table === 'rpc/library_bootstrap') {
        return { documents: [docRow], has_more: false, favorite_ids: [], tags: [], document_tags: [], entitlements };
    } else if (table.startsWith('rpc/')) {
        return null;
    }
    return single ? (rows[0] ?? null) : rows;
};

const results = [];
const check = (name, ok, detail = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) {
        process.exitCode = 1;
    }
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
// The old-browser run blocks the service worker so the pdf.js worker script is
// always fetched through the route below rather than from the precache.
const context = await browser.newContext({ serviceWorkers: OLD_BROWSER ? 'block' : 'allow', acceptDownloads: true });

let workerShimmed = 0;
if (OLD_BROWSER) {
    // Runs before any page script. The pdf.js worker is its own global scope,
    // which init scripts never reach, so its bundle gets the same shim prepended
    // (it is an IIFE, so the shim runs before the polyfill import inside it).
    await context.addInitScript(OLD_BROWSER_SHIM);
    await context.route(/\/assets\/pdfWorkerEntry-[\w-]+\.js$/, async (route) => {
        const response = await route.fetch();
        const body = await response.text();
        if (!body.startsWith('(function(){')) {
            throw new Error('pdf.js worker bundle is no longer an IIFE; prepending the shim would not run first');
        }
        workerShimmed += 1;
        await route.fulfill({ response, body: `${OLD_BROWSER_SHIM}${body}` });
    });
}

await context.route(`${SUPABASE}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') {
        return route.fulfill({
            status: 204,
            headers: {
                'access-control-allow-origin': '*',
                'access-control-allow-headers': '*',
                'access-control-allow-methods': '*',
            },
        });
    }
    if (url.pathname.startsWith('/auth/v1/user')) {
        return json(route, user);
    }
    if (url.pathname.startsWith('/auth/v1/token')) {
        return json(route, session);
    }
    if (url.pathname.startsWith('/storage/v1/object/') && url.pathname.endsWith('/original.pdf')) {
        return route.fulfill({
            status: 200,
            contentType: 'application/pdf',
            headers: { 'access-control-allow-origin': '*' },
            body: fs.readFileSync(PDF),
        });
    }
    if (url.pathname.startsWith('/rest/v1/')) {
        const single = (request.headers()['accept'] ?? '').includes('vnd.pgrst.object');
        return json(route, restAnswer(url, single));
    }
    if (url.pathname.startsWith('/storage/v1/')) {
        return json(route, { statusCode: '404', error: 'not_found', message: 'Object not found' }, 400);
    }
    return json(route, {});
});
// Realtime: accept the socket and say nothing — the viewer must still render.
await context.routeWebSocket(/\/realtime\/v1\/websocket/, () => {});

// Sentry's ingest, answered here. The browser checks connect-src before a
// request reaches a route handler, so a refused report still shows up as a
// violation; an allowed one is counted.
const sentryReports = [];
await context.route(/^https:\/\/[\w.-]+\.ingest(\.[a-z]+)?\.sentry\.io\//, (route) => {
    sentryReports.push(new URL(route.request().url()).hostname);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
});

// Worker fetches (wasm, fonts) are context requests too. The service worker's
// precache also downloads the wasm, so its requests must not count as pdf.js's.
const pdfjsData = new Map();
context.on('requestfinished', async (request) => {
    if (request.serviceWorker()) {
        return;
    }
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/pdfjs-')) {
        pdfjsData.set(pathname, (await request.response())?.status() ?? 0);
    }
});

const page = await context.newPage();
const violations = [];
// Chromium logs a header it cannot parse (e.g. an unknown Permissions-Policy
// feature) as a console error on every page load; that is a broken header too.
const headerErrors = [];
const consoleErrors = [];
page.on('console', (msg) => {
    const text = msg.text();
    if (/Content[- ]Security[- ]Policy|Refused to/i.test(text)) {
        violations.push(`[console] ${text}`);
    } else if (/^Error with [\w-]+ header/.test(text)) {
        headerErrors.push(text);
    } else if (msg.type() === 'error') {
        consoleErrors.push(text);
    }
});
page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message}`));
// Workers report their own violations only to their own console; the event
// below catches the document's, the console hook above catches both.
await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
        console.error(
            `Content-Security-Policy violation: ${event.violatedDirective} blocked ${event.blockedURI} (${event.sourceFile}:${event.lineNumber})`,
        );
    });
});
context.on('weberror', (err) => consoleErrors.push(`[weberror] ${err.error().message}`));

const visit = async (route, ready) => {
    const response = await page.goto(`${APP}${route}`, { waitUntil: 'load' });
    const csp = response?.headers()['content-security-policy'] ?? '';
    check(`${route} carries the CSP header`, csp.includes("script-src 'self'"));
    await ready();
    if (SHOT_DIR) {
        await page.screenshot({ path: path.join(SHOT_DIR, `csp${route.replaceAll('/', '_') || '_root'}.png`) });
    }
};

// Public pages first, signed out.
await visit('/', () => page.waitForSelector('main, #root > *', { timeout: 15_000 }));
await visit('/login', () => page.waitForSelector('#login-email', { timeout: 15_000 }));
await visit('/register', () => page.waitForSelector('#register-email', { timeout: 15_000 }));
await visit('/student', () => page.waitForSelector('input', { timeout: 15_000 }));
await visit('/privacy', () => page.getByRole('heading', { name: 'Privacy Policy' }).waitFor({ timeout: 15_000 }));
await visit('/terms', () => page.getByRole('heading', { name: 'Terms of Service' }).waitFor({ timeout: 15_000 }));
await visit('/account-deleted', () => page.waitForSelector('main, #root > *', { timeout: 15_000 }));

// Signed in: the session the app would have persisted, then the score.
await page.evaluate(
    ([key, value]) => localStorage.setItem(key, value),
    [`sb-${REF}-auth-token`, JSON.stringify(session)],
);
await visit(`/doc/${DOC_ID}`, async () => {
    await page.waitForSelector('canvas[data-page-index="0"]', { timeout: 30_000 });
    // Painted, not merely mounted: count dark pixels on the pdf.js raster.
    await page.waitForFunction(
        () => {
            const canvas = document.querySelector('canvas[data-page-index="0"]');
            if (!canvas || canvas.width === 0) {
                return false;
            }
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let dark = 0;
            for (let i = 0; i < data.length; i += 4) {
                if (data[i] < 96) {
                    dark += 1;
                }
            }
            return dark > 500;
        },
        null,
        { timeout: 30_000 },
    );
    // Give the decoders' and fonts' fetches time to report a refusal.
    await page.waitForTimeout(1500);
});
const ink = await page.$eval('canvas[data-page-index="0"]', (canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 96) {
            dark += 1;
        }
    }
    return { dark, width: canvas.width, height: canvas.height };
});
check('score page 1 rendered by pdf.js', ink.dark > 500, JSON.stringify(ink));
check(
    'openjpeg.wasm fetched (JPX decoded in wasm)',
    pdfjsData.get('/pdfjs-wasm/openjpeg.wasm') === 200,
    JSON.stringify([...pdfjsData]),
);
check(
    'standard font data fetched (non-embedded Symbol)',
    [...pdfjsData].some(([file, status]) => file.startsWith('/pdfjs-standard-fonts/') && status === 200),
);

// Exports: the page photo goes through pdf.js again, the PDF through pdf-lib
// in a module worker that fetches the music font. Both end in a download.
const exportVia = async (item) => {
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30_000 }),
        page.getByRole('menuitem', { name: item }).click(),
    ]);
    const file = await download.path();
    return fs.readFileSync(file);
};
// The imported score's provenance dialog (scope-imslp), for everyone on it.
await page.getByRole('button', { name: 'Source', exact: true }).click();
const sourceDialog = page.getByRole('dialog', { name: 'About this score' });
await sourceDialog.waitFor({ timeout: 10_000 });
check('IMSLP source dialog opens', (await sourceDialog.textContent())?.includes('Public Domain') ?? false);
await page.keyboard.press('Escape');
await sourceDialog.waitFor({ state: 'detached', timeout: 10_000 });

if (SENTRY) {
    // Thrown outside React and outside any handler: Sentry's global handler
    // reports it, which is an envelope POST to the DSN's ingest host.
    await page.evaluate(() =>
        setTimeout(() => {
            throw new Error('csp-smoke: deliberate uncaught error for the Sentry report');
        }, 0),
    );
    await page.waitForTimeout(3000);
    check('Sentry report reached the ingest host (connect-src)', sentryReports.length > 0, sentryReports.join(', '));
}

const png = await exportVia(/Share page 1 as photo/);
check('page photo export (pdf.js)', png.subarray(1, 4).toString() === 'PNG', `${png.length} bytes`);
const pdf = await exportVia(/Export whole score as PDF/);
check('annotated PDF export (pdf-lib worker)', pdf.subarray(0, 5).toString() === '%PDF-', `${pdf.length} bytes`);

// Library: the score is now in the byte cache, so its cover is rendered
// on-device by pdf.js (thumbnailRender) into a blob: image.
await visit('/library', () =>
    page.waitForFunction(() => [...document.images].some((img) => img.src.startsWith('blob:') && img.complete), null, {
        timeout: 30_000,
    }),
);
check('library cover rendered (pdf.js thumbnail, blob: image)', true);

// Account page (compliance): the delete-account dialog and its legal links.
await visit('/account', () => page.getByRole('button', { name: 'Delete account…' }).waitFor({ timeout: 15_000 }));
await page.getByRole('button', { name: 'Delete account…' }).click();
const deleteDialog = page.getByRole('dialog', { name: 'Delete your account?' });
await deleteDialog.waitFor({ timeout: 10_000 });
check('delete-account dialog opens', await deleteDialog.isVisible());
await page.keyboard.press('Escape');

if (OLD_BROWSER) {
    check('old-browser shim reached the pdf.js worker', workerShimmed > 0, `${workerShimmed} worker(s)`);
}
check('zero CSP violations', violations.length === 0, violations.join('\n    '));
check('every header parses', headerErrors.length === 0, [...new Set(headerErrors)].join('\n    '));

await browser.close();
server.close();

console.log(
    `${OLD_BROWSER ? '(old-browser simulation)\n' : ''}${SENTRY ? '(Sentry build)\n' : ''}${results.join('\n')}`,
);
if (consoleErrors.length) {
    console.log(`\n(non-CSP console errors, informational — Supabase is stubbed)\n  ${consoleErrors.join('\n  ')}`);
}
