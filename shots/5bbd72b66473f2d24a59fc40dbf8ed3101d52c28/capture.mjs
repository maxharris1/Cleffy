import fs from 'node:fs';
const { open, stubApi, close, reply, API, STUB_USER } = await import(process.env.UIFUZZ);

const BASE = process.env.CLEFFY_UI_BASE;
const OUT = process.env.CLEFFY_UI_SHOTS;
const ONLY = process.env.ONLY;
const PDF = fs.readFileSync(process.env.SCORE_PDF);
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const VIEWPORTS = ['desktop-1440', 'ipad-portrait', 'iphone-14'];

const doc = {
    id: DOC_ID,
    owner_id: STUB_USER.id,
    title: 'Erik Satie — Gymnopédie No. 1',
    storage_path: `${DOC_ID}/original.pdf`,
    page_count: null,
    content_rev: 0,
    thumb_rev: null,
    created_at: '2026-11-20T10:00:00Z',
    updated_at: '2026-11-20T10:00:00Z',
    archived_at: null,
};
const student = {
    ...STUB_USER,
    id: '00000000-0000-4000-8000-000000000002',
    email: 'student@cleffy.local',
    app_metadata: { provider: 'email', user_type: 'student' },
    user_metadata: { display_name: 'Sam Student' },
};

const one = (row) => (url, request) =>
    (request.headers()['accept'] ?? '').includes('vnd.pgrst.object') ? row : row ? [row] : [];

const viewerHandlers = (role, userId, extra = {}) => ({
    '/rest/v1/documents': one({ ...doc }),
    '/rest/v1/document_members': one({ document_id: DOC_ID, user_id: userId, role }),
    '/rest/v1/rpc/caller_seat_read_only': false,
    ...extra,
});

const servePdf = (page) =>
    page.route(`${API}/storage/v1/object/sign/**`, (route) =>
        route.request().method() === 'GET'
            ? route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF, headers: { 'access-control-allow-origin': '*', 'accept-ranges': 'none' } })
            : route.fallback(),
    );

const signIn = async (page, user) => {
    if (user) {
        const exp = Math.floor(Date.now() / 1000) + 86400;
        const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, role: 'authenticated', aud: 'authenticated', email: user.email, exp, app_metadata: user.app_metadata })}.sig`;
        const session = { access_token: jwt, token_type: 'bearer', expires_in: 86400, expires_at: exp, refresh_token: 'r', user };
        await page.route(`${API}/auth/v1/**`, (route) =>
            route.request().method() === 'OPTIONS'
                ? route.fallback()
                : route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(route.request().url().includes('/token') ? session : user) }),
        );
    }
    await page.goto(BASE + '/login');
    await page.fill('#login-email', user?.email ?? STUB_USER.email);
    await page.fill('#login-password', 'cleffy-local-test');
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
};

const SIGN = { '/original.pdf': { signedURL: `/object/sign/scores/${DOC_ID}/original.pdf?token=t` } };

const linkDoc = { id: DOC_ID, title: doc.title, page_count: null, content_rev: 0 };

const stubLink = async (page, lifeSec) => {
    await stubApi(page, {
        '/functions/v1/share-session': () => {
            const life = lifeSec();
            return life === null
                ? reply(429, { error: 'busy', retry_after: 45 })
                : {
                      state: 'live',
                      role: 'viewer',
                      session_jwt: 'link.viewer.jwt',
                      exp: Math.floor(Date.now() / 1000) + life,
                      doc: linkDoc,
                      pdf_url: `http://kong:8000/storage/v1/object/sign/scores/${DOC_ID}/original.pdf?token=t`,
                      link_expires_at: null,
                  };
        },
        '/rest/v1/rpc/link_view_access': { status: 'open', epoch: 1, link_expires_at: null },
        '/rest/v1/rpc/link_view_snapshot': { doc: linkDoc, marks: [], max_seq: 0, more: false },
    });
    await servePdf(page);
};

const snapshotRow = {
    id: '22222222-2222-4222-8222-222222222222',
    document_id: DOC_ID,
    captured_on: '2026-11-19',
    label: null,
    payload: [],
    created_at: '2026-11-19T15:00:00Z',
    created_by: STUB_USER.id,
};

const holdInkThenSignOutElsewhere = async ({ docId, userId }) => {
    const { holdOps } = await import('/src/sync/inkRecovery.ts');
    const { getDb } = await import('/src/sync/db.ts');
    const at = new Date().toISOString();
    const mark = (n) => ({
        id: `33333333-3333-4333-8333-33333333333${n}`,
        docId,
        page: 0,
        kind: 'pen',
        color: '#1f2937',
        payload: { points: [[100, 100, 0.5], [160, 120, 0.5]], width: 2 },
        createdBy: userId,
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
        seq: 0,
    });
    holdOps(getDb(), docId, [1, 2, 3].map((n) => ({ op: { type: 'create', annotation: mark(n) }, author: userId })));
    new BroadcastChannel('cleffy:ink-recovery').postMessage({ type: 'account-signed-out', userId });
};

const scenes = {
    owner: async (page) => {
        await stubApi(page, viewerHandlers('owner', STUB_USER.id, SIGN));
        await servePdf(page);
        await signIn(page);
        await page.goto(`${BASE}/doc/${DOC_ID}`);
        await page.locator('canvas').first().waitFor({ timeout: 20000 });
        await page.waitForTimeout(2500);
    },
    student: async (page) => {
        await stubApi(page, viewerHandlers('viewer', student.id, SIGN));
        await servePdf(page);
        await signIn(page, student);
        await page.goto(`${BASE}/doc/${DOC_ID}`);
        await page.locator('canvas').first().waitFor({ timeout: 20000 });
        await page.waitForTimeout(2500);
    },
    link: async (page) => {
        await stubLink(page, () => 3600);
        await page.goto(`${BASE}/s#AbCdEfGhIjKlMnOpQrSt`);
        await page.locator('canvas').first().waitFor({ timeout: 20000 });
        await page.waitForTimeout(2500);
    },
    'link-busy': async (page) => {
        let busy = false;
        await stubLink(page, () => (busy ? null : 3));
        await page.goto(`${BASE}/s#AbCdEfGhIjKlMnOpQrSt`);
        await page.locator('canvas').first().waitFor({ timeout: 20000 });
        busy = true;
        await page.getByText('Lots of people are on this score right now.').waitFor({ timeout: 20000 });
        await page.waitForTimeout(1200);
    },
    'starting-point': async (page) => {
        await stubApi(page, viewerHandlers('owner', STUB_USER.id, { ...SIGN, '/rest/v1/annotation_snapshots': [snapshotRow] }));
        await servePdf(page);
        await signIn(page);
        await page.goto(`${BASE}/doc/${DOC_ID}`);
        await page.locator('canvas').first().waitFor({ timeout: 20000 });
        await page.getByRole('button', { name: 'History', exact: true }).click();
        await page.getByRole('button', { name: 'View', exact: true }).click();
        await page.getByText('Viewing day starting point').waitFor({ timeout: 20000 });
        await page.waitForTimeout(2500);
    },
    'signed-out-ink': async (page) => {
        await stubApi(page, viewerHandlers('owner', STUB_USER.id, SIGN));
        await servePdf(page);
        await signIn(page);
        await page.goto(`${BASE}/doc/${DOC_ID}`);
        await page.locator('canvas').first().waitFor({ timeout: 20000 });
        await page.waitForTimeout(2000);
        await page.evaluate(holdInkThenSignOutElsewhere, { docId: DOC_ID, userId: STUB_USER.id });
        await page.getByRole('status').filter({ hasText: 'signed out in another tab' }).waitFor({ timeout: 20000 });
        await page.waitForTimeout(600);
    },
    loading: async (page) => {
        await stubApi(page, viewerHandlers('owner', STUB_USER.id, SIGN));
        await signIn(page);
        await page.route(`${API}/rest/v1/documents**`, () => new Promise(() => {}));
        await page.goto(`${BASE}/doc/${DOC_ID}`);
        await page.getByText('Opening score…').waitFor({ timeout: 20000 });
        await page.waitForTimeout(600);
    },
    error: async (page) => {
        await stubApi(page, viewerHandlers('owner', STUB_USER.id, { ...SIGN, '/rest/v1/documents': one(null), '/rest/v1/document_members': one(null) }));
        await signIn(page);
        await page.goto(`${BASE}/doc/${DOC_ID}`);
        await page.getByText('Score not found').waitFor({ timeout: 20000 });
        await page.waitForTimeout(400);
    },
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, scene] of Object.entries(scenes)) {
    if (ONLY && !ONLY.split(',').includes(name)) continue;
    for (const vp of VIEWPORTS) {
        const { page, context, consoleErrors } = await open(vp);
        try {
            await scene(page);
            const path = `${OUT}/${name}-${vp}.png`;
            await page.screenshot({ path });
            console.log('OK', name, vp, path);
        } catch (e) {
            await page.screenshot({ path: `${OUT}/FAILED-${name}-${vp}.png` }).catch(() => {});
            console.log('FAIL', name, vp, e.message.split('\n')[0], consoleErrors.slice(0, 3).map((s) => s.slice(0, 200)));
        }
        await context.close();
    }
}
await close();
