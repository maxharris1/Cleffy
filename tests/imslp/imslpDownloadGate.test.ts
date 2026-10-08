import { describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_GLOBAL_DOWNLOAD_MAX,
    DEFAULT_GLOBAL_DOWNLOAD_SPACING_MS,
    DEFAULT_IMSLP_BACKOFF_SEC,
    GLOBAL_DOWNLOAD_MAX_ENV,
    GLOBAL_DOWNLOAD_SPACING_ENV,
    IMSLP_GLOBAL_DOWNLOAD_KEY,
    MAX_IMSLP_BACKOFF_SEC,
    downloadQueued,
    gateGlobalImslpDownload,
    imslpBackoffSec,
    readGlobalDownloadGateConfig,
} from '../../supabase/functions/_shared/imslpDownloadGate';

const envOf = (values: Record<string, string | undefined>) => (name: string) => values[name];

describe('readGlobalDownloadGateConfig', () => {
    it('defaults to two live fetches a second deployment-wide', () => {
        expect(readGlobalDownloadGateConfig(envOf({}))).toEqual({
            max: DEFAULT_GLOBAL_DOWNLOAD_MAX,
            spacingMs: DEFAULT_GLOBAL_DOWNLOAD_SPACING_MS,
        });
        expect(DEFAULT_GLOBAL_DOWNLOAD_MAX).toBe(2);
        expect(DEFAULT_GLOBAL_DOWNLOAD_SPACING_MS).toBe(1_000);
    });

    it('reads both knobs from the environment and ignores garbage', () => {
        expect(
            readGlobalDownloadGateConfig(
                envOf({ [GLOBAL_DOWNLOAD_MAX_ENV]: '3', [GLOBAL_DOWNLOAD_SPACING_ENV]: '15000' }),
            ),
        ).toEqual({ max: 3, spacingMs: 15_000 });
        for (const bad of ['0', '-1', 'soon', '2.5', '']) {
            expect(
                readGlobalDownloadGateConfig(
                    envOf({ [GLOBAL_DOWNLOAD_MAX_ENV]: bad, [GLOBAL_DOWNLOAD_SPACING_ENV]: bad }),
                ),
            ).toEqual({ max: DEFAULT_GLOBAL_DOWNLOAD_MAX, spacingMs: DEFAULT_GLOBAL_DOWNLOAD_SPACING_MS });
        }
    });
});

describe('gateGlobalImslpDownload', () => {
    it('uses one shared bucket for every caller and passes when a slot is free', async () => {
        const check = vi.fn(async () => ({ ok: true as const }));
        expect(await gateGlobalImslpDownload(check, { max: 2, spacingMs: 1_000 })).toEqual({ ok: true });
        expect(check).toHaveBeenCalledWith(IMSLP_GLOBAL_DOWNLOAD_KEY, 2, 1_000);
    });

    it('answers 429 download_queued with the bucket retryAfterSec when the window is full', async () => {
        const check = vi.fn(async () => ({ ok: false as const, retryAfterSec: 9 }));
        expect(await gateGlobalImslpDownload(check, { max: 1, spacingMs: 1_000 })).toEqual({
            ok: false,
            status: 429,
            body: { ok: false, code: 'download_queued', error: expect.any(String), retryAfterSec: 9 },
        });
    });

    it('never tells the client to retry in zero seconds', async () => {
        expect(downloadQueued(0).body.retryAfterSec).toBe(1);
        expect(downloadQueued(Number.NaN).body.retryAfterSec).toBe(1);
        expect(downloadQueued(2.2).body.retryAfterSec).toBe(3);
    });
});

describe('imslpBackoffSec', () => {
    it('honours IMSLP’s Retry-After, with a default and a ceiling', () => {
        expect(imslpBackoffSec(120)).toBe(120);
        expect(imslpBackoffSec(null)).toBe(DEFAULT_IMSLP_BACKOFF_SEC);
        expect(imslpBackoffSec(0)).toBe(DEFAULT_IMSLP_BACKOFF_SEC);
        expect(imslpBackoffSec(100_000)).toBe(MAX_IMSLP_BACKOFF_SEC);
    });
});
