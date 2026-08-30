import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchLibraryBootstrap } from '@/features/library/libraryBootstrap';
import { noteLibraryMutation } from '@/features/library/libraryCache';
import { getDb } from '@/sync/db';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({ rpc }),
}));
// libraryBootstrap only needs the page-size constant; the rest of the service
// drags in upload/thumbnail machinery these tests never touch.
vi.mock('@/features/library/documentsService', () => ({
    LIBRARY_PAGE_SIZE: 100,
}));

const payload = (title: string) => ({
    documents: [
        {
            id: 'd1',
            owner_id: 'u1',
            title,
            storage_path: 'd1/original.pdf',
            page_count: 1,
            content_rev: 0,
            created_at: '2026-08-01T00:00:00Z',
            updated_at: '2026-08-01T00:00:00Z',
            archived_at: null,
        },
    ],
    has_more: false,
    favorite_ids: [],
    tags: [],
    document_tags: [],
    entitlements: {
        user_id: '',
        tier: 'free',
        status: null,
        source: 'none',
        current_period_end: null,
        limits: { cloud_scores: 3, omr_runs: 3, vision_reads: 5, smart_imports: 2, pdf_exports: 1, students: 0 },
    },
});

describe('fetchLibraryBootstrap', () => {
    beforeEach(async () => {
        rpc.mockReset();
        await getDb().libraryList.clear();
    });

    it('coalesces concurrent calls for the same user onto one request', async () => {
        rpc.mockResolvedValue({ data: payload('Aria'), error: null });
        const [a, b] = await Promise.all([fetchLibraryBootstrap('user-same'), fetchLibraryBootstrap('user-same')]);
        expect(rpc).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
    });

    it('never hands one user the request another user started', async () => {
        let release: (value: unknown) => void = () => undefined;
        rpc.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        rpc.mockResolvedValueOnce({ data: payload('Bourrée'), error: null });
        const first = fetchLibraryBootstrap('user-a');
        const second = fetchLibraryBootstrap('user-b');
        expect(rpc).toHaveBeenCalledTimes(2);
        release({ data: payload('Aria'), error: null });
        const [a, b] = await Promise.all([first, second]);
        expect(a.documents[0]?.title).toBe('Aria');
        expect(b.documents[0]?.title).toBe('Bourrée');
    });

    it('does not persist a payload that a mutation outran', async () => {
        let release: (value: unknown) => void = () => undefined;
        rpc.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const inFlight = fetchLibraryBootstrap('user-stale');
        // A rename/delete/favorite (or sign-out) lands while the request is out:
        // the payload now describes a library that no longer exists.
        noteLibraryMutation();
        release({ data: payload('Aria'), error: null });
        await inFlight;
        expect(await getDb().libraryList.get('user-stale')).toBeUndefined();
    });

    it('persists a payload no mutation raced', async () => {
        rpc.mockResolvedValue({ data: payload('Aria'), error: null });
        await fetchLibraryBootstrap('user-fresh');
        const row = await getDb().libraryList.get('user-fresh');
        expect(row?.documents[0]?.title).toBe('Aria');
    });

    it('coalesces only requests in flight — a sequential call fetches anew', async () => {
        rpc.mockResolvedValueOnce({ data: payload('Aria'), error: null });
        rpc.mockResolvedValueOnce({ data: payload('Bourrée'), error: null });
        const first = await fetchLibraryBootstrap('user-seq');
        const second = await fetchLibraryBootstrap('user-seq');
        expect(rpc).toHaveBeenCalledTimes(2);
        expect(first.documents[0]?.title).toBe('Aria');
        expect(second.documents[0]?.title).toBe('Bourrée');
    });

    it('does not memoize a failed request', async () => {
        rpc.mockRejectedValueOnce(new Error('offline'));
        rpc.mockResolvedValueOnce({ data: payload('Aria'), error: null });
        await expect(fetchLibraryBootstrap('user-retry')).rejects.toThrow('offline');
        const retry = await fetchLibraryBootstrap('user-retry');
        expect(retry.documents[0]?.title).toBe('Aria');
    });
});
