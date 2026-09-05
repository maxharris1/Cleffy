import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '@/sync/db';

const signOutAuth = vi.fn(async () => ({ error: null }));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        auth: {
            signOut: () => signOutAuth(),
        },
    }),
}));

import { signOut } from '@/features/auth/session';

describe('signOut', () => {
    beforeEach(async () => {
        signOutAuth.mockClear();
        const db = getDb();
        await Promise.all([
            db.pdfCache.clear(),
            db.thumbnails.clear(),
            db.scoreCache.clear(),
            db.libraryList.clear(),
            db.rosterCache.clear(),
            db.assignmentsCache.clear(),
        ]);
    });

    it('empties pdfCache and thumbnails', async () => {
        const db = getDb();
        await db.pdfCache.put({
            docId: 'doc-1',
            bytes: new ArrayBuffer(4),
            title: 'Score',
            cachedAt: '2026-08-01T00:00:00Z',
            userId: 'user-1',
        });
        await db.thumbnails.put({
            docId: 'doc-1',
            contentRev: 0,
            maxSide: 512,
            blob: new Blob(['x']),
            width: 1,
            height: 1,
            createdAt: '2026-08-01T00:00:00Z',
        });

        await signOut();

        expect(signOutAuth).toHaveBeenCalled();
        expect(await db.pdfCache.count()).toBe(0);
        expect(await db.thumbnails.count()).toBe(0);
    });
});
