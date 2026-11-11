import { beforeEach, describe, expect, it, vi } from 'vitest';

const insertResult = vi.fn();
const selectCalls: string[] = [];

vi.mock('@/lib/supabase', () => ({
    getSupabase: () => ({
        from: () => {
            const chain = {
                insert: () => chain,
                select: () => chain,
                single: () => insertResult(),
                eq: (column: string) => (selectCalls.push(`eq:${column}`), chain),
                is: (column: string, value: unknown) => (selectCalls.push(`is:${column}:${String(value)}`), chain),
                order: () => chain,
                limit: () => chain,
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
            };
            return chain;
        },
    }),
}));

const { createStudio, fetchOwnedStudio } = await import('@/features/billing/studiosService');

describe('studiosService and one studio per owner (20261022100300)', () => {
    beforeEach(() => {
        insertResult.mockReset();
        selectCalls.length = 0;
    });

    it('says plainly that the owner already has an academy when the server answers studio_exists', async () => {
        insertResult.mockResolvedValue({ data: null, error: { message: 'studio_exists' } });
        await expect(createStudio('owner-1', 'My academy')).rejects.toThrow(
            'You already have an academy. Reload the page to see it.',
        );
    });

    it('says the same when the unique index answers for a create that raced the trigger', async () => {
        insertResult.mockResolvedValue({
            data: null,
            error: { message: 'duplicate key value violates unique constraint "studios_one_live_per_owner"' },
        });
        await expect(createStudio('owner-1', 'My academy')).rejects.toThrow('You already have an academy.');
    });

    it('passes any other failure through as before', async () => {
        insertResult.mockResolvedValue({ data: null, error: { message: 'boom' } });
        await expect(createStudio('owner-1', 'My academy')).rejects.toThrow('Could not create studio: boom');
    });

    it("loads the owner's live studio, never a superseded one", async () => {
        await fetchOwnedStudio('owner-1');
        expect(selectCalls).toEqual(['eq:owner_id', 'is:superseded_at:null']);
    });
});
