import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LinkViewSync } from '@/features/share/LinkViewSync';
import type { TypedSupabaseClient } from '@/lib/supabase';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import type { LinkViewMark } from '@/sync/wire';

const stroke = (id: string, seq: number, page = 0): LinkViewMark => ({
    id,
    page,
    kind: 'stroke',
    color: '#000000',
    payload: { pts: [0, 0, 1, 1], w: 2 },
    seq,
    deleted: false,
});
const tomb = (id: string, seq: number): LinkViewMark => ({ id, seq, deleted: true });

describe('LinkViewSync', () => {
    let db: ScribblerDb;
    let store: AnnotationStore;
    let rpc: ReturnType<typeof vi.fn>;
    let sync: LinkViewSync;

    beforeEach(async () => {
        db = new ScribblerDb(`link-view-test-${crypto.randomUUID()}`);
        store = new AnnotationStore(db, 'd1');
        await store.load();
        rpc = vi.fn();
        sync = new LinkViewSync({ client: { rpc } as unknown as TypedSupabaseClient, store });
    });

    afterEach(async () => {
        await db.delete();
    });

    const page = (marks: LinkViewMark[], maxSeq: number, more: boolean) => ({
        data: { doc: { title: 't', page_count: 1, content_rev: 0 }, marks, max_seq: maxSeq, more },
        error: null,
    });

    it('pulls pages from the watermark until there are no more', async () => {
        rpc.mockResolvedValueOnce(page([stroke('a', 1), stroke('b', 2)], 2, true)).mockResolvedValueOnce(
            page([stroke('c', 3, 1)], 3, false),
        );
        await sync.pull();
        expect(rpc.mock.calls.map((c) => c[1])).toEqual([
            { p_since: 0, p_limit: 500 },
            { p_since: 2, p_limit: 500 },
        ]);
        expect([...store.getPage(0).keys()].sort()).toEqual(['a', 'b']);
        expect([...store.getPage(1).keys()]).toEqual(['c']);

        rpc.mockResolvedValueOnce(page([], 3, false));
        await sync.pull();
        expect(rpc.mock.calls[2]?.[1]).toEqual({ p_since: 3, p_limit: 500 });
    });

    it('keeps newer marks over older copies and erases on a tombstone', async () => {
        await sync.applyMark(stroke('a', 5));
        await sync.applyMark({ ...(stroke('a', 4) as Extract<LinkViewMark, { deleted: false }>), color: '#ff0000' });
        expect(store.get('a')?.color).toBe('#000000');
        await sync.applyMark(tomb('a', 6));
        expect(store.getPage(0).has('a')).toBe(false);
    });

    it('remembers a tombstone for a mark it has not seen, so an older copy stays erased', async () => {
        await sync.applyMark(tomb('x', 9));
        await sync.applyMark(stroke('x', 8));
        expect(store.getPage(0).has('x')).toBe(false);
        await sync.applyMark(stroke('x', 10));
        expect(store.getPage(0).has('x')).toBe(true);
    });

    it('does not move the watermark on live marks, so a missed one is still pulled', async () => {
        await sync.applyMark(stroke('late', 7));
        rpc.mockResolvedValueOnce(page([stroke('missed', 6)], 7, false));
        await sync.pull();
        expect(rpc.mock.calls[0]?.[1]).toEqual({ p_since: 0, p_limit: 500 });
        expect(store.getPage(0).has('missed')).toBe(true);
    });

    it('leaves the store as it is when a pull is refused', async () => {
        await sync.applyMark(stroke('a', 1));
        rpc.mockResolvedValueOnce({ data: null, error: { code: 'PT403' } });
        await sync.pull();
        expect(store.getPage(0).has('a')).toBe(true);
    });
});
