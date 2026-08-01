import { beforeEach, describe, expect, it } from 'vitest';

import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { SyncEngine, type AnnotationsApi, type ApiError } from '@/sync/syncEngine';
import type { AnnotationInsert, AnnotationRow, AnnotationUpdate } from '@/types/database';
import type { Annotation } from '@/types/models';

const DOC = 'c0ffee00-0000-4000-8000-000000000001';
const USER = 'user-1';

const makeStroke = (id: string, page = 0): Annotation => ({
    id,
    docId: DOC,
    page,
    kind: 'stroke',
    color: '#111111',
    payload: { pts: [0.1, 0.1, 0.5, 0.2, 0.2, 0.5], w: 0.005 },
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

/** In-memory server: assigns seq like the DB trigger; can go offline. */
class FakeApi implements AnnotationsApi {
    rows = new Map<string, AnnotationRow>();
    offline = false;
    nextSeq = 1;
    inserts = 0;
    updates = 0;

    private err(): ApiError {
        return { message: 'network down', transient: true };
    }

    async insertIgnoreDuplicates(row: AnnotationInsert) {
        if (this.offline) {
            return { error: this.err() };
        }
        this.inserts += 1;
        if (!this.rows.has(row.id)) {
            this.rows.set(row.id, {
                ...row,
                created_at: row.created_at ?? new Date().toISOString(),
                deleted_at: row.deleted_at ?? null,
                page_countIgnored: undefined,
                updated_at: new Date().toISOString(),
                seq: this.nextSeq++,
            } as unknown as AnnotationRow);
        }
        return { error: null };
    }

    async update(id: string, _docId: string, patch: AnnotationUpdate) {
        if (this.offline) {
            return { error: this.err() };
        }
        this.updates += 1;
        const existing = this.rows.get(id);
        if (existing) {
            this.rows.set(id, { ...existing, ...patch, updated_at: new Date().toISOString(), seq: this.nextSeq++ });
        }
        return { error: null };
    }

    async fetchOne(id: string) {
        if (this.offline) {
            return { data: null, error: this.err() };
        }
        return { data: this.rows.get(id) ?? null, error: null };
    }

    async fetchSince(docId: string, afterSeq: number, limit: number) {
        if (this.offline) {
            return { data: null, error: this.err() };
        }
        const data = [...this.rows.values()]
            .filter((r) => r.document_id === docId && r.seq > afterSeq)
            .sort((a, b) => a.seq - b.seq)
            .slice(0, limit);
        return { data, error: null };
    }
}

let db: ScribblerDb;
let store: AnnotationStore;
let api: FakeApi;
let engine: SyncEngine;

beforeEach(async () => {
    db = new ScribblerDb(`test-${crypto.randomUUID()}`);
    store = new AnnotationStore(db, DOC);
    await store.load();
    api = new FakeApi();
    engine = new SyncEngine({ db, store, api, docId: DOC, getUserId: () => USER });
});

describe('SyncEngine.flush', () => {
    it('drains creates to the server and clears pending', async () => {
        await store.create(makeStroke('a1'));
        await engine.flush();

        expect(api.inserts).toBe(1);
        expect(api.rows.get('a1')?.created_by).toBe(USER);
        expect(await db.ops.count()).toBe(0);
        expect((await db.annotations.get('a1'))?.pending).toBe(0);
    });

    it('keeps ops queued while offline and drains after reconnect', async () => {
        api.offline = true;
        await store.create(makeStroke('a1'));
        await store.delete('a1');
        await engine.flush();
        expect(await db.ops.count()).toBe(2);

        api.offline = false;
        await engine.flush();
        expect(await db.ops.count()).toBe(0);
        expect(api.rows.get('a1')?.deleted_at).not.toBeNull();
    });

    it('drops rejected ops and repairs from server truth', async () => {
        // Server already has the row (someone else's version).
        api.rows.set('a1', {
            id: 'a1',
            document_id: DOC,
            page: 0,
            kind: 'stroke',
            color: '#00ff00',
            payload: { pts: [0.5, 0.5, 0.5], w: 0.005 },
            created_by: 'other',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            deleted_at: null,
            seq: 7,
        });
        api.update = async () => ({ error: { message: 'rls rejection', transient: false } });

        await store.create(makeStroke('a1')); // duplicate id; insert is ignoreDuplicates → fine
        await store.update('a1', { color: '#123456' }); // this update will be "rejected"
        await engine.flush();

        expect(await db.ops.count()).toBe(0);
        // Repair adopted the server row.
        expect(store.get('a1')?.color).toBe('#00ff00');
        expect(store.get('a1')?.seq).toBe(7);
    });

    it('discards local annotations the server never accepted', async () => {
        api.insertIgnoreDuplicates = async () => ({ error: { message: 'rls rejection', transient: false } });
        await store.create(makeStroke('a1'));
        await engine.flush();

        expect(store.get('a1')).toBeUndefined();
        expect(await db.annotations.get('a1')).toBeUndefined();
    });
});

describe('SyncEngine.pullSince', () => {
    it('applies remote rows and advances the watermark', async () => {
        await api.insertIgnoreDuplicates({
            id: 'r1',
            document_id: DOC,
            page: 2,
            kind: 'stroke',
            color: '#ff0000',
            payload: { pts: [0.1, 0.1, 0.5], w: 0.005 },
            created_by: 'other',
        });
        await engine.pullSince();

        expect(store.getPage(2).has('r1')).toBe(true);
        expect((await db.syncState.get(DOC))?.watermarkSeq).toBe(1);
    });

    it('skips rows with pending local ops (local intent wins until acked)', async () => {
        api.offline = true;
        await store.create(makeStroke('a1'));
        await store.update('a1', { color: '#ffffff' });
        api.offline = false;

        // Server has a conflicting version of a1.
        api.rows.set('a1', {
            id: 'a1',
            document_id: DOC,
            page: 0,
            kind: 'stroke',
            color: '#000000',
            payload: { pts: [0.9, 0.9, 0.5], w: 0.005 },
            created_by: 'other',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            deleted_at: null,
            seq: 3,
        });
        await engine.pullSince();
        expect(store.get('a1')?.color).toBe('#ffffff'); // local intent preserved
    });

    it('ignores remote rows older than the local seq (LWW)', async () => {
        await store.applyRemoteBatch([{ ...makeStroke('a1'), seq: 10, color: '#aaaaaa' }], new Set());
        await store.applyRemoteBatch([{ ...makeStroke('a1'), seq: 5, color: '#bbbbbb' }], new Set());
        expect(store.get('a1')?.color).toBe('#aaaaaa');
    });

    it('applies remote tombstones by removing from the page map', async () => {
        await store.applyRemoteBatch([{ ...makeStroke('a1'), seq: 1 }], new Set());
        expect(store.getPage(0).has('a1')).toBe(true);
        await store.applyRemoteBatch([{ ...makeStroke('a1'), seq: 2, deletedAt: '2026-01-02T00:00:00Z' }], new Set());
        expect(store.getPage(0).has('a1')).toBe(false);
    });
});

describe('offline → queue → flush → converge (integration)', () => {
    it('converges both directions after reconnect', async () => {
        // Local draws while offline.
        api.offline = true;
        await store.create(makeStroke('local1', 1));
        // Remote (the other collaborator) drew meanwhile.
        api.rows.set('remote1', {
            id: 'remote1',
            document_id: DOC,
            page: 1,
            kind: 'highlight',
            color: '#eab308',
            payload: { pts: [0.3, 0.3, 0.5, 0.4, 0.3, 0.5], w: 0.0175 },
            created_by: 'other',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            deleted_at: null,
            seq: 41,
        });
        api.nextSeq = 42;

        await engine.sync(); // offline: nothing happens, op stays
        expect(await db.ops.count()).toBe(1);

        api.offline = false;
        await engine.sync();

        // Local reached the server…
        expect(api.rows.get('local1')?.created_by).toBe(USER);
        // …and the remote stroke reached us.
        expect(store.getPage(1).has('remote1')).toBe(true);
        expect(await db.ops.count()).toBe(0);
    });
});
