// Live two-browser collaboration test against the real Supabase project.
// The sandbox egress gateway TLS-fingerprints and resets browser clients, so
// all Supabase traffic is bridged through Node: context.route for HTTPS,
// routeWebSocket + undici WebSocket for realtime.
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { EnvHttpProxyAgent, fetch as ufetch, WebSocket as UWebSocket } from 'undici';
import { WebSocketServer } from 'ws';
import fs from 'node:fs';

// Run with: node --env-file=.env live-e2e.mjs (see .claude/skills/supabase-ops).
const URL_ = process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY;
const SECRET = process.env.SUPABASE_SECRET_KEY;
if (!URL_ || !ANON || !SECRET) {
    throw new Error(
        'Missing env: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SECRET_KEY (use node --env-file=.env)',
    );
}
const APP = process.env.E2E_APP_URL ?? 'http://localhost:5199';
const PDF = process.env.E2E_PDF ?? 'e2e-fixtures/test-score.pdf';
const ANNOTATED_PDF = process.env.E2E_ANNOTATED_PDF ?? 'e2e-fixtures/test-score-annotated.pdf';
const SHOT_DIR = process.env.E2E_SHOT_DIR ?? '.';
const SHOT = (n) => `${SHOT_DIR}/${n}.png`;

// The storage bridge substitutes upload bodies (CDP drops binary bodies);
// which file it substitutes follows whichever upload the script is doing.
let uploadSubstituteFile = PDF;

const dispatcher = new EnvHttpProxyAgent();
// supabase-js may resolve its bundled node-fetch (proxy-unaware) — force undici.
const proxiedFetch = (input, init) => ufetch(input, { ...init, dispatcher });

const results = [];
const check = (name, ok, detail = '') => {
    results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) process.exitCode = 1;
};

const inkPixels = (page, layer = 'committed') =>
    page.$eval(`canvas[data-ink-layer=${layer}]`, (el) => {
        if (el.width === 0) return 0;
        const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
        let n = 0;
        for (let p = 3; p < d.length; p += 4) if (d[p] > 0) n++;
        return n;
    });

/** Bridge a context's Supabase HTTPS + WSS through Node. */
const bridgeSupabase = async (context) => {
    // route.fetch() relays through Playwright's Node-side fetcher: binary
    // bodies survive (CDP postData is text-only) and the TLS is Node's, which
    // the egress gateway accepts. The context carries the proxy config.
    await context.route(`${URL_}/**`, async (route) => {
        const req = route.request();
        try {
            // CDP cannot carry binary request bodies out of the browser, so the
            // PDF upload arrives body-less. Sandbox-only substitution: send the
            // known test file's bytes ourselves (headers/auth stay the app's).
            if (/\/storage\/v1\/object\/scores\//.test(req.url()) && ['POST', 'PUT'].includes(req.method())) {
                const h = req.headers();
                const res = await ufetch(req.url(), {
                    method: req.method(),
                    headers: {
                        authorization: h['authorization'],
                        apikey: h['apikey'],
                        'content-type': 'application/pdf',
                        'cache-control': '3600',
                        'x-upsert': h['x-upsert'] ?? 'true',
                    },
                    body: fs.readFileSync(uploadSubstituteFile),
                    dispatcher,
                });
                const buf = Buffer.from(await res.arrayBuffer());
                await route.fulfill({ status: res.status, contentType: 'application/json', body: buf });
                return;
            }
            const response = await route.fetch();
            await route.fulfill({ response });
        } catch (err) {
            await route.abort('failed').catch(() => {});
            console.error('bridge error:', req.method(), req.url().slice(0, 90), '-', String(err).slice(0, 80));
        }
    });

    // WSS: the page's WebSocket URL is rewritten (init script) to the local
    // plain-ws relay below — no TLS from the browser, so nothing to fingerprint.
    await context.addInitScript(() => {
        const Original = window.WebSocket;
        window.WebSocket = class extends Original {
            constructor(url, protocols) {
                const s = String(url);
                super(
                    s.includes('supabase.co/realtime/v1/websocket')
                        ? s.replace(/^wss:\/\/[^/]+/, 'ws://127.0.0.1:8787')
                        : s,
                    protocols,
                );
            }
        };
    });
};

// Local plain-ws relay: browser → ws://127.0.0.1:8787 → (undici via proxy) → supabase.
const relay = new WebSocketServer({ host: '127.0.0.1', port: 8787 });
relay.on('connection', (client, req) => {
    const target = new UWebSocket(`${URL_.replace('https://', 'wss://')}${req.url}`, { dispatcher });
    const pending = [];
    target.addEventListener('open', () => {
        for (const m of pending) target.send(m);
        pending.length = 0;
    });
    client.on('message', (data, isBinary) => {
        const msg = isBinary ? data : data.toString();
        if (target.readyState === 1) target.send(msg);
        else pending.push(msg);
    });
    target.addEventListener('message', (event) => {
        void (async () => {
            const data =
                typeof event.data === 'string'
                    ? event.data
                    : Buffer.from(event.data instanceof Blob ? await event.data.arrayBuffer() : event.data);
            try {
                client.send(data);
            } catch {
                /* page closed */
            }
        })();
    });
    target.addEventListener('close', (e) =>
        client.close(e.code >= 1000 && e.code < 5000 ? e.code : 1000, e.reason || ''),
    );
    target.addEventListener('error', () => client.close(1011));
    client.on('close', () => {
        try {
            target.close();
        } catch {
            /* already closed */
        }
    });
});

// ---- 1. Teacher account + session (admin API; magic-link email is untestable here)
const admin = createClient(URL_, SECRET, { global: { fetch: proxiedFetch } });
const email = `teacher-${Date.now()}@example.com`;
const password = 'test-password-1234';
const { error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (createErr) throw new Error('admin createUser: ' + createErr.message);
const teacherAuth = createClient(URL_, ANON, { global: { fetch: proxiedFetch } });
const { data: signIn, error: signInErr } = await teacherAuth.auth.signInWithPassword({ email, password });
if (signInErr) throw new Error('password sign-in: ' + signInErr.message);
check('teacher account + session', Boolean(signIn.session));

// ---- 2. Browser contexts with the Supabase bridge
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const mkContext = async () => {
    const ctx = await browser.newContext({
        viewport: { width: 1100, height: 800 },
        // Proxy + CA trust are used by route.fetch() (Node side), not by the
        // browser: all Supabase traffic is intercepted before it hits Chromium's
        // network stack, and localhost (app + ws relay) bypasses the proxy.
        proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' },
        ignoreHTTPSErrors: true,
    });
    await bridgeSupabase(ctx);
    return ctx;
};

const teacherCtx = await mkContext();
const teacher = await teacherCtx.newPage();
const teacherErrors = [];
teacher.on('pageerror', (e) => teacherErrors.push(e.message.slice(0, 120)));
teacher.on('console', (m) => {
    if (['warning', 'error'].includes(m.type())) console.log('[teacher console]', m.text().slice(0, 160));
});
await teacher.goto(APP);
await teacher.evaluate(
    ([key, session]) => localStorage.setItem(key, session),
    [`sb-${new URL(URL_).hostname.split('.')[0]}-auth-token`, JSON.stringify(signIn.session)],
);
await teacher.reload();
await teacher.waitForSelector('text=Your scores', { timeout: 20000 });
check('teacher library loads', true);

// ---- 3. Upload a score
await teacher.locator('input[type=file]').first().setInputFiles(PDF);
try {
    await teacher.waitForURL(/\/doc\/[0-9a-f-]{36}/, { timeout: 30000 });
} catch (err) {
    await teacher.screenshot({ path: SHOT('upload-stuck') });
    console.log('upload stuck; body:', (await teacher.textContent('body'))?.replace(/\s+/g, ' ').slice(0, 200));
    throw err;
}
check('upload → viewer', true, teacher.url().split('/doc/')[1].slice(0, 8) + '…');
await teacher.waitForSelector('canvas[data-ink-layer=committed]', { timeout: 20000 });
await teacher.waitForTimeout(2000);

// ---- 4. Teacher draws; wait for synced dot
await teacher.mouse.move(350, 300);
await teacher.mouse.down();
for (let i = 1; i <= 15; i++) {
    await teacher.mouse.move(350 + i * 12, 300 + Math.sin(i / 2) * 30);
    await teacher.waitForTimeout(12);
}
await teacher.mouse.up();
await teacher.waitForSelector('[aria-label=Synced]', { timeout: 20000 });
check('teacher stroke synced to server', true);
const teacherInkStart = await inkPixels(teacher);

// ---- 5. Share link (edit)
await teacher.click('text=Share');
await teacher.click('text=Create link & copy');
await teacher.waitForSelector('span.truncate:has-text("/join/")', { timeout: 10000 });
const shareUrl = await teacher.$eval('li span.truncate', (el) => el.textContent);
await teacher.click('[aria-label=Close]');
check('share link created', Boolean(shareUrl?.includes('/join/')), shareUrl ?? '');

// ---- 6. Student joins via the link (anonymous + name)
const studentCtx = await mkContext();
const student = await studentCtx.newPage();
const studentErrors = [];
student.on('pageerror', (e) => studentErrors.push(e.message.slice(0, 120)));
student.on('console', (m) => {
    if (['warning', 'error'].includes(m.type())) console.log('[student console]', m.text().slice(0, 160));
});
await student.goto(shareUrl.replace(/^https?:\/\/[^/]+/, APP));
await student.waitForSelector('input#name', { timeout: 20000 });
await student.fill('input#name', 'Sharon');
await student.getByRole('button', { name: 'Join', exact: true }).click();
try {
    await student.waitForURL(/\/doc\//, { timeout: 30000 });
} catch (err) {
    await student.screenshot({ path: SHOT('join-stuck') });
    console.log('join stuck; body:', (await student.textContent('body'))?.replace(/\s+/g, ' ').slice(0, 200));
    throw err;
}
try {
    await student.waitForSelector('canvas[data-ink-layer=committed]', { timeout: 30000 });
} catch (err) {
    await student.screenshot({ path: SHOT('student-viewer-stuck') });
    console.log('student viewer stuck; body:', (await student.textContent('body'))?.replace(/\s+/g, ' ').slice(0, 250));
    throw err;
}
await student.waitForTimeout(3000);
check('student joined via link', true);

// ---- 7. Teacher's stroke is visible to the student (persistence + pull)
const studentSees = await inkPixels(student);
check("student sees teacher's stroke", studentSees > 100, `${studentSees} px`);

// ---- 8. Student draws; check LIVE streaming hits the teacher's live canvas mid-stroke
await student.mouse.move(400, 460);
await student.mouse.down();
for (let i = 1; i <= 14; i++) {
    await student.mouse.move(400 + i * 14, 460 + Math.cos(i / 2) * 24);
    await student.waitForTimeout(30);
}
const liveMidStroke = await inkPixels(teacher, 'live');
await student.mouse.up();
check('live ink streams mid-stroke', liveMidStroke > 0, `${liveMidStroke} px on teacher live canvas`);

// ---- 9. Committed stroke propagates teacher-ward (broadcast-from-database)
await teacher.waitForFunction(
    (before) => {
        const el = document.querySelector('canvas[data-ink-layer=committed]');
        if (!el || el.width === 0) return false;
        const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
        let n = 0;
        for (let p = 3; p < d.length; p += 4) if (d[p] > 0) n++;
        return n > before + 50;
    },
    teacherInkStart,
    { timeout: 20000 },
);
check("teacher sees student's committed stroke", true);
const teacherInkBoth = await inkPixels(teacher);

// ---- 10. Presence chips on both sides
const teacherPresence = await teacher.$('[aria-label*="collaborators viewing"]');
const studentPresence = await student.$('[aria-label*="collaborators viewing"]');
check('presence chips visible', Boolean(teacherPresence && studentPresence));

// ---- 11. Student (editor link) erases the TEACHER's stroke — the core requirement
await student.click('[aria-label=Eraser]');
await student.mouse.move(420, 300);
await student.mouse.down();
for (let i = 1; i <= 16; i++) {
    await student.mouse.move(350 + i * 12, 275 + i * 4);
    await student.waitForTimeout(18);
}
await student.mouse.up();
await teacher.waitForFunction(
    (before) => {
        const el = document.querySelector('canvas[data-ink-layer=committed]');
        if (!el || el.width === 0) return false;
        const d = el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
        let n = 0;
        for (let p = 3; p < d.length; p += 4) if (d[p] > 0) n++;
        return n < before;
    },
    teacherInkBoth,
    { timeout: 20000 },
);
check("student erased teacher's stroke; teacher converged", true, `${teacherInkBoth} → ${await inkPixels(teacher)} px`);

await teacher.screenshot({ path: SHOT('live-teacher') });
await student.screenshot({ path: SHOT('live-student') });

// ---- 12. Smart import: upload a pre-annotated score, adopt its marks
// (annotations-only accept — the storage bridge substitutes upload bodies, so
// the clean-and-replace upload leg can't be exercised faithfully here).
if (!fs.existsSync(ANNOTATED_PDF)) {
    const { execSync } = await import('node:child_process');
    execSync('node scripts/generate-annotated-fixture.mjs', { stdio: 'inherit' });
}
uploadSubstituteFile = ANNOTATED_PDF;
await teacher.goto(`${APP}/library`);
await teacher.waitForSelector('text=Your scores', { timeout: 20000 });
await teacher.locator('input[type=file]').first().setInputFiles(ANNOTATED_PDF);
try {
    await teacher.waitForSelector('text=Existing marks found', { timeout: 45000 });
    check('prescan offers the import after upload', true);
} catch (err) {
    await teacher.screenshot({ path: SHOT('import-prompt-stuck') });
    check('prescan offers the import after upload', false, String(err).slice(0, 100));
    throw err;
}
await teacher.getByRole('button', { name: 'Review marks' }).click();
await teacher.waitForURL(/\/doc\/[0-9a-f-]{36}/, { timeout: 30000 });
try {
    await teacher.waitForSelector('text=/Found/', { timeout: 60000 });
    check('scan reaches review', true);
} catch (err) {
    await teacher.screenshot({ path: SHOT('import-review-stuck') });
    check('scan reaches review', false, String(err).slice(0, 100));
    throw err;
}
// Annotations-only: skip the file replacement (see note above).
const cleanToggle = teacher.locator('label:has-text("Also lift the original ink") input');
if (await cleanToggle.count()) {
    await cleanToggle.uncheck();
}
await teacher.getByRole('button', { name: /Import \d+ marks/ }).click();
await teacher.waitForSelector('text=/Imported \\d+ marks/', { timeout: 30000 });
check('import commits marks', true);
await teacher.getByRole('button', { name: 'Done', exact: true }).click();
await teacher.waitForSelector('[aria-label=Synced]', { timeout: 30000 });
const importedInk = await inkPixels(teacher);
check('imported marks render on the committed layer', importedInk > 100, `${importedInk} px`);
await teacher.screenshot({ path: SHOT('live-import') });

check('no teacher page errors', teacherErrors.length === 0, teacherErrors.join('; '));
check('no student page errors', studentErrors.length === 0, studentErrors.join('; '));

await browser.close();
relay.close();
console.log('\n===== LIVE E2E RESULTS =====');
for (const line of results) console.log(line);
