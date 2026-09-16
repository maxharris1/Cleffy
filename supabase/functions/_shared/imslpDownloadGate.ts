/**
 * Global (all-users) pacing for live IMSLP PDF fetches. IMSLP tolerates one
 * polite client, not a fleet: this keeps the whole deployment to at most
 * `max` fetches per `spacingMs` window, on one shared edge_rate_buckets key.
 * When the window is full the function answers 429 `download_queued` with
 * `retryAfterSec` and returns at once — the client waits and retries; the
 * Edge invocation never blocks holding a slot.
 *
 * Pure so it can be unit-tested under vitest like noopRegenerate.ts; the
 * Deno-specific pieces (env, RPC-backed limiter) are injected.
 */

export const IMSLP_GLOBAL_DOWNLOAD_KEY = 'imslp:download:global';

/** One live fetch per 15 s deployment-wide (`docs/omr-midi-preload-plan.md`, IMSLP 15 s floor). */
export const DEFAULT_GLOBAL_DOWNLOAD_MAX = 1;
export const DEFAULT_GLOBAL_DOWNLOAD_SPACING_MS = 15_000;

export const GLOBAL_DOWNLOAD_MAX_ENV = 'IMSLP_DOWNLOAD_GLOBAL_MAX';
export const GLOBAL_DOWNLOAD_SPACING_ENV = 'IMSLP_DOWNLOAD_GLOBAL_SPACING_MS';

export interface GlobalDownloadGateConfig {
    max: number;
    spacingMs: number;
}

const positiveInt = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === '') {
        return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
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

export type GlobalDownloadGate =
    | { ok: true }
    | {
          ok: false;
          status: 429;
          body: { ok: false; code: 'download_queued'; error: string; retryAfterSec: number };
      };

export const gateGlobalImslpDownload = async (
    check: RateCheck,
    config: GlobalDownloadGateConfig,
): Promise<GlobalDownloadGate> => {
    const result = await check(IMSLP_GLOBAL_DOWNLOAD_KEY, config.max, config.spacingMs);
    if (result.ok) {
        return { ok: true };
    }
    return {
        ok: false,
        status: 429,
        body: {
            ok: false,
            code: 'download_queued',
            error: 'IMSLP downloads are paced — queued for the next slot',
            retryAfterSec: Math.max(1, result.retryAfterSec),
        },
    };
};
