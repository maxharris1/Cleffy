/**
 * Svix webhook signature verification — the scheme Resend uses for inbound mail.
 *
 * Implemented here rather than via the Svix or Resend SDK for the reason
 * `stripeSignature.ts` gives: this module has NO imports, so vitest loads it
 * without the `.ts` extension while Deno loads the same file with one, and the
 * rejection paths are covered by the suite that runs in CI. Verifying against an
 * SDK would only test the SDK.
 *
 * The scheme (Svix docs, "Verifying Webhooks"): three headers arrive —
 * `svix-id`, `svix-timestamp`, `svix-signature` — the signed content is
 * `"<id>.<timestamp>.<raw body>"`, and the signature is HMAC-SHA256 under the
 * endpoint secret, **base64**-encoded. `svix-signature` carries a
 * space-separated list of `v1,<sig>` entries, several while a secret is being
 * rotated; any match passes.
 *
 * Two details differ from Stripe's scheme and are easy to get wrong:
 *
 *  * the secret arrives as `whsec_<base64>` and the bytes that key the HMAC are
 *    the **decoded** remainder, not the ASCII of the string; and
 *  * digests are base64, not hex.
 */

export type SvixFailure =
    | 'missing_header'
    | 'malformed_timestamp'
    | 'no_v1_signature'
    | 'malformed_secret'
    | 'timestamp_out_of_tolerance'
    | 'signature_mismatch';

export type SvixCheck = { ok: true } | { ok: false; reason: SvixFailure };

/** Svix's own default replay window. */
export const DEFAULT_TOLERANCE_SEC = 300;

const encoder = new TextEncoder();

const toBase64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i] ?? 0);
    }
    return btoa(binary);
};

/** The key bytes are the base64 body of `whsec_…`; a bare secret is used as-is. */
export const secretKeyBytes = (secret: string): Uint8Array | null => {
    const body = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
    if (body.length === 0) {
        return null;
    }
    try {
        const binary = atob(body);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    } catch {
        return null;
    }
};

/**
 * Length-independent comparison. Both operands are fixed-length base64 digests,
 * so the early length exit leaks nothing an attacker does not already know.
 */
const timingSafeEqual = (a: string, b: string): boolean => {
    if (a.length !== b.length) {
        return false;
    }
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
};

/** `v1,<sig> v1,<sig>` -> the signatures. Versions other than v1 are ignored. */
export const parseSvixSignatures = (header: string): string[] => {
    const signatures: string[] = [];
    for (const part of header.split(' ')) {
        const comma = part.indexOf(',');
        if (comma <= 0) {
            continue;
        }
        if (part.slice(0, comma).trim() === 'v1') {
            const value = part.slice(comma + 1).trim();
            if (value.length > 0) {
                signatures.push(value);
            }
        }
    }
    return signatures;
};

/** HMAC-SHA256 of `${id}.${timestamp}.${payload}`, base64-encoded. */
export const computeSvixSignature = async (
    id: string,
    timestamp: string,
    payload: string,
    secret: string,
): Promise<string | null> => {
    const keyBytes = secretKeyBytes(secret);
    if (!keyBytes) {
        return null;
    }
    const key = await crypto.subtle.importKey(
        'raw',
        keyBytes as unknown as ArrayBuffer,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${id}.${timestamp}.${payload}`));
    return toBase64(mac);
};

/** Builds a valid `svix-signature` header — used by the tests. */
export const buildSvixSignatureHeader = async (
    id: string,
    timestamp: string,
    payload: string,
    secret: string,
): Promise<string | null> => {
    const sig = await computeSvixSignature(id, timestamp, payload, secret);
    return sig === null ? null : `v1,${sig}`;
};

export interface SvixHeaders {
    id: string | null;
    timestamp: string | null;
    signature: string | null;
}

/**
 * `payload` MUST be the raw request body exactly as received — re-serializing
 * parsed JSON changes the bytes and every signature then fails.
 */
export const verifySvixSignature = async (
    payload: string,
    headers: SvixHeaders,
    secret: string,
    nowSec: number,
    toleranceSec: number = DEFAULT_TOLERANCE_SEC,
): Promise<SvixCheck> => {
    const { id, timestamp, signature } = headers;
    if (!id || !timestamp || !signature) {
        return { ok: false, reason: 'missing_header' };
    }

    const sentAt = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(sentAt)) {
        return { ok: false, reason: 'malformed_timestamp' };
    }
    if (Math.abs(nowSec - sentAt) > toleranceSec) {
        return { ok: false, reason: 'timestamp_out_of_tolerance' };
    }

    const signatures = parseSvixSignatures(signature);
    if (signatures.length === 0) {
        return { ok: false, reason: 'no_v1_signature' };
    }

    const expected = await computeSvixSignature(id, timestamp, payload, secret);
    if (expected === null) {
        return { ok: false, reason: 'malformed_secret' };
    }

    for (const candidate of signatures) {
        if (timingSafeEqual(expected, candidate)) {
            return { ok: true };
        }
    }

    return { ok: false, reason: 'signature_mismatch' };
};
