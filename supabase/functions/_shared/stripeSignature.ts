/**
 * Stripe webhook signature verification.
 *
 * Implemented here rather than via the Stripe SDK for one reason: this module
 * has NO imports, so vitest can load it (`tests/billing/webhook.test.ts`, via a
 * path without the `.ts` extension) while Deno loads the exact same file with
 * the extension. Rejection paths are therefore covered by the same suite that
 * runs in CI — verifying against the SDK would only test the SDK.
 *
 * The scheme (Stripe docs, "Verify webhook signatures manually"): the header is
 * `t=<unix>,v1=<hex hmac>[,v1=<hex hmac>…]`, and the signed payload is
 * `"<t>.<raw body>"` under HMAC-SHA256 with the endpoint's signing secret.
 * Multiple v1 entries appear while a secret is being rotated; any match passes.
 */

export type SignatureFailure =
    'missing_header' | 'malformed_header' | 'no_v1_signature' | 'timestamp_out_of_tolerance' | 'signature_mismatch';

export type SignatureCheck = { ok: true } | { ok: false; reason: SignatureFailure };

/** Stripe's own default replay window. */
export const DEFAULT_TOLERANCE_SEC = 300;

const encoder = new TextEncoder();

const toHex = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
        out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
    }
    return out;
};

/**
 * Length-independent comparison. Both operands here are fixed-length hex
 * digests, so the early length exit leaks nothing an attacker does not know.
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

export interface ParsedSignatureHeader {
    timestamp: number | null;
    signatures: string[];
}

export const parseSignatureHeader = (header: string): ParsedSignatureHeader => {
    let timestamp: number | null = null;
    const signatures: string[] = [];

    for (const part of header.split(',')) {
        const eq = part.indexOf('=');
        if (eq <= 0) {
            continue;
        }
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (key === 't') {
            const parsed = Number.parseInt(value, 10);
            timestamp = Number.isFinite(parsed) ? parsed : null;
        } else if (key === 'v1') {
            signatures.push(value);
        }
    }

    return { timestamp, signatures };
};

/** HMAC-SHA256 of `${timestamp}.${payload}`, hex-encoded — Stripe's v1 scheme. */
export const computeStripeSignature = async (timestamp: number, payload: string, secret: string): Promise<string> => {
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
    ]);
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`));
    return toHex(mac);
};

/** Builds a valid `Stripe-Signature` header — used by tests and `stripe listen` parity checks. */
export const buildSignatureHeader = async (timestamp: number, payload: string, secret: string): Promise<string> =>
    `t=${timestamp},v1=${await computeStripeSignature(timestamp, payload, secret)}`;

/**
 * `payload` MUST be the raw request body exactly as received — re-serializing
 * parsed JSON changes the bytes and every signature then fails.
 */
export const verifyStripeSignature = async (
    payload: string,
    header: string | null,
    secret: string,
    nowSec: number,
    toleranceSec: number = DEFAULT_TOLERANCE_SEC,
): Promise<SignatureCheck> => {
    if (!header) {
        return { ok: false, reason: 'missing_header' };
    }

    const { timestamp, signatures } = parseSignatureHeader(header);
    if (timestamp === null) {
        return { ok: false, reason: 'malformed_header' };
    }
    if (signatures.length === 0) {
        return { ok: false, reason: 'no_v1_signature' };
    }
    if (Math.abs(nowSec - timestamp) > toleranceSec) {
        return { ok: false, reason: 'timestamp_out_of_tolerance' };
    }

    const expected = await computeStripeSignature(timestamp, payload, secret);
    for (const candidate of signatures) {
        if (timingSafeEqual(expected, candidate)) {
            return { ok: true };
        }
    }

    return { ok: false, reason: 'signature_mismatch' };
};
