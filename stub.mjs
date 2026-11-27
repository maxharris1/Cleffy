const API = 'http://127.0.0.1:54421';
const now = Math.floor(Date.now() / 1000);
export const user = {
    id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated',
    email: 'teacher@cleffy.local', created_at: '2026-01-14T10:00:00Z',
    app_metadata: { provider: 'email' }, user_metadata: { display_name: 'Ada Teacher' },
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, role: 'authenticated', exp: now + 86400, aud: 'authenticated', email: user.email })}.sig`;
const session = { access_token: jwt, token_type: 'bearer', expires_in: 86400, expires_at: now + 86400, refresh_token: 'r', user };
export const seen = new Set();
export async function stub(page, handlers = {}) {
    await page.route(`${API}/**`, async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const key = `${req.method()} ${url.pathname}`;
        seen.add(key + url.search.slice(0, 80));
        const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-range': '*/0' }, body: JSON.stringify(body) });
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
        if (url.pathname === '/auth/v1/token') return json(session);
        if (url.pathname === '/auth/v1/user') return json(user);
        for (const [path, h] of Object.entries(handlers)) if (url.pathname.endsWith(path)) return json(typeof h === 'function' ? h(url, req) : h);
        return json([]);
    });
}
