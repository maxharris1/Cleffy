import { describe, expect, it } from 'vitest';

import { REMOTE_INK_LIMITS, RemoteInkBuffers } from '@/sync/remoteInkBuffers';
import { INK_LIMITS, parseDbChange, parseInkProgress } from '@/sync/wire';

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

describe('RemoteInkBuffers bounds', () => {
    const points = (count: number) => Array.from({ length: count * 3 }, (_, i) => (i % 3 === 2 ? 0.5 : 0.25));

    it('appends a full-size batch without spreading it (no stack overflow)', () => {
        const buffers = new RemoteInkBuffers();
        const batch = points(INK_LIMITS.maxBatchPoints);
        for (let i = 0; i < 3; i += 1) {
            buffers.apply(msg({ pts: batch }));
        }
        expect(buffers.forPage(2)[0]?.pts).toHaveLength(INK_LIMITS.maxBatchPoints * 3 * 3);
    });

    it('stops a stroke at the per-stroke point cap', () => {
        const buffers = new RemoteInkBuffers();
        const batch = points(INK_LIMITS.maxBatchPoints);
        const batches = Math.ceil(INK_LIMITS.maxStrokePoints / INK_LIMITS.maxBatchPoints) + 3;
        for (let i = 0; i < batches; i += 1) {
            expect(buffers.apply(msg({ pts: batch }))).toBe(2);
        }
        expect(buffers.forPage(2)[0]?.pts).toHaveLength(REMOTE_INK_LIMITS.maxStrokeValues);
        expect(REMOTE_INK_LIMITS.maxStrokeValues % 3).toBe(0);
    });

    it('keeps at most maxStrokesPerPeer strokes per peer, evicting the oldest', () => {
        let now = 0;
        const buffers = new RemoteInkBuffers(() => now);
        for (let i = 0; i < REMOTE_INK_LIMITS.maxStrokesPerPeer + 4; i += 1) {
            now += 1;
            buffers.apply(msg({ strokeId: `s${i}`, page: i }));
        }
        const live = [...Array(REMOTE_INK_LIMITS.maxStrokesPerPeer + 4).keys()].flatMap((p) => buffers.forPage(p));
        expect(live).toHaveLength(REMOTE_INK_LIMITS.maxStrokesPerPeer);
        expect(live.map((s) => s.strokeId)).not.toContain('s0');
        // The evicted strokes' pages are repainted on the next sweep...
        expect(buffers.expire().sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
        // ...and a late batch for an evicted stroke does not bring it back.
        expect(buffers.apply(msg({ strokeId: 's0', page: 0 }))).toBeNull();
        expect(buffers.forPage(0)).toHaveLength(0);
        // Another peer is unaffected by this peer's cap.
        expect(buffers.apply(msg({ userId: 'u2', strokeId: 'other' }))).toBe(2);
    });

    it('keeps at most maxStrokes across every peer', () => {
        let now = 0;
        const buffers = new RemoteInkBuffers(() => now);
        for (let i = 0; i < REMOTE_INK_LIMITS.maxStrokes + 10; i += 1) {
            now += 1;
            buffers.apply(msg({ userId: `peer-${i}`, strokeId: 's' }));
        }
        expect(buffers.size).toBe(REMOTE_INK_LIMITS.maxStrokes);
    });

    it('drops a stroke past its absolute lifetime even while it keeps updating', () => {
        let now = 0;
        const buffers = new RemoteInkBuffers(() => now);
        buffers.apply(msg());
        // Updated every 5 s, so the idle TTL never fires.
        while (now <= REMOTE_INK_LIMITS.maxLifetimeMs - 5_000) {
            now += 5_000;
            buffers.apply(msg({ pts: [0.3, 0.3, 0.5] }));
            expect(buffers.expire()).toEqual([]);
        }
        now += 6_000;
        // The next batch retires it rather than extending it.
        expect(buffers.apply(msg({ pts: [0.3, 0.3, 0.5] }))).toBe(2);
        expect(buffers.size).toBe(0);
        expect(buffers.apply(msg({ pts: [0.3, 0.3, 0.5] }))).toBeNull();
        expect(buffers.size).toBe(0);
    });

    it('expire() retires a stroke that outlived its lifetime', () => {
        let now = 0;
        const buffers = new RemoteInkBuffers(() => now);
        buffers.apply(msg());
        for (let t = 5_000; t <= REMOTE_INK_LIMITS.maxLifetimeMs + 5_000; t += 5_000) {
            now = t;
            if (t <= REMOTE_INK_LIMITS.maxLifetimeMs) {
                buffers.apply(msg({ pts: [] }));
            }
        }
        expect(buffers.expire()).toEqual([2]);
        expect(buffers.apply(msg())).toBeNull();
    });

    it('remembers a bounded number of retired strokes', () => {
        let now = 0;
        const buffers = new RemoteInkBuffers(() => now);
        for (let i = 0; i < REMOTE_INK_LIMITS.maxRetired * 3; i += 1) {
            now += 1;
            buffers.apply(msg({ strokeId: `s${i}` }));
        }
        // Every peer-cap eviction retired one stroke; the memory stays bounded.
        const retired = (buffers as unknown as { retired: Set<string> }).retired;
        expect(retired.size).toBeLessThanOrEqual(REMOTE_INK_LIMITS.maxRetired);
        expect(buffers.size).toBe(REMOTE_INK_LIMITS.maxStrokesPerPeer);
    });
});

describe('wire parsing', () => {
    it('refuses oversized live-ink messages', () => {
        const batch = (count: number) => Array.from({ length: count * 3 }, () => 0.5);
        expect(parseInkProgress(msg({ pts: batch(INK_LIMITS.maxBatchPoints) }))).not.toBeNull();
        expect(parseInkProgress(msg({ pts: batch(INK_LIMITS.maxBatchPoints + 1) }))).toBeNull();
        expect(parseInkProgress(msg({ strokeId: 'x'.repeat(INK_LIMITS.maxIdLength) }))).not.toBeNull();
        expect(parseInkProgress(msg({ strokeId: 'x'.repeat(INK_LIMITS.maxIdLength + 1) }))).toBeNull();
        expect(parseInkProgress(msg({ userId: 'u'.repeat(INK_LIMITS.maxIdLength + 1) }))).toBeNull();
        expect(parseInkProgress(msg({ color: '#'.repeat(INK_LIMITS.maxColorLength + 1) }))).toBeNull();
        // A real stroke id and the sender's largest pen-up batch still pass.
        expect(parseInkProgress(msg({ strokeId: crypto.randomUUID(), pts: batch(1500) }))).not.toBeNull();
    });

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

    it('accepts a row whose author has deleted their account', () => {
        // The FK sets created_by to null, which is an UPDATE: it is broadcast
        // like any other, and dropping it as malformed would leave every open
        // client showing the old author until a full re-pull.
        const row = parseDbChange({
            operation: 'UPDATE',
            schema: 'public',
            table: 'annotations',
            record: {
                id: 'a1',
                document_id: 'd1',
                page: 0,
                kind: 'stroke',
                color: '#000',
                payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
                created_by: null,
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-02T00:00:00Z',
                deleted_at: null,
                seq: 4,
            },
            old_record: null,
        });
        expect(row?.id).toBe('a1');
        expect(row?.created_by).toBeNull();
    });
});
