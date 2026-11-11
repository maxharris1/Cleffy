/**
 * Request bodies read with a ceiling, so a caller cannot make a function buffer
 * an unbounded body before it has decided anything.
 *
 * The ceiling is enforced on the bytes as they stream in, never on
 * Content-Length: a chunked request has none, and a client can send one that
 * lies. Reading stops (and the stream is cancelled) at the first byte past the
 * cap, so an oversized body costs at most `maxBytes` of memory.
 *
 * NO imports, so every function can load this file as it is (Deno with the
 * `.ts` extension, vitest without). The shared handlers that take no runtime
 * imports (guestEmail.ts, checkoutFlow.ts, ...) receive `readCappedJson`
 * through their deps, and hold their own cap.
 */

/** Ordinary control requests: a few ids, a short text, a captcha token. */
export const CONTROL_BODY_MAX_BYTES = 16 * 1024;

/**
 * Signed webhooks (Stripe, Resend/Svix), read RAW: the signature is verified
 * over exactly the bytes read here, before anything is parsed.
 */
export const WEBHOOK_BODY_MAX_BYTES = 256 * 1024;

/** The answer to a body over its cap. */
export const PAYLOAD_TOO_LARGE = { error: 'Request body too large', code: 'payload_too_large' } as const;

export type CappedRead<T> = { ok: true; value: T } | { ok: false; status: 413 | 400 };

/** The body's bytes, or 413 at the first byte past `maxBytes`. A request with no body reads as empty. */
export const readCappedBytes = async (req: Request, maxBytes: number): Promise<CappedRead<Uint8Array>> => {
    const reader = req.body?.getReader();
    if (!reader) {
        return { ok: true, value: new Uint8Array(0) };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (!value) {
                continue;
            }
            size += value.byteLength;
            if (size > maxBytes) {
                await reader.cancel().catch(() => undefined);
                return { ok: false, status: 413 };
            }
            chunks.push(value);
        }
    } catch {
        // The client went away mid-body: nothing usable arrived.
        return { ok: false, status: 400 };
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { ok: true, value: bytes };
};

/**
 * The body as text, decoded exactly as `Request.text()` decodes it (UTF-8,
 * replacement characters for invalid sequences), so a webhook signature
 * checked over it is checked over the same string as before the cap.
 */
export const readCappedText = async (req: Request, maxBytes: number): Promise<CappedRead<string>> => {
    const read = await readCappedBytes(req, maxBytes);
    return read.ok ? { ok: true, value: new TextDecoder().decode(read.value) } : read;
};

/** A JSON body, refusing anything larger than `maxBytes` even if Content-Length is missing or lies. */
export const readCappedJson = async <T = unknown>(req: Request, maxBytes: number): Promise<CappedRead<T>> => {
    const read = await readCappedText(req, maxBytes);
    if (!read.ok) {
        return read;
    }
    try {
        return { ok: true, value: JSON.parse(read.value) as T };
    } catch {
        return { ok: false, status: 400 };
    }
};

/** A JSON body that must be an object (not null, an array or a scalar); anything else is 400. */
export const readCappedJsonObject = async (
    req: Request,
    maxBytes: number,
): Promise<CappedRead<Record<string, unknown>>> => {
    const read = await readCappedJson(req, maxBytes);
    if (!read.ok) {
        return read;
    }
    return isJsonObject(read.value) ? { ok: true, value: read.value } : { ok: false, status: 400 };
};

export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
