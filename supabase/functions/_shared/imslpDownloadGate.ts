/**
 * Deployment-wide pacing for live IMSLP PDF fetches.
 *
 * Every Edge invocation leaves from the same small set of egress IPs, so to
 * IMSLP all of Cleffy is one client — and a client that bursts gets banned for
 * everyone. The per-caller limit in imslp-download stops one user hammering;
 * this gate caps the whole deployment at `max` fetches per `spacingMs` window,
 * on one shared edge_rate_buckets key (cross-isolate, via check_edge_rate_limit).
 *
 * A full window does not hold the invocation open waiting for a slot: the
 * function answers 429 `download_queued` with `retryAfterSec` at once, and the
 * client waits that long and retries, showing "queued" rather than an error.
 *
 * When IMSLP itself answers 429, the caller blocks the same key for the
 * Retry-After IMSLP gave (edge_rate_block), so every other import waits out
 * the throttle too instead of each one discovering it with another request.
 *
 * NO imports — loaded by Deno (with the `.ts` extension) and by vitest
 * (without it); the env reader and the RPC-backed limiter are injected.
 */

export const IMSLP_GLOBAL_DOWNLOAD_KEY = 'imslp:download:global';

/**
 * Two live fetches a second across the deployment. One import is two IMSLP
 * requests (wait page, then CDN), so this keeps Cleffy to a handful of
 * requests a second at peak — polite for a donation-funded library — while a
 * paying user importing alongside others waits a second or two, not minutes.
 */
export const DEFAULT_GLOBAL_DOWNLOAD_MAX = 2;
export const DEFAULT_GLOBAL_DOWNLOAD_SPACING_MS = 1_000;

export const GLOBAL_DOWNLOAD_MAX_ENV = 'IMSLP_DOWNLOAD_GLOBAL_MAX';
export const GLOBAL_DOWNLOAD_SPACING_ENV = 'IMSLP_DOWNLOAD_GLOBAL_SPACING_MS';

/** Back-off applied when IMSLP answers 429 without a Retry-After. */
export const DEFAULT_IMSLP_BACKOFF_SEC = 60;
/** Ceiling on any back-off (matches edge_rate_block's own clamp). */
export const MAX_IMSLP_BACKOFF_SEC = 900;

export interface GlobalDownloadGateConfig {
    max: number;
    spacingMs: number;
}

const positiveInt = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === '' || !/^\d+$/.test(raw.trim())) {
        return fallback;
    }
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const readGlobalDownloadGateConfig = (env: (name: string) => string | undefined): GlobalDownloadGateConfig => ({
    max: positiveInt(env(GLOBAL_DOWNLOAD_MAX_ENV), DEFAULT_GLOBAL_DOWNLOAD_MAX),
    spacingMs: positiveInt(env(GLOBAL_DOWNLOAD_SPACING_ENV), DEFAULT_GLOBAL_DOWNLOAD_SPACING_MS),
});

export type RateCheck = (
    key: string,
    limit: number,
    windowMs: number,
) => Promise<{ ok: true } | { ok: false; retryAfterSec: number }>;

export interface DownloadQueuedBody {
    ok: false;
    code: 'download_queued';
    error: string;
    retryAfterSec: number;
}

export type GlobalDownloadGate = { ok: true } | { ok: false; status: 429; body: DownloadQueuedBody };

/** The 429 the client waits out and retries. Never "retry in zero seconds". */
export const downloadQueued = (retryAfterSec: number): { status: 429; body: DownloadQueuedBody } => ({
    status: 429,
    body: {
        ok: false,
        code: 'download_queued',
        error: 'IMSLP downloads are paced — queued for the next slot',
        retryAfterSec: Math.max(1, Math.ceil(Number.isFinite(retryAfterSec) ? retryAfterSec : 1)),
    },
});

export const gateGlobalImslpDownload = async (
    check: RateCheck,
    config: GlobalDownloadGateConfig,
): Promise<GlobalDownloadGate> => {
    const result = await check(IMSLP_GLOBAL_DOWNLOAD_KEY, config.max, config.spacingMs);
    if (result.ok) {
        return { ok: true };
    }
    return { ok: false, ...downloadQueued(result.retryAfterSec) };
};

/** Seconds to block every import for after IMSLP answered 429 with this Retry-After. */
export const imslpBackoffSec = (retryAfterSec: number | null | undefined): number => {
    if (typeof retryAfterSec !== 'number' || !Number.isFinite(retryAfterSec) || retryAfterSec < 1) {
        return DEFAULT_IMSLP_BACKOFF_SEC;
    }
    return Math.min(MAX_IMSLP_BACKOFF_SEC, Math.ceil(retryAfterSec));
};
