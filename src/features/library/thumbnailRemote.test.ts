import { describe, expect, it, vi } from 'vitest';

const download = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({ storage: { from: () => ({ download }) } }),
}));

import { coverDownloadsSettled, fetchPublishedThumbnail } from '@/features/library/thumbnailRemote';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('coverDownloadsSettled', () => {
    it('resolves at once when no cover is downloading', async () => {
        await expect(coverDownloadsSettled()).resolves.toBeUndefined();
    });

    it('waits for every download in flight and queued to finish', async () => {
        const pending: Array<(value: { data: Blob; error: null }) => void> = [];
        download.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
        // Six covers: four download, two wait their turn.
        const fetches = Array.from({ length: 6 }, (_, i) => fetchPublishedThumbnail(`d${i}`, 0));
        let settled = false;
        void coverDownloadsSettled().then(() => {
            settled = true;
        });

        for (let round = 0; round < 6; round++) {
            await flush();
            expect(settled).toBe(false);
            pending.shift()?.({ data: new Blob(['jpeg']), error: null });
        }
        await Promise.all(fetches);
        await flush();
        expect(settled).toBe(true);
    });
});
