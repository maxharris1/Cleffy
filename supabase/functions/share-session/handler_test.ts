import { readCappedJson } from '../_shared/readCappedJson.ts';
import { sha256Hex, shareSigningKey, signViewerJwt } from '../_shared/shareSession.ts';
import { handleShareSession, type ResolvedLink, type ShareSessionDeps, viewerCapFrom } from './handler.ts';

const assert = (condition: unknown, message = 'assertion failed'): void => {
    if (!condition) throw new Error(message);
};

const SECRET = 'share-session-test-secret-at-least-32-chars';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const LINK = '0a5e0000-0000-4000-8000-000000000001';
const DOC = '0d0c0000-0000-4000-8000-000000000001';
const NOW = 1_794_000_000_000;

const liveViewer: ResolvedLink = {
    state: 'live',
    role: 'viewer',
    link_id: LINK,
    doc: { id: DOC, title: 'Sonata', page_count: 3, content_rev: 2 },
    pdf_path: `${DOC}/original.pdf`,
    link_expires_at: '2026-11-20T00:00:00Z',
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const post = (body: unknown) =>
    new Request('https://edge.test/functions/v1/share-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });

const harness = (
    options: {
        enabled?: boolean;
        link?: ResolvedLink | null;
        gates?: Record<string, boolean | 'error'>;
        cap?: number;
        pdf?: string | null;
    } = {},
) => {
    const keys: string[] = [];
    const resolved: string[] = [];
    const deps: ShareSessionDeps = {
        enabled: () => options.enabled ?? true,
        json,
        options: () => new Response('ok'),
        readJson: readCappedJson,
        resolve: (token) => {
            resolved.push(token);
            return Promise.resolve(options.link === undefined ? liveViewer : options.link);
        },
        checkRateLimit: (key, limit) => {
            keys.push(`${key}@${limit}`);
            const bucket = key.split(':')[0] ?? '';
            const gate = options.gates?.[bucket] ?? true;
            // An RPC failure reads as a refusal: checkRateLimit fails closed (rateLimit.ts).
            return Promise.resolve(gate === true ? { ok: true as const } : { ok: false as const, retryAfterSec: 5 });
        },
        signingKey: () => shareSigningKey((name) => (name === 'SHARE_JWT_SECRET' ? SECRET : undefined)),
        signedPdfUrl: (path) =>
            Promise.resolve(options.pdf === undefined ? `https://storage.test/${path}?sig=1` : options.pdf),
        viewerCap: options.cap ?? 40,
        now: () => NOW,
    };
    return { deps, keys, resolved };
};

const decode = (jwt: string): Record<string, unknown> =>
    JSON.parse(atob((jwt.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')));

Deno.test('answers 404 when SHARE_V2_ENABLED is unset, before reading anything', async () => {
    const h = harness({ enabled: false });
    const response = await handleShareSession(post({ token: TOKEN }), h.deps);
    assert(response.status === 404);
    assert(h.resolved.length === 0 && h.keys.length === 0);
});

Deno.test('refuses a body over 1 KB with 413', async () => {
    const h = harness();
    const response = await handleShareSession(post({ token: TOKEN, pad: 'x'.repeat(1100) }), h.deps);
    assert(response.status === 413);
    assert(h.resolved.length === 0);
});

Deno.test('a token of the wrong shape is invalid without a lookup', async () => {
    for (const token of ['short', 'AbCdEfGhIjKlMnOpQrStUv1', 'AbCdEfGhIjKlMnOpQrSt+/', 42]) {
        const h = harness();
        const response = await handleShareSession(post({ token }), h.deps);
        assert(response.status === 200);
        assert((await response.json()).state === 'invalid', String(token));
        assert(h.resolved.length === 0);
    }
});

Deno.test('an unknown or older link reads invalid; a dead general link gives only its state', async () => {
    const unknown = harness({ link: { state: 'invalid' } });
    const answer = await (await handleShareSession(post({ token: TOKEN }), unknown.deps)).json();
    assert(JSON.stringify(answer) === '{"state":"invalid"}');
    for (const state of ['revoked', 'unavailable'] as const) {
        const h = harness({ link: { state, link_id: LINK } });
        const response = await handleShareSession(post({ token: TOKEN }), h.deps);
        assert(response.status === 200);
        assert(JSON.stringify(await response.json()) === JSON.stringify({ state }), state);
        assert(!h.keys.some((key) => key.startsWith('share-viewers:')), state);
    }
});

Deno.test('an expired general link gives its state and the date it stopped, and mints nothing', async () => {
    const h = harness({ link: { state: 'expired', link_id: LINK, link_expires_at: '2026-11-20T00:00:00+00:00' } });
    const response = await handleShareSession(post({ token: TOKEN }), h.deps);
    assert(response.status === 200);
    assert(
        JSON.stringify(await response.json()) ===
            JSON.stringify({ state: 'expired', expired_at: '2026-11-20T00:00:00+00:00' }),
    );
    assert(!h.keys.some((key) => key.startsWith('share-viewers:')));
});

Deno.test('a failed lookup is 503', async () => {
    const response = await handleShareSession(post({ token: TOKEN }), harness({ link: null }).deps);
    assert(response.status === 503);
});

Deno.test('an editor link mints nothing', async () => {
    const h = harness({ link: { ...liveViewer, role: 'editor' } });
    const body = await (await handleShareSession(post({ token: TOKEN }), h.deps)).json();
    assert(body.state === 'live' && body.role === 'editor');
    assert(!('session_jwt' in body) && !('pdf_url' in body) && !('doc' in body));
    assert(!h.keys.some((key) => key.startsWith('share-viewers:')));
});

Deno.test('a live viewer link mints a 10-minute anon token naming the link and no person', async () => {
    const h = harness();
    const response = await handleShareSession(post({ token: TOKEN }), h.deps);
    assert(response.status === 200);
    const body = await response.json();
    assert(body.state === 'live' && body.role === 'viewer');
    assert(body.pdf_url === `https://storage.test/${DOC}/original.pdf?sig=1`);
    assert(body.doc.id === DOC && body.doc.title === 'Sonata');
    const claims = decode(body.session_jwt);
    assert(claims['iss'] === 'cleffy-share');
    assert(claims['role'] === 'anon');
    assert(!('sub' in claims));
    assert(JSON.stringify(claims['cleffy_link']) === JSON.stringify({ doc: DOC, link: LINK, v: 1 }));
    assert((claims['exp'] as number) - (claims['iat'] as number) === 600);
    assert(body.exp === claims['exp']);
});

Deno.test('the mint bucket fails closed: a refused or failed rate-limit check is 429', async () => {
    const h = harness({ gates: { 'share-mint': 'error' } });
    const response = await handleShareSession(post({ token: TOKEN }), h.deps);
    assert(response.status === 429);
    assert((await response.json()).reason === 'rate_limited');
});

Deno.test('past the viewer cap a new viewer gets 429 too_many_viewers with retry_after', async () => {
    const h = harness({ gates: { 'share-viewers': false }, cap: 7 });
    const response = await handleShareSession(post({ token: TOKEN }), h.deps);
    assert(response.status === 429);
    const body = await response.json();
    assert(body.reason === 'too_many_viewers' && body.retry_after === 5);
    assert(h.keys.some((key) => key.startsWith('share-viewers:') && key.endsWith('@7')));
});

Deno.test('a renewal with the same link skips the viewer bucket but not the mint bucket', async () => {
    const key = await shareSigningKey((name) => (name === 'SHARE_JWT_SECRET' ? SECRET : undefined));
    assert(key);
    const old = await signViewerJwt(key!, { doc: DOC, link: LINK, v: 1 }, NOW / 1000 - 700);
    const h = harness({ gates: { 'share-viewers': false } });
    const response = await handleShareSession(post({ token: TOKEN, renew: old.jwt }), h.deps);
    assert(response.status === 200);
    assert(h.keys.some((k) => k.startsWith('share-mint:')));
    assert(!h.keys.some((k) => k.startsWith('share-viewers:')));

    const otherLink = await signViewerJwt(
        key!,
        { doc: DOC, link: '0a5e0000-0000-4000-8000-000000000002', v: 1 },
        NOW / 1000,
    );
    const counted = harness({ gates: { 'share-viewers': false } });
    assert((await handleShareSession(post({ token: TOKEN, renew: otherLink.jwt }), counted.deps)).status === 429);

    const stale = await signViewerJwt(key!, { doc: DOC, link: LINK, v: 1 }, NOW / 1000 - 600 - 901);
    const late = harness({ gates: { 'share-viewers': false } });
    assert((await handleShareSession(post({ token: TOKEN, renew: stale.jwt }), late.deps)).status === 429);
});

Deno.test('bucket keys are the link id hash only: no IP, no token, no link id', async () => {
    const h = harness();
    await handleShareSession(post({ token: TOKEN }), h.deps);
    const hash = await sha256Hex(LINK);
    assert(h.keys.length === 2);
    for (const key of h.keys) {
        assert(key.split('@')[0]?.endsWith(`:${hash}`), key);
        assert(!key.includes('203.0.113.9') && !key.includes(TOKEN) && !key.includes(LINK), key);
    }
});

Deno.test('no signing key or no PDF URL is 503, not a token without a score', async () => {
    const h = harness();
    h.deps.signingKey = () => Promise.resolve(null);
    assert((await handleShareSession(post({ token: TOKEN }), h.deps)).status === 503);
    assert((await handleShareSession(post({ token: TOKEN }), harness({ pdf: null }).deps)).status === 503);
});

Deno.test('SHARE_VIEWER_CAP: a positive whole number, else 40', () => {
    assert(viewerCapFrom(undefined) === 40);
    assert(viewerCapFrom('') === 40);
    assert(viewerCapFrom('0') === 40);
    assert(viewerCapFrom('2.5') === 40);
    assert(viewerCapFrom('abc') === 40);
    assert(viewerCapFrom(' 60 ') === 60);
});
