import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DbModule from '@/sync/db';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import type { Annotation } from '@/types/models';

let db: ScribblerDb;
vi.mock('@/sync/db', async (importOriginal) => ({
    ...(await importOriginal<typeof DbModule>()),
    getDb: () => db,
}));

import { loadExportAnnotations } from '@/features/export/exportAnnotations';

const DOC = 'c0ffee00-0000-4000-8000-0000000000e1';
const USER = 'user-1';
const OTHER = 'user-other';

const stroke = (id: string, page = 0): Annotation => ({
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

/** Marks drawn on this device by `author`, still queued. */
const drawAs = async (author: string, ...annotations: Annotation[]) => {
    const store = new AnnotationStore(db, DOC);
    store.setAuthor(author);
    await store.load();
    for (const annotation of annotations) {
        await store.create(annotation);
    }
    return store;
};

beforeEach(() => {
    db = new ScribblerDb(`export-${crypto.randomUUID()}`);
});

describe('loadExportAnnotations', () => {
    it('leaves out the marks another account queued on this device, as the viewer does', async () => {
        await drawAs(OTHER, stroke('theirs'));
        await drawAs(USER, stroke('mine'), stroke('mine-p2', 1));
        // A synced mark another account then edited offline: its unsynced version stays out too.
        await db.annotations.put({ ...stroke('shared'), seq: 4, pending: 0 });
        const theirs = new AnnotationStore(db, DOC);
        theirs.setAuthor(OTHER);
        await theirs.load();
        await theirs.update('shared', { color: '#aa0000' });

        const viewer = new AnnotationStore(db, DOC);
        viewer.setAuthor(USER);
        await viewer.load();
        const drawn = [...viewer.getPage(0).keys(), ...viewer.getPage(1).keys()].sort();

        expect((await loadExportAnnotations(DOC, USER)).map((a) => a.id).sort()).toEqual(drawn);
        expect(drawn).toEqual(['mine', 'mine-p2']);
        expect((await loadExportAnnotations(DOC, USER, 1)).map((a) => a.id)).toEqual(['mine-p2']);
        // Their own export has theirs, and none of this account's queued ones.
        expect((await loadExportAnnotations(DOC, OTHER)).map((a) => a.id).sort()).toEqual(['shared', 'theirs']);
    });

    it('leaves out erased marks', async () => {
        const store = await drawAs(USER, stroke('kept'), stroke('erased'));
        await store.delete('erased');

        expect((await loadExportAnnotations(DOC, USER)).map((a) => a.id)).toEqual(['kept']);
    });
});

describe('loadExportAnnotations and marks this device could not store (SF-1)', () => {
    it('bakes in the viewer’s unsaved version of a mark, including an erase that failed to save', async () => {
        const store = await drawAs(USER, stroke('kept'), stroke('erased'));
        const full = vi
            .spyOn(db.ops, 'bulkAdd')
            .mockRejectedValue(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
        try {
            await store.create(stroke('new')).catch(() => undefined);
            await store.update('kept', { color: '#ff0000' }).catch(() => undefined);
            await store.delete('erased').catch(() => undefined);

            const marks = await loadExportAnnotations(DOC, USER);

            // The mirror has the old 'kept', the live 'erased' and no 'new'.
            expect(new Map(marks.map((a) => [a.id, a.color]))).toEqual(
                new Map([
                    ['kept', '#ff0000'],
                    ['new', '#111111'],
                ]),
            );
        } finally {
            full.mockRestore();
            await store.retryFailedPersist();
        }
    });
});
