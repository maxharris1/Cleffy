import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    fetchLibraryBootstrap,
    prependCachedLibraryDocument,
    readCachedLibraryList,
    writeCachedLibraryList,
    type LibraryListSnapshot,
} from '@/features/library/libraryBootstrap';
import { libraryMutationEpoch, noteLibraryMutation, noteLibraryMutationCommitted } from '@/features/library/libraryCache';
import { getDb } from '@/sync/db';
import type { DocumentRow } from '@/types/database';

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
            thumb_rev: null,
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

    it('keeps a seeded libraryList row across noteLibraryMutationCommitted', async () => {
        await writeCachedLibraryList('user-keep', listSnapshot('Keep me'));
        noteLibraryMutationCommitted();
        expect((await getDb().libraryList.get('user-keep'))?.documents[0]?.title).toBe('Keep me');
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
        // Give a (wrongly) detached write every chance to land before asserting.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await getDb().libraryList.get('user-stale')).toBeUndefined();
    });

    it('persists a payload no mutation raced', async () => {
        rpc.mockResolvedValue({ data: payload('Aria'), error: null });
        await fetchLibraryBootstrap('user-fresh');
        // The write is detached from the resolution so the page can paint first.
        await vi.waitFor(async () => {
            const row = await getDb().libraryList.get('user-fresh');
            expect(row?.documents[0]?.title).toBe('Aria');
        });
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

    it('stamps a joined request with its dispatch-time epoch, not the joiner’s', async () => {
        let release: (value: unknown) => void = () => undefined;
        rpc.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        const epochAtDispatch = libraryMutationEpoch();
        const first = fetchLibraryBootstrap('user-join');
        // A mutation lands, THEN a second caller joins the in-flight request.
        // The payload must carry the dispatch-time epoch so the joiner can
        // tell it predates the mutation — a joiner-side capture could not.
        noteLibraryMutation();
        const second = fetchLibraryBootstrap('user-join');
        expect(rpc).toHaveBeenCalledTimes(1);
        release({ data: payload('Aria'), error: null });
        const [a, b] = await Promise.all([first, second]);
        expect(a.fetchedAtEpoch).toBe(epochAtDispatch);
        expect(b.fetchedAtEpoch).toBe(epochAtDispatch);
        expect(libraryMutationEpoch()).not.toBe(epochAtDispatch);
    });

    const listSnapshot = (title: string): LibraryListSnapshot => ({
        documents: payload(title).documents as DocumentRow[],
        hasMore: false,
        favoriteIds: new Set(),
        tags: [],
        documentTags: new Map(),
    });

    it('does not let a detached bootstrap clobber a post-edit snapshot', async () => {
        const db = getDb();
        let releaseFirst: () => void = () => undefined;
        const firstTxHeld = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let txStarts = 0;
        const orig = db.transaction.bind(db) as (...args: unknown[]) => Promise<unknown>;
        const spy = vi.spyOn(db, 'transaction');
        const delayFirstTx = (...args: unknown[]) => {
            txStarts += 1;
            if (txStarts === 1) {
                return firstTxHeld.then(() => orig(...args));
            }
            return orig(...args);
        };
        spy.mockImplementation(delayFirstTx as typeof db.transaction);

        rpc.mockResolvedValue({ data: payload('STALE-BOOTSTRAP'), error: null });
        await fetchLibraryBootstrap('user-clobber');
        await vi.waitFor(() => expect(txStarts).toBeGreaterThanOrEqual(1));

        noteLibraryMutationCommitted();
        await writeCachedLibraryList('user-clobber', listSnapshot('POST-EDIT'));
        releaseFirst();
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect((await db.libraryList.get('user-clobber'))?.documents[0]?.title).toBe('POST-EDIT');
        spy.mockRestore();
    });

    it('refuses a persist whose epoch is older than the stored snapshot', async () => {
        noteLibraryMutationCommitted();
        const high = libraryMutationEpoch();
        await writeCachedLibraryList('user-gen', listSnapshot('PREPEND'), high);
        await writeCachedLibraryList('user-gen', listSnapshot('STALE-PERSIST'), high - 1);
        expect((await getDb().libraryList.get('user-gen'))?.documents[0]?.title).toBe('PREPEND');
    });

    it('skips a write when the epoch moved after the caller captured it', async () => {
        const captured = libraryMutationEpoch();
        noteLibraryMutation();
        await writeCachedLibraryList('user-moved', listSnapshot('NOPE'), captured);
        expect(await getDb().libraryList.get('user-moved')).toBeUndefined();
    });

    it('prepends onto the snapshot written after snapshotBefore was captured', async () => {
        await writeCachedLibraryList('user-prepend', listSnapshot('BEFORE'));
        const before = await readCachedLibraryList('user-prepend');
        await writeCachedLibraryList('user-prepend', listSnapshot('AFTER-PERSIST'));
        const uploaded: DocumentRow = {
            ...(payload('New score').documents[0] as DocumentRow),
            id: 'd-new',
            title: 'New score',
        };
        await prependCachedLibraryDocument('user-prepend', before, uploaded);
        const row = await readCachedLibraryList('user-prepend');
        expect(row?.documents[0]?.id).toBe('d-new');
        expect(row?.documents[1]?.title).toBe('AFTER-PERSIST');
    });

    it('does not memoize a failed request', async () => {
        rpc.mockRejectedValueOnce(new Error('offline'));
        rpc.mockResolvedValueOnce({ data: payload('Aria'), error: null });
        await expect(fetchLibraryBootstrap('user-retry')).rejects.toThrow('offline');
        const retry = await fetchLibraryBootstrap('user-retry');
        expect(retry.documents[0]?.title).toBe('Aria');
    });
});
