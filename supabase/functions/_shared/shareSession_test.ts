import { shareSigningKey, signViewerJwt, verifyViewerJwt } from './shareSession.ts';

const assert = (condition: unknown, message = 'assertion failed'): void => {
    if (!condition) throw new Error(message);
};

const SECRET = 'share-session-test-secret-at-least-32-chars';
const CLAIMS = {
    doc: '0d0c0000-0000-4000-8000-000000000001',
    link: '0a5e0000-0000-4000-8000-000000000001',
    v: 1,
} as const;
const NOW = 1_794_000_000;

const hs = () => shareSigningKey((name) => (name === 'SHARE_JWT_SECRET' ? SECRET : undefined));

const segment = (jwt: string, index: number): Record<string, unknown> =>
    JSON.parse(atob((jwt.split('.')[index] ?? '').replace(/-/g, '+').replace(/_/g, '/')));

Deno.test('no key configured, or a short secret, gives no key', async () => {
    assert((await shareSigningKey(() => undefined)) === null);
    assert((await shareSigningKey((name) => (name === 'SHARE_JWT_SECRET' ? 'short' : undefined))) === null);
    assert((await shareSigningKey((name) => (name === 'SHARE_JWT_PRIVATE_JWK' ? '{"kty":"EC"}' : undefined))) === null);
});

Deno.test('HS256: the payload is iss, role anon, aud, iat, exp +600 and cleffy_link, with no sub', async () => {
    const key = await hs();
    assert(key?.alg === 'HS256');
    const { jwt, exp } = await signViewerJwt(key!, CLAIMS, NOW);
    const header = segment(jwt, 0);
    const payload = segment(jwt, 1);
    assert(header['alg'] === 'HS256' && header['typ'] === 'JWT');
    assert(
        JSON.stringify(Object.keys(payload).sort()) ===
            JSON.stringify(['aud', 'cleffy_link', 'exp', 'iat', 'iss', 'role']),
    );
    assert(payload['iss'] === 'cleffy-share' && payload['role'] === 'anon' && payload['aud'] === 'authenticated');
    assert(payload['iat'] === NOW && payload['exp'] === NOW + 600 && exp === NOW + 600);
    assert(JSON.stringify(payload['cleffy_link']) === JSON.stringify(CLAIMS));
});

Deno.test(
    'verify: accepts its own token within the grace, refuses tampering, other keys and late renewals',
    async () => {
        const key = (await hs())!;
        const { jwt } = await signViewerJwt(key, CLAIMS, NOW);
        assert(JSON.stringify(await verifyViewerJwt(key, jwt, NOW + 10, 0)) === JSON.stringify(CLAIMS));
        assert((await verifyViewerJwt(key, jwt, NOW + 600 + 900, 900)) !== null);
        assert((await verifyViewerJwt(key, jwt, NOW + 600 + 901, 900)) === null);

        const [h, p, s] = jwt.split('.');
        const forged = btoa(JSON.stringify({ ...segment(jwt, 1), sub: 'someone' }))
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
        assert((await verifyViewerJwt(key, `${h}.${forged}.${s}`, NOW, 0)) === null);
        assert((await verifyViewerJwt(key, `${h}.${p}`, NOW, 0)) === null);
        assert((await verifyViewerJwt(key, 'not.a.jwt', NOW, 0)) === null);

        const other = (await shareSigningKey((name) =>
            name === 'SHARE_JWT_SECRET' ? 'another-secret-that-is-at-least-32-characters' : undefined,
        ))!;
        assert((await verifyViewerJwt(other, jwt, NOW, 0)) === null);
    },
);

Deno.test('ES256 from a private JWK: header carries kid, and the token verifies with the public half', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.privateKey)), kid: 'cleffy-share-1' };
    const key = await shareSigningKey((name) => (name === 'SHARE_JWT_PRIVATE_JWK' ? JSON.stringify(jwk) : undefined));
    assert(key?.alg === 'ES256');
    const { jwt } = await signViewerJwt(key!, CLAIMS, NOW);
    const header = segment(jwt, 0);
    assert(header['alg'] === 'ES256' && header['kid'] === 'cleffy-share-1');
    const [h, p, s] = jwt.split('.');
    const signature = Uint8Array.from(atob((s ?? '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    assert(
        await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            pair.publicKey,
            signature,
            new TextEncoder().encode(`${h}.${p}`),
        ),
    );
    assert((await verifyViewerJwt(key!, jwt, NOW, 0)) !== null);
});

Deno.test('a private JWK without a kid is refused (D9: the standby key is named)', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    assert(
        (await shareSigningKey((name) => (name === 'SHARE_JWT_PRIVATE_JWK' ? JSON.stringify(jwk) : undefined))) ===
            null,
    );
});
