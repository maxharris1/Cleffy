import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DbModule from '@/sync/db';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { closeDocInk, forgetDocInk, resetInkRecoveryForTests, retireAccountInk, retryHeld } from '@/sync/inkRecovery';
import type { Annotation } from '@/types/models';

let db: ScribblerDb;
vi.mock('@/sync/db', async (importOriginal) => ({
    ...(await importOriginal<typeof DbModule>()),
    getDb: () => db,
}));

import { exportNotice, loadExportAnnotations, loadExportMarks } from '@/features/export/exportAnnotations';

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

afterEach(() => {
    vi.restoreAllMocks();
    resetInkRecoveryForTests();
});

const quotaError = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

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
        }
    });

    it('leaves out another account’s unsaved marks: A’s failed mark never reaches B’s export (finding 1)', async () => {
        await db.annotations.put({ ...stroke('shared'), seq: 3, pending: 0 });
        const asA = await drawAs(USER);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await asA.create(stroke('a-secret')).catch(() => undefined);
        await asA.update('shared', { color: '#ff0000' }).catch(() => undefined);
        full.mockRestore();

        const forB = await loadExportAnnotations(DOC, OTHER);

        expect(new Map(forB.map((a) => [a.id, a.color]))).toEqual(new Map([['shared', '#111111']]));
        expect((await loadExportAnnotations(DOC, USER)).map((a) => a.id).sort()).toEqual(['a-secret', 'shared']);
    });

    it('red fails, then blue is stored: the export has blue (finding 2)', async () => {
        const store = await drawAs(USER, stroke('a1'));
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.update('a1', { color: '#ff0000' }).catch(() => undefined);
        full.mockRestore();
        const reopened = await drawAs(USER);
        await reopened.update('a1', { color: '#0000ff' });

        expect((await loadExportAnnotations(DOC, USER)).map((a) => a.color)).toEqual(['#0000ff']);
    });

    it('a failed erase does not hide the mark once another tab of this device stored a newer one (finding 2)', async () => {
        const store = await drawAs(USER, stroke('a1'));
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.delete('a1').catch(() => undefined);
        full.mockRestore();
        const later = new Date(Date.now() + 60_000).toISOString();
        await db.annotations.put({ ...stroke('a1'), color: '#00aa00', updatedAt: later, pending: 1 });

        expect((await loadExportAnnotations(DOC, USER)).map((a) => a.color)).toEqual(['#00aa00']);
    });

    it('works from memory when the database is closed: the open viewer’s marks, unsaved ones included (finding 3)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = await drawAs(USER, stroke('saved'), stroke('saved-p2', 1));
        const detach = store.attach();
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create(stroke('unsaved')).catch(() => undefined);
        await store.delete('saved-p2').catch(() => undefined);
        full.mockRestore();

        db.close();
        await expect(db.annotations.count()).rejects.toThrow();

        expect((await loadExportAnnotations(DOC, USER)).map((a) => a.id).sort()).toEqual(['saved', 'unsaved']);
        expect((await loadExportAnnotations(DOC, USER, 1)).map((a) => a.id)).toEqual([]);
        // Not another account's view of it.
        expect((await loadExportAnnotations(DOC, OTHER)).map((a) => a.id)).toEqual([]);

        // With the viewer closed, the unsaved marks are still exported.
        detach();
        expect((await loadExportAnnotations(DOC, USER)).map((a) => a.id)).toEqual(['unsaved']);
    });

    it('bakes in a device-only score’s unsaved marks whoever is signed in: its viewer draws for no account', async () => {
        const LOCAL = 'local-0123456789abcdef';
        const store = new AnnotationStore(db, LOCAL);
        await store.load();
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create({ ...stroke('unsaved'), docId: LOCAL }).catch(() => undefined);
        full.mockRestore();

        expect((await loadExportAnnotations(LOCAL, USER)).map((a) => a.id)).toEqual(['unsaved']);
    });

    it('an incomplete export says so, naming what is missing: no viewer open and the database unreadable (MAJOR 3)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = await drawAs(USER, stroke('saved'));
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create(stroke('unsaved')).catch(() => undefined);
        full.mockRestore();
        db.close();

        const marks = await loadExportMarks(DOC, USER);

        expect(marks.annotations.map((a) => a.id)).toEqual(['unsaved']);
        expect(marks.incomplete).toEqual({ unsaved: 1 });
        expect(exportNotice(marks)).toMatch(
            /missing marks.*storage couldn’t be read.*only the 1 unsaved mark.*not the score’s saved marks/,
        );
    });

    it('an export made from the open viewer’s memory is complete: no notice', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const store = await drawAs(USER, stroke('saved'));
        store.attach();
        db.close();

        const marks = await loadExportMarks(DOC, USER);

        expect(marks.annotations.map((a) => a.id)).toEqual(['saved']);
        expect(marks.incomplete).toBeNull();
        expect(exportNotice(marks)).toBeNull();
    });

    it('newer row already uploaded by another tab: the export has both versions, and says so (MAJOR 2)', async () => {
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        const store = new AnnotationStore(db, DOC);
        store.setAuthor(USER);
        await store.load();
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.update('a1', { color: '#ff0000' }).catch(() => undefined);
        full.mockRestore();
        const later = new Date(Date.now() + 60_000).toISOString();
        await db.annotations.put({ ...stroke('a1'), seq: 5, color: '#0000ff', updatedAt: later, pending: 0 });

        const marks = await loadExportMarks(DOC, USER);

        expect(marks.annotations.map((a) => `${a.id}:${a.color}`).sort()).toEqual(['a1:#0000ff', 'a1:unsaved:#ff0000']);
        expect(marks.conflicts).toBe(1);
        expect(exportNotice(marks)).toMatch(/One of your unsaved marks changed elsewhere.*both versions/);
    });

    /** a1 recoloured red here while the disk was full, then overtaken by a newer blue version: a conflict. */
    const conflictedRed = async (): Promise<AnnotationStore> => {
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        const store = new AnnotationStore(db, DOC);
        store.setAuthor(USER);
        await store.load();
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.update('a1', { color: '#ff0000' }).catch(() => undefined);
        full.mockRestore();
        await db.annotations.put({ ...stroke('a1'), seq: 9, color: '#0000ff', pending: 0 });
        await store.retryFailedPersist();
        expect(store.conflictCount).toBe(1);
        return store;
    };

    it('Dismiss followed by Export: the hidden conflict is still in the export (round 3, item 1)', async () => {
        const store = await conflictedRed();

        store.hideConflictNotice();
        const marks = await loadExportMarks(DOC, USER);

        expect(marks.annotations.map((a) => `${a.id}:${a.color}`).sort()).toEqual(['a1:#0000ff', 'a1:unsaved:#ff0000']);
        expect(exportNotice(marks)).toMatch(/both versions/);
    });

    it('an overtaken erase: the export shows the newer version, and says the erase was overtaken (round 3, item 1)', async () => {
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        const store = new AnnotationStore(db, DOC);
        store.setAuthor(USER);
        await store.load();
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.delete('a1').catch(() => undefined);
        full.mockRestore();
        await db.annotations.put({ ...stroke('a1'), seq: 9, color: '#0000ff', pending: 0 });
        await store.retryFailedPersist();

        const marks = await loadExportMarks(DOC, USER);

        expect(marks.annotations.map((a) => `${a.id}:${a.color}`)).toEqual(['a1:#0000ff']);
        expect(marks.erasedConflicts).toBe(1);
        expect(exportNotice(marks)).toBe(
            'One of your unsaved erases was overtaken by a newer version made elsewhere: the export shows that version.',
        );
    });

    it('signed out with an overtaken erase held: the copy does not promise the newer version, which is not in the export', async () => {
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        const store = new AnnotationStore(db, DOC);
        store.setAuthor(USER);
        await store.load();
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.delete('a1').catch(() => undefined);
        full.mockRestore();
        await db.annotations.put({ ...stroke('a1'), seq: 9, color: '#0000ff', pending: 0 });
        await store.retryFailedPersist();
        const fullAgain = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create(stroke('unsaved')).catch(() => undefined);
        fullAgain.mockRestore();

        retireAccountInk(USER, 'other-tab');
        const marks = await loadExportMarks(DOC, USER);

        // Only the unsaved stroke: the newer a1 is a saved mark, not this export's.
        expect(marks.annotations.map((a) => a.id)).toEqual(['unsaved']);
        expect(marks.erasedConflicts).toBe(1);
        expect(exportNotice(marks)).toBe(
            'You’re signed out, so this export has only the 1 unsaved mark this tab still holds, not the score’s saved marks. One of your unsaved erases was overtaken by a newer version made elsewhere. That version is a saved mark, so it isn’t in this export.',
        );
        expect(exportNotice(marks)).not.toMatch(/the export shows/);
    });

    it('signed out with ink still held here: the export has only that account’s unsaved marks, and says so (round 3, item 2)', async () => {
        await drawAs(OTHER, stroke('theirs'));
        await drawAs(USER, stroke('saved'));
        const store = new AnnotationStore(db, DOC);
        store.setAuthor(USER);
        await store.load();
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create(stroke('unsaved')).catch(() => undefined);
        full.mockRestore();

        retireAccountInk(USER, 'other-tab');
        const marks = await loadExportMarks(DOC, USER);

        expect(marks.annotations.map((a) => a.id)).toEqual(['unsaved']);
        expect(exportNotice(marks)).toBe(
            'You’re signed out, so this export has only the 1 unsaved mark this tab still holds, not the score’s saved marks.',
        );
        // Never another account's.
        expect((await loadExportMarks(DOC, OTHER)).annotations.map((a) => a.id)).not.toContain('unsaved');
    });
});

describe('held ink of a score lost to this device (decision 65(1))', () => {
    const holdUnsaved = async () => {
        await drawAs(USER, stroke('saved'));
        const store = new AnnotationStore(db, DOC);
        store.setAuthor(USER);
        await store.load();
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create(stroke('unsaved')).catch(() => undefined);
        full.mockRestore();
        return store;
    };

    it('access lost: the export has only the unsaved marks kept on this device, and says so', async () => {
        await holdUnsaved();

        closeDocInk(DOC);
        const marks = await loadExportMarks(DOC, USER, undefined, { lostAccess: true });

        expect(marks.annotations.map((a) => a.id)).toEqual(['unsaved']);
        expect(exportNotice(marks)).toBe(
            'You no longer have this score, so this export has only the 1 unsaved mark still on this device, not the score’s saved marks.',
        );
        // Out of the viewer's export and of Retry: nothing writes it now.
        expect((await loadExportMarks(DOC, USER)).annotations.map((a) => a.id)).toEqual(['saved']);
        expect(await retryHeld(USER, DOC)).toEqual({ ok: true, wrote: [], overtaken: [] });
        expect((await db.ops.where('docId').equals(DOC).toArray()).map((op) => op.annotationId)).toEqual(['saved']);
        expect((await loadExportMarks(DOC, USER, undefined, { lostAccess: true })).annotations).toHaveLength(1);
    });

    it('the user deleting the score themselves lets its held ink go, closed or not', async () => {
        await holdUnsaved();
        closeDocInk(DOC);

        forgetDocInk(DOC);

        expect((await loadExportMarks(DOC, USER, undefined, { lostAccess: true })).annotations).toEqual([]);
    });
});
