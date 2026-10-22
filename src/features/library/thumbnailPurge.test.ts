import { beforeEach, describe, expect, it, vi } from 'vitest';

type Rows = Array<{ object_name: string; document_id: string }>;

const state = vi.hoisted(() => ({
    ledger: [] as Rows,
    docs: [] as Array<{ id: string; thumb_rev: number | null }>,
    ledgerFilter: null as null | [string, string],
    remove: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        from: (table: string) => {
            if (table === 'thumbnail_storage_cleanup') {
                const query = {
                    select: () => query,
                    eq: (column: string, value: string) => {
                        state.ledgerFilter = [column, value];
                        return query;
                    },
                    order: () => query,
                    limit: async () => ({ data: state.ledger, error: null }),
                };
                return query;
            }
            return {
                select: () => ({
                    in: async (_column: string, ids: string[]) => ({
                        data: state.docs.filter((doc) => ids.includes(doc.id)),
                        error: null,
                    }),
                }),
            };
        },
        storage: { from: () => ({ remove: state.remove }) },
    }),
}));

import { purgeSupersededThumbnails } from '@/features/library/thumbnailRemote';

describe('purgeSupersededThumbnails', () => {
    beforeEach(() => {
        state.ledger = [];
        state.docs = [];
        state.ledgerFilter = null;
        state.remove.mockReset();
        state.remove.mockResolvedValue({ data: [], error: null });
    });

    it('removes the covers the ledger lists for a score, but never the revision just published', async () => {
        state.ledger = [
            { object_name: 'd1/0.jpg', document_id: 'd1' },
            { object_name: 'd1/2.jpg', document_id: 'd1' },
        ];
        await purgeSupersededThumbnails({ docId: 'd1', keepRev: 2 });
        expect(state.ledgerFilter).toEqual(['document_id', 'd1']);
        expect(state.remove).toHaveBeenCalledWith(['d1/0.jpg']);
    });

    it("across an owner, keeps each score's published revision and removes the rest", async () => {
        state.ledger = [
            { object_name: 'd1/0.jpg', document_id: 'd1' },
            { object_name: 'd1/1.jpg', document_id: 'd1' },
            { object_name: 'd2/4.jpg', document_id: 'd2' },
            { object_name: 'gone/3.jpg', document_id: 'gone' },
        ];
        state.docs = [
            { id: 'd1', thumb_rev: 1 },
            { id: 'd2', thumb_rev: null },
        ];
        await purgeSupersededThumbnails({ ownerId: 'u1' });
        expect(state.ledgerFilter).toEqual(['owner_id', 'u1']);
        expect(state.remove).toHaveBeenCalledWith(['d1/0.jpg', 'd2/4.jpg', 'gone/3.jpg']);
    });

    it('does nothing when nothing is superseded', async () => {
        await purgeSupersededThumbnails({ ownerId: 'u1' });
        expect(state.remove).not.toHaveBeenCalled();
    });

    it('never throws', async () => {
        state.ledger = [{ object_name: 'd1/0.jpg', document_id: 'd1' }];
        state.remove.mockRejectedValue(new Error('offline'));
        await expect(purgeSupersededThumbnails({ docId: 'd1', keepRev: 1 })).resolves.toBeUndefined();
    });
});
