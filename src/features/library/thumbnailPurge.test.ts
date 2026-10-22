import { beforeEach, describe, expect, it, vi } from 'vitest';

type ClaimArgs = { p_document_ids: string[]; p_writing_rev?: number };

const state = vi.hoisted(() => ({
    ledger: [] as Array<{ document_id: string }>,
    ledgerFilter: null as null | [string, string],
    /** What claim_superseded_thumbnails answers, per call. */
    claim: vi.fn(),
    remove: vi.fn(),
    upload: vi.fn(),
    update: vi.fn(),
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
                update: (patch: unknown) => ({ eq: async () => state.update(patch) }),
            };
        },
        rpc: async (fn: string, args: ClaimArgs) => {
            if (fn !== 'claim_superseded_thumbnails') {
                throw new Error(`unexpected rpc ${fn}`);
            }
            return state.claim(args);
        },
        storage: { from: () => ({ remove: state.remove, upload: state.upload }) },
    }),
}));

import { publishThumbnail, purgeSupersededThumbnails } from '@/features/library/thumbnailRemote';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    state.ledger = [];
    state.ledgerFilter = null;
    state.claim.mockReset();
    state.claim.mockResolvedValue({ data: [], error: null });
    state.remove.mockReset();
    state.remove.mockResolvedValue({ data: [], error: null });
    state.upload.mockReset();
    state.upload.mockResolvedValue({ data: {}, error: null });
    state.update.mockReset();
    state.update.mockResolvedValue({ error: null });
});

describe('purgeSupersededThumbnails', () => {
    it('removes what the server claims for a score, and nothing else', async () => {
        state.claim.mockResolvedValueOnce({ data: ['d1/0.jpg'], error: null });
        await purgeSupersededThumbnails({ docId: 'd1' });
        expect(state.claim).toHaveBeenCalledWith({ p_document_ids: ['d1'] });
        expect(state.remove).toHaveBeenCalledWith(['d1/0.jpg']);
    });

    it('across an owner, asks once for every score on the ledger and removes the claimed covers', async () => {
        state.ledger = [{ document_id: 'd1' }, { document_id: 'd1' }, { document_id: 'd2' }];
        state.claim.mockResolvedValueOnce({ data: ['d1/0.jpg', 'd2/4.jpg'], error: null });
        await purgeSupersededThumbnails({ ownerId: 'u1' });
        expect(state.ledgerFilter).toEqual(['owner_id', 'u1']);
        expect(state.claim).toHaveBeenCalledWith({ p_document_ids: ['d1', 'd2'] });
        expect(state.remove).toHaveBeenCalledWith(['d1/0.jpg', 'd2/4.jpg']);
    });

    it('removes nothing the server did not claim (a published cover, or another owner’s)', async () => {
        state.ledger = [{ document_id: 'd1' }];
        await purgeSupersededThumbnails({ ownerId: 'u1' });
        expect(state.claim).toHaveBeenCalledTimes(1);
        expect(state.remove).not.toHaveBeenCalled();
    });

    it('does nothing when nothing is superseded', async () => {
        await purgeSupersededThumbnails({ ownerId: 'u1' });
        expect(state.claim).not.toHaveBeenCalled();
        expect(state.remove).not.toHaveBeenCalled();
    });

    it('never throws', async () => {
        state.claim.mockResolvedValueOnce({ data: ['d1/0.jpg'], error: null });
        state.remove.mockRejectedValue(new Error('offline'));
        await expect(purgeSupersededThumbnails({ docId: 'd1' })).resolves.toBeUndefined();
        state.claim.mockRejectedValueOnce(new Error('offline'));
        await expect(purgeSupersededThumbnails({ docId: 'd1' })).resolves.toBeUndefined();
    });
});

describe('publishThumbnail', () => {
    const blob = new Blob(['jpeg']);
    const folderFull = { data: null, error: { message: 'thumbnail_limit', statusCode: '403' } };

    it('uploads, stamps the row, then purges what the publish superseded', async () => {
        await expect(publishThumbnail('p1', 2, blob)).resolves.toBe(true);
        expect(state.upload).toHaveBeenCalledTimes(1);
        expect(state.update).toHaveBeenCalledWith({ thumb_rev: 2 });
        await flush();
        expect(state.claim).toHaveBeenCalledWith({ p_document_ids: ['p1'] });
    });

    it('is not blocked by an earlier upload whose publish failed: it clears the folder and tries once more', async () => {
        state.upload.mockResolvedValueOnce(folderFull);
        state.claim.mockResolvedValueOnce({ data: ['p2/1.jpg'], error: null });
        await expect(publishThumbnail('p2', 2, blob)).resolves.toBe(true);
        expect(state.claim).toHaveBeenNthCalledWith(1, { p_document_ids: ['p2'], p_writing_rev: 2 });
        expect(state.remove).toHaveBeenCalledWith(['p2/1.jpg']);
        expect(state.upload).toHaveBeenCalledTimes(2);
        expect(state.update).toHaveBeenCalledWith({ thumb_rev: 2 });
    });

    it('gives up (for this session) when the folder is still full', async () => {
        state.upload.mockResolvedValue(folderFull);
        await expect(publishThumbnail('p3', 2, blob)).resolves.toBe(false);
        expect(state.upload).toHaveBeenCalledTimes(2);
        expect(state.update).not.toHaveBeenCalled();
    });

    it('does not retry any other refusal (a member, a policy): one request, as before', async () => {
        state.upload.mockResolvedValue({
            data: null,
            error: { message: 'new row violates row-level security policy', statusCode: '403' },
        });
        await expect(publishThumbnail('p4', 2, blob)).resolves.toBe(false);
        expect(state.upload).toHaveBeenCalledTimes(1);
        expect(state.claim).not.toHaveBeenCalled();
    });

    it('reports a refused row stamp (a claimed cover) as not published', async () => {
        state.update.mockResolvedValueOnce({ error: { message: 'thumbnail_claimed' } });
        await expect(publishThumbnail('p5', 2, blob)).resolves.toBe(false);
    });
});
