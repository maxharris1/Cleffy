import { describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_GLOBAL_DOWNLOAD_MAX,
    DEFAULT_GLOBAL_DOWNLOAD_SPACING_MS,
    GLOBAL_DOWNLOAD_MAX_ENV,
    GLOBAL_DOWNLOAD_SPACING_ENV,
    IMSLP_GLOBAL_DOWNLOAD_KEY,
    gateGlobalImslpDownload,
    readGlobalDownloadGateConfig,
} from '../_shared/imslpDownloadGate.ts';

const envOf = (values: Record<string, string | undefined>) => (name: string) => values[name];

describe('readGlobalDownloadGateConfig', () => {
    it('defaults to one live fetch per 15 s deployment-wide', () => {
        expect(readGlobalDownloadGateConfig(envOf({}))).toEqual({
            max: DEFAULT_GLOBAL_DOWNLOAD_MAX,
            spacingMs: DEFAULT_GLOBAL_DOWNLOAD_SPACING_MS,
        });
        expect(DEFAULT_GLOBAL_DOWNLOAD_MAX).toBe(1);
        expect(DEFAULT_GLOBAL_DOWNLOAD_SPACING_MS).toBe(15_000);
    });

    it('reads both knobs from the environment and ignores garbage', () => {
        expect(
            readGlobalDownloadGateConfig(
                envOf({ [GLOBAL_DOWNLOAD_MAX_ENV]: '3', [GLOBAL_DOWNLOAD_SPACING_ENV]: '60000' }),
            ),
        ).toEqual({ max: 3, spacingMs: 60_000 });
        expect(
            readGlobalDownloadGateConfig(
                envOf({ [GLOBAL_DOWNLOAD_MAX_ENV]: '0', [GLOBAL_DOWNLOAD_SPACING_ENV]: 'soon' }),
            ),
        ).toEqual({ max: DEFAULT_GLOBAL_DOWNLOAD_MAX, spacingMs: DEFAULT_GLOBAL_DOWNLOAD_SPACING_MS });
    });
});

describe('gateGlobalImslpDownload', () => {
    it('uses one shared bucket for every caller and passes when a slot is free', async () => {
        const check = vi.fn(async () => ({ ok: true as const }));
        expect(await gateGlobalImslpDownload(check, { max: 2, spacingMs: 15_000 })).toEqual({ ok: true });
        expect(check).toHaveBeenCalledWith(IMSLP_GLOBAL_DOWNLOAD_KEY, 2, 15_000);
    });

    it('answers 429 download_queued with the bucket retryAfterSec when the window is full', async () => {
        const check = vi.fn(async () => ({ ok: false as const, retryAfterSec: 9 }));
        expect(await gateGlobalImslpDownload(check, { max: 1, spacingMs: 15_000 })).toEqual({
            ok: false,
            status: 429,
            body: {
                ok: false,
                code: 'download_queued',
                error: expect.any(String),
                retryAfterSec: 9,
            },
        });
    });

    it('never tells the client to retry in zero seconds', async () => {
        const check = vi.fn(async () => ({ ok: false as const, retryAfterSec: 0 }));
        const gate = await gateGlobalImslpDownload(check, { max: 1, spacingMs: 15_000 });
        expect(gate.ok).toBe(false);
        if (!gate.ok) {
            expect(gate.body.retryAfterSec).toBe(1);
        }
    });
});
