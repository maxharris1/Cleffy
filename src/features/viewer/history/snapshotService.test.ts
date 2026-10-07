import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationSnapshotRow } from '@/types/database';

/**
 * A tiny stand-in for the annotation_snapshots table behind PostgREST:
 * unique (document_id, captured_on), insert-or-ignore, and switchable
 * failure modes for the network and RLS.
 */
const server = vi.hoisted(() => ({
    rows: [] as AnnotationSnapshotRow[],
    /** Next upserts fail this way: 'network' (status 0) or 'forbidden' (403). */
    upsertFailure: null as null | 'network' | 'forbidden',
    upserts: 0,
}));

vi.mock('@/lib/supabase', () => {
    const table = () => {
        const filters: Array<[string, unknown]> = [];
        const matching = () =>
            server.rows.filter((row) =>
                filters.every(([col, val]) => (row as unknown as Record<string, unknown>)[col] === val),
            );
        const query = {
            eq(col: string, val: unknown) {
                filters.push([col, val]);
                return query;
            },
            order() {
                return query;
            },
            limit() {
                return Promise.resolve({ data: matching(), error: null, status: 200 });
            },
            maybeSingle() {
                return Promise.resolve({ data: matching()[0] ?? null, error: null, status: 200 });
            },
        };
        return {
            select: () => query,
            upsert: (row: Omit<AnnotationSnapshotRow, 'created_at'>) => ({
                select: () => {
                    server.upserts += 1;
                    if (server.upsertFailure === 'network') {
                        return Promise.resolve({ data: null, error: { message: 'Failed to fetch' }, status: 0 });
                    }
                    if (server.upsertFailure === 'forbidden') {
                        return Promise.resolve({ data: null, error: { message: 'rls' }, status: 403 });
                    }
                    const taken = server.rows.some(
                        (r) => r.document_id === row.document_id && r.captured_on === row.captured_on,
                    );
                    if (taken) {
                        return Promise.resolve({ data: [], error: null, status: 201 });
                    }
                    server.rows.push({ ...row, created_at: '2026-10-07T00:00:00Z' });
                    return Promise.resolve({ data: [{ id: row.id }], error: null, status: 201 });
                },
            }),
        };
    };
    return { getSupabase: () => ({ from: () => table() }) };
});

import {
    countPendingSnapshots,
    ensureDayStartingSnapshot,
    listSnapshots,
    retryPendingSnapshots,
} from '@/features/viewer/history/snapshotService';
import { localDateString } from '@/features/viewer/history/snapshotTypes';
import { getDb } from '@/sync/db';

const DOC = 'c0ffee00-0000-4000-8000-0000000000aa';
const today = localDateString();

/** Let the fire-and-forget upload inside ensureDayStartingSnapshot finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(async () => {
    server.rows = [];
    server.upsertFailure = null;
    server.upserts = 0;
    await getDb().annotationSnapshots.clear();
});

describe('day snapshot upload', () => {
    it('uploads the day snapshot and marks it synced', async () => {
        const snap = await ensureDayStartingSnapshot(getDb(), DOC, []);
        await settle();
        expect(server.rows.map((r) => r.id)).toEqual([snap!.id]);
        expect((await getDb().annotationSnapshots.get(snap!.id))?.pending).toBe(0);
    });

    it('keeps a failed upload pending and retries it later', async () => {
        server.upsertFailure = 'network';
        const snap = await ensureDayStartingSnapshot(getDb(), DOC, []);
        await settle();
        expect((await getDb().annotationSnapshots.get(snap!.id))?.pending).toBe(1);
        expect(await countPendingSnapshots()).toBe(1);

        server.upsertFailure = null;
        await retryPendingSnapshots(getDb());

        expect(server.rows.map((r) => r.id)).toEqual([snap!.id]);
        expect((await getDb().annotationSnapshots.get(snap!.id))?.pending).toBe(0);
        expect(await countPendingSnapshots()).toBe(0);
    });

    it("adopts another device's row when the server already has the day", async () => {
        server.upsertFailure = 'network';
        const mine = await ensureDayStartingSnapshot(getDb(), DOC, []);
        await settle();
        server.upsertFailure = null;
        server.rows.push({
            id: 'theirs-0000-4000-8000-000000000000',
            document_id: DOC,
            captured_on: today,
            label: null,
            payload: [],
            created_at: '2026-10-07T06:00:00Z',
            created_by: null,
        });

        await retryPendingSnapshots(getDb());

        const local = await getDb().annotationSnapshots.where('docId').equals(DOC).toArray();
        expect(local.map((r) => r.id)).toEqual(['theirs-0000-4000-8000-000000000000']);
        expect(local[0]?.pending).toBe(0);
        expect(await getDb().annotationSnapshots.get(mine!.id)).toBeUndefined();
    });

    it('treats a retried upload of our own row (lost response) as done', async () => {
        const snap = await ensureDayStartingSnapshot(getDb(), DOC, []);
        await settle();
        // Pretend the response was lost: still pending locally, already on the server.
        await getDb().annotationSnapshots.update(snap!.id, { pending: 1 });

        await retryPendingSnapshots(getDb());

        expect(server.rows).toHaveLength(1);
        expect((await getDb().annotationSnapshots.get(snap!.id))?.pending).toBe(0);
    });

    it('stops asking to upload when the server refuses for good (403)', async () => {
        server.upsertFailure = 'forbidden';
        const snap = await ensureDayStartingSnapshot(getDb(), DOC, []);
        await settle();
        expect((await getDb().annotationSnapshots.get(snap!.id))?.pending).toBe(0);
        // Kept locally as history.
        expect(await getDb().annotationSnapshots.get(snap!.id)).toBeDefined();
    });

    it('two edits in the same tick capture one snapshot, and neither fails', async () => {
        server.upsertFailure = 'network';
        const results = await Promise.all([
            ensureDayStartingSnapshot(getDb(), DOC, []),
            ensureDayStartingSnapshot(getDb(), DOC, []),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await getDb().annotationSnapshots.where('docId').equals(DOC).count()).toBe(1);
    });

    it('listing history uploads pending rows first and reconciles with the server', async () => {
        server.upsertFailure = 'network';
        await ensureDayStartingSnapshot(getDb(), DOC, []);
        await settle();
        server.upsertFailure = null;
        server.rows.push({
            id: 'older-day-0000-4000-8000-000000000000',
            document_id: DOC,
            captured_on: '2026-01-01',
            label: null,
            payload: [],
            created_at: '2026-01-01T06:00:00Z',
            created_by: null,
        });

        const list = await listSnapshots(DOC);

        expect(list.map((r) => r.capturedOn)).toEqual([today, '2026-01-01']);
        expect(list.every((r) => r.pending === 0)).toBe(true);
    });

    it('never uploads snapshots of local (device-only) scores', async () => {
        await ensureDayStartingSnapshot(getDb(), 'local-abcdef', []);
        await settle();
        await retryPendingSnapshots(getDb());
        expect(server.upserts).toBe(0);
    });
});
