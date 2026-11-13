/**
 * The signed-out viewer token for Share v2 (#104): a 10-minute JWT for the
 * anon role, carrying the general link it was minted for and nothing about a
 * person. The database honours it only through link_view_claims()
 * (20261113120100), which re-checks the link on every request and join.
 *
 * The only module that reads the signing key (plan R1). The key is the
 * project's HS256 JWT secret (SHARE_JWT_SECRET), or, on a project that signs
 * with asymmetric keys, a private JWK imported as a standby key in the
 * dashboard (SHARE_JWT_PRIVATE_JWK, ES256 or RS256, with its kid): D9.
 *
 * WebCrypto only, no imports.
 */

export type ViewerClaims = { doc: string; link: string; v: 1 };

export type ShareSigningKey =
    { alg: 'HS256'; key: CryptoKey } | { alg: 'ES256' | 'RS256'; kid: string; key: CryptoKey; verifyKey: CryptoKey };

export const VIEWER_TOKEN_TTL_SEC = 600;
export const VIEWER_TOKEN_ISSUER = 'cleffy-share';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string => {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64url = (text: string): Uint8Array | null => {
    if (!/^[A-Za-z0-9_-]*$/.test(text)) {
        return null;
    }
    try {
        const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
        return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    } catch {
        return null;
    }
};

const encodeJson = (value: unknown): string => base64url(encoder.encode(JSON.stringify(value)));

const decodeJson = (text: string): Record<string, unknown> | null => {
    const bytes = fromBase64url(text);
    if (!bytes) {
        return null;
    }
    try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
};

const ALGORITHMS = {
    ES256: { import: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
    RS256: {
        import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        sign: { name: 'RSASSA-PKCS1-v1_5' },
    },
} as const;

const signParams = (key: ShareSigningKey): AlgorithmIdentifier | EcdsaParams =>
    key.alg === 'HS256' ? 'HMAC' : ALGORITHMS[key.alg].sign;

const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];

const importJwk = async (raw: string): Promise<ShareSigningKey | null> => {
    let jwk: JsonWebKey & { kid?: unknown };
    try {
        jwk = JSON.parse(raw);
    } catch {
        return null;
    }
    const alg = jwk.kty === 'EC' && jwk.crv === 'P-256' ? 'ES256' : jwk.kty === 'RSA' ? 'RS256' : null;
    if (!alg || typeof jwk.kid !== 'string' || !jwk.kid || typeof jwk.d !== 'string') {
        return null;
    }
    const { kid, alg: _alg, key_ops: _ops, use: _use, ...material } = jwk as JsonWebKey & { kid: string };
    const publicJwk = Object.fromEntries(
        Object.entries(material).filter(([field]) => !PRIVATE_JWK_FIELDS.includes(field)),
    ) as JsonWebKey;
    try {
        const key = await crypto.subtle.importKey('jwk', material, ALGORITHMS[alg].import, false, ['sign']);
        const verifyKey = await crypto.subtle.importKey('jwk', publicJwk, ALGORITHMS[alg].import, false, ['verify']);
        return { alg, kid, key, verifyKey };
    } catch {
        return null;
    }
};

/** The signing key this deploy holds, or null when it holds none (share-session then mints nothing). */
export const shareSigningKey = async (env: (name: string) => string | undefined): Promise<ShareSigningKey | null> => {
    const jwk = env('SHARE_JWT_PRIVATE_JWK')?.trim();
    if (jwk) {
        return importJwk(jwk);
    }
    const secret = env('SHARE_JWT_SECRET');
    if (!secret || secret.length < 32) {
        return null;
    }
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
        'verify',
    ]);
    return { alg: 'HS256', key };
};

/**
 * `{iss, role:'anon', aud, iat, exp, cleffy_link}` and no `sub`: the token
 * names a link, never a person. `aud` is not required (spike f) but matches
 * every other token the project's PostgREST and Realtime see.
 */
export const signViewerJwt = async (
    key: ShareSigningKey,
    claims: ViewerClaims,
    nowSec: number,
): Promise<{ jwt: string; exp: number }> => {
    const iat = Math.floor(nowSec);
    const exp = iat + VIEWER_TOKEN_TTL_SEC;
    const header = key.alg === 'HS256' ? { alg: 'HS256', typ: 'JWT' } : { alg: key.alg, typ: 'JWT', kid: key.kid };
    const payload = {
        iss: VIEWER_TOKEN_ISSUER,
        role: 'anon',
        aud: 'authenticated',
        iat,
        exp,
        cleffy_link: { doc: claims.doc, link: claims.link, v: 1 },
    };
    const input = `${encodeJson(header)}.${encodeJson(payload)}`;
    const signature = new Uint8Array(await crypto.subtle.sign(signParams(key), key.key, encoder.encode(input)));
    return { jwt: `${input}.${base64url(signature)}`, exp };
};

/**
 * A viewer token this key signed, for a renewal: the claims when the
 * signature, issuer, role and shape hold and it expired no more than
 * `graceSec` ago; null otherwise.
 */
export const verifyViewerJwt = async (
    key: ShareSigningKey,
    jwt: string,
    nowSec: number,
    graceSec: number,
): Promise<ViewerClaims | null> => {
    const parts = typeof jwt === 'string' ? jwt.split('.') : [];
    if (parts.length !== 3) {
        return null;
    }
    const [headerText, payloadText, signatureText] = parts as [string, string, string];
    const header = decodeJson(headerText);
    const payload = decodeJson(payloadText);
    const signature = fromBase64url(signatureText);
    if (!header || !payload || !signature || header['alg'] !== key.alg) {
        return null;
    }
    if (key.alg !== 'HS256' && header['kid'] !== key.kid) {
        return null;
    }
    const verifyKey = key.alg === 'HS256' ? key.key : key.verifyKey;
    const valid = await crypto.subtle.verify(
        signParams(key),
        verifyKey,
        signature,
        encoder.encode(`${headerText}.${payloadText}`),
    );
    if (!valid) {
        return null;
    }
    const link = payload['cleffy_link'] as Record<string, unknown> | null | undefined;
    const exp = payload['exp'];
    if (
        payload['iss'] !== VIEWER_TOKEN_ISSUER ||
        payload['role'] !== 'anon' ||
        'sub' in payload ||
        typeof exp !== 'number' ||
        nowSec > exp + graceSec ||
        !link ||
        typeof link !== 'object' ||
        link['v'] !== 1 ||
        typeof link['doc'] !== 'string' ||
        typeof link['link'] !== 'string' ||
        !UUID.test(link['doc']) ||
        !UUID.test(link['link'])
    ) {
        return null;
    }
    return { doc: link['doc'], link: link['link'], v: 1 };
};

/** Lower-case hex SHA-256: the rate-limit key for a link id or token, never the value itself. */
export const sha256Hex = async (text: string): Promise<string> =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))), (b) =>
        b.toString(16).padStart(2, '0'),
    ).join('');
