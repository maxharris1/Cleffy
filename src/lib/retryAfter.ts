/**
 * Retry-After hints from throttled Supabase responses.
 *
 * supabase-js hands callers `{ data, error, status }` and drops the response
 * headers, so a 429/503 arrives without the server's own idea of when to come
 * back. The client's fetch is wrapped (lib/supabase.ts) to note the most
 * recent Retry-After it saw; the sync engine reads it right after a throttled
 * request and waits at least that long before retrying. The hint is global,
 * not per request: a throttle is a statement about this client as a whole,
 * and the engine sends one request at a time.
 */

/** A hint older than this no longer describes the request that just failed. */
const HINT_TTL_MS = 10_000;
/** Never park the outbox for longer than this on the server's say-so. */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;

let lastHint: { ms: number; seenAt: number } | null = null;

/** Parse a Retry-After header: delta-seconds or an HTTP date. Null when absent/invalid. */
export const parseRetryAfter = (value: string | null, now = Date.now()): number | null => {
    if (!value) {
        return null;
    }
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
        return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
    }
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) {
        return null;
    }
    return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS);
};

export const noteRetryAfter = (response: Pick<Response, 'status' | 'headers'>): void => {
    if (response.status !== 429 && response.status !== 503) {
        return;
    }
    const ms = parseRetryAfter(response.headers.get('retry-after'));
    if (ms !== null) {
        lastHint = { ms, seenAt: Date.now() };
    }
};

/** Read and clear the latest fresh hint (ms), if any. */
export const takeRetryAfterHint = (now = Date.now()): number | undefined => {
    const hint = lastHint;
    lastHint = null;
    if (!hint || now - hint.seenAt > HINT_TTL_MS) {
        return undefined;
    }
    return hint.ms;
};

/** fetch that records Retry-After on throttled responses; otherwise transparent. */
export const fetchNotingRetryAfter: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    noteRetryAfter(response);
    return response;
};
