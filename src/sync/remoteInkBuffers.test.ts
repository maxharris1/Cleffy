import { describe, expect, it } from 'vitest';

import { RemoteInkBuffers } from '@/sync/remoteInkBuffers';
import { parseDbChange, parseInkProgress } from '@/sync/wire';

const msg = (over: Record<string, unknown> = {}) => ({
    strokeId: 's1',
    userId: 'u1',
    page: 2,
    kind: 'stroke' as const,
    color: '#f00',
    w: 0.005,
    pts: [0.1, 0.1, 0.5],
    ...over,
});

describe('RemoteInkBuffers', () => {
    it('accumulates batches per (user, stroke)', () => {
        const buffers = new RemoteInkBuffers();
        buffers.apply(msg());
        buffers.apply(msg({ pts: [0.2, 0.2, 0.6] }));
        const strokes = buffers.forPage(2);
        expect(strokes).toHaveLength(1);
        expect(strokes[0]?.pts).toEqual([0.1, 0.1, 0.5, 0.2, 0.2, 0.6]);
    });

    it('keeps done strokes until the commit removes them', () => {
        const buffers = new RemoteInkBuffers();
        buffers.apply(msg());
        buffers.apply(msg({ pts: [], done: true }));
        expect(buffers.forPage(2)).toHaveLength(1);

        const page = buffers.removeByStrokeId('s1');
        expect(page).toBe(2);
        expect(buffers.forPage(2)).toHaveLength(0);
    });

    it('drops cancelled strokes immediately', () => {
        const buffers = new RemoteInkBuffers();
        buffers.apply(msg());
        const page = buffers.apply(msg({ pts: [], cancel: true }));
        expect(page).toBe(2);
        expect(buffers.size).toBe(0);
    });

    it('expires stale buffers after the TTL', () => {
        let now = 1_000;
        const buffers = new RemoteInkBuffers(() => now);
        buffers.apply(msg());
        expect(buffers.expire()).toEqual([]);
        now += 11_000;
        expect(buffers.expire()).toEqual([2]);
        expect(buffers.size).toBe(0);
    });

    it('clear() reports affected pages once each', () => {
        const buffers = new RemoteInkBuffers();
        buffers.apply(msg());
        buffers.apply(msg({ strokeId: 's2', userId: 'u2' }));
        buffers.apply(msg({ strokeId: 's3', page: 5 }));
        expect(buffers.clear().sort()).toEqual([2, 5]);
    });
});

describe('wire parsing', () => {
    it('accepts a valid ink message and rejects garbage', () => {
        expect(parseInkProgress(msg())).not.toBeNull();
        expect(parseInkProgress({ nope: true })).toBeNull();
        expect(parseInkProgress(msg({ page: -1 }))).toBeNull();
    });

    it('parses a broadcast_changes envelope into a row', () => {
        const row = parseDbChange({
            operation: 'INSERT',
            schema: 'public',
            table: 'annotations',
            record: {
                id: 'a1',
                document_id: 'd1',
                page: 0,
                kind: 'stroke',
                color: '#000',
                payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
                created_by: 'u1',
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
                deleted_at: null,
                seq: 3,
            },
            old_record: null,
        });
        expect(row?.id).toBe('a1');
        expect(row?.seq).toBe(3);
        expect(parseDbChange({ operation: 'INSERT' })).toBeNull();
    });
});
