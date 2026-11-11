import { describe, expect, it, vi } from 'vitest';

const download = vi.hoisted(() => vi.fn());
const exists = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({ storage: { from: () => ({ download, exists }) } }),
}));

import {
    coverDownloadsSettled,
    fetchPublishedThumbnail,
    probePublishedThumbnail,
} from '@/features/library/thumbnailRemote';

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

describe('probePublishedThumbnail', () => {
    /** What storage-js exists() resolves to when the HEAD is refused with `status`. */
    const refused = (status: number) => ({
        data: false,
        error: Object.assign(new Error('head failed'), { originalError: { status } }),
    });

    it('finds a cover that is there', async () => {
        exists.mockResolvedValueOnce({ data: true, error: null });
        await expect(probePublishedThumbnail('d', 1)).resolves.toBe('found');
    });

    it('calls a cover missing only on a 404', async () => {
        exists.mockResolvedValueOnce(refused(404));
        await expect(probePublishedThumbnail('d', 1)).resolves.toBe('missing');
        exists.mockResolvedValueOnce({ data: false, error: Object.assign(new Error('Not found'), { status: 404 }) });
        await expect(probePublishedThumbnail('d', 1)).resolves.toBe('missing');
    });

    it('does not take a 400 (an auth or JWT refusal on a HEAD) for a missing cover', async () => {
        exists.mockResolvedValueOnce(refused(400));
        await expect(probePublishedThumbnail('d', 1)).resolves.toBe('unavailable');
    });

    it('reports a thrown probe as unavailable', async () => {
        exists.mockRejectedValueOnce(new Error('503'));
        await expect(probePublishedThumbnail('d', 1)).resolves.toBe('unavailable');
    });
});
