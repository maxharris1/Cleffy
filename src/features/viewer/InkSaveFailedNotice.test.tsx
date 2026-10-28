import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as snapshotService from '@/features/viewer/history/snapshotService';
import { InkSaveFailedNotice } from '@/features/viewer/InkSaveFailedNotice';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import {
    heldInkForExport,
    holdOps,
    MAX_HELD_OPS,
    resetInkRecoveryForTests,
    retireAccountInk,
} from '@/sync/inkRecovery';
import type { Annotation } from '@/types/models';

const DOC = 'c0ffee00-0000-4000-8000-0000000000b1';
const USER = 'user-1';

const stroke = (id: string): Annotation => ({
    id,
    docId: DOC,
    page: 0,
    kind: 'stroke',
    color: '#111111',
    payload: { pts: [0.1, 0.1, 0.5, 0.2, 0.2, 0.5], w: 0.005 },
    createdBy: null,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
    deletedAt: null,
    seq: 0,
});

const quotaError = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

const mountStore = async (db: ScribblerDb) => {
    const store = new AnnotationStore(db, DOC);
    store.setAuthor(USER);
    await store.load();
    return store;
};

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    resetInkRecoveryForTests();
});

describe('InkSaveFailedNotice', () => {
    it('comes back on the next open of the score, and its Retry there saves the marks (finding 2)', async () => {
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        const first = await mountStore(db);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await first.create(stroke('a1')).catch(() => undefined);
        full.mockRestore();
        const { unmount } = render(<InkSaveFailedNotice store={first} onExport={() => undefined} />);
        expect(screen.getByText('Some marks couldn’t be saved on this device.')).toBeInTheDocument();
        unmount();

        // The score is opened again: a new viewer, a new store.
        const reopened = await mountStore(db);
        render(<InkSaveFailedNotice store={reopened} onExport={() => undefined} />);

        expect(screen.getByText('Some marks couldn’t be saved on this device.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
        expect((await db.ops.toArray()).map((op) => op.annotationId)).toEqual(['a1']);
    });

    it('leaves the viewer when its account signs out; the ink stays for the signed-out notice (round 3)', async () => {
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        const store = await mountStore(db);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create(stroke('a1')).catch(() => undefined);
        full.mockRestore();
        render(<InkSaveFailedNotice store={store} />);
        expect(screen.getByRole('status')).toBeInTheDocument();

        retireAccountInk(USER);

        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
        // Not dropped: cut off, and kept for Export or Discard (SignedOutInkNotice).
        expect(heldInkForExport(USER, store.docId).held.map((a) => a.id)).toEqual(['a1']);
    });

    it('says so when an edit was refused for want of the day’s snapshot, with Retry and no Export (C1)', async () => {
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        const store = await mountStore(db);
        await store.create(stroke('a1'));
        await db.annotationSnapshots.clear();
        vi.spyOn(snapshotService, 'ensureDayStartingSnapshot').mockRejectedValueOnce(quotaError());
        await store.update('a1', { color: '#ff0000' }).catch(() => undefined);

        render(<InkSaveFailedNotice store={store} onExport={() => undefined} />);

        expect(
            screen.getByText(
                'A change couldn’t be saved on this device, so it wasn’t made. Retry, then make it again.',
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
        expect(await db.annotationSnapshots.count()).toBe(1);
    });

    it('has short copy for phones beside the long copy for wider screens', async () => {
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        const store = await mountStore(db);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create(stroke('a1')).catch(() => undefined);
        render(<InkSaveFailedNotice store={store} onExport={() => undefined} />);

        expect(screen.getByText('Some marks aren’t saved on this device.')).toHaveClass('sm:hidden');
        expect(screen.getByText('Some marks couldn’t be saved on this device.')).toHaveClass('hidden', 'sm:inline');
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByText('Still not saved. Storage may be full: export a copy.')).toHaveClass(
            'sm:hidden',
        );
        full.mockRestore();
    });

    it('when a newer version overtook the held marks: says so, offers Export, Dismiss and Discard, and no Retry (MAJOR 2)', async () => {
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        const store = await mountStore(db);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.update('a1', { color: '#ff0000' }).catch(() => undefined);
        full.mockRestore();
        await db.annotations.put({ ...stroke('a1'), seq: 9, color: '#0000ff', pending: 0 });
        const onExport = vi.fn();
        render(<InkSaveFailedNotice store={store} onExport={onExport} />);
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

        expect(
            await screen.findByText(
                'Some of your unsaved marks were changed elsewhere before this device could save them, so the newer versions are shown. Export a copy to keep yours.',
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Export' }));
        expect(onExport).toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
        // Dismiss hides the notice only: the held version stays for Export (round 3, item 1).
        await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
        expect(store.conflictCount).toBe(1);
        expect(heldInkForExport(USER, DOC).conflicts.map((a) => a.color)).toEqual(['#ff0000']);
    });

    it('Discard asks first, offering Export, and only its confirm lets the conflicts go (round 3, item 1)', async () => {
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        const store = await mountStore(db);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.update('a1', { color: '#ff0000' }).catch(() => undefined);
        full.mockRestore();
        await db.annotations.put({ ...stroke('a1'), seq: 9, color: '#0000ff', pending: 0 });
        await store.retryFailedPersist();
        const onExport = vi.fn();
        render(<InkSaveFailedNotice store={store} onExport={onExport} />);

        await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
        const dialog = await screen.findByRole('dialog', { name: 'Discard your unsaved versions?' });
        expect(dialog).toHaveTextContent(
            'One of your unsaved changes was overtaken elsewhere, and is kept only in this tab. Discarding deletes it for good. Export a copy first to keep it.',
        );
        // Cancel keeps them.
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(store.conflictCount).toBe(1);
        // Export first opens the export and keeps them.
        await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Export first' }));
        expect(onExport).toHaveBeenCalledTimes(1);
        expect(store.conflictCount).toBe(1);
        // Only the confirm discards.
        await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
        await screen.findByRole('dialog', { name: 'Discard your unsaved versions?' });
        const confirm = screen.getAllByRole('button', { name: 'Discard' }).at(-1);
        await userEvent.click(confirm as HTMLElement);
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
        expect(store.conflictCount).toBe(0);
    });

    it('offers no Discard where Export cannot be offered first', async () => {
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        const store = await mountStore(db);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.update('a1', { color: '#ff0000' }).catch(() => undefined);
        full.mockRestore();
        await db.annotations.put({ ...stroke('a1'), seq: 9, color: '#0000ff', pending: 0 });
        await store.retryFailedPersist();
        render(<InkSaveFailedNotice store={store} />);

        expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument();
    });

    it('at the memory bound: says the new edits were not made, and offers Export of what is held (decision c)', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        const store = await mountStore(db);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create(stroke('a1')).catch(() => undefined);
        holdOps(
            db,
            'local-filler',
            Array.from({ length: MAX_HELD_OPS - 1 }, (_, i) => ({
                op: { type: 'create' as const, annotation: { ...stroke(`f${i}`), docId: 'local-filler' } },
                author: null,
            })),
        );
        await store.create(stroke('a2')).catch(() => undefined);
        full.mockRestore();
        render(<InkSaveFailedNotice store={store} onExport={() => undefined} />);

        expect(
            screen.getByText(
                'This device can’t keep any more unsaved marks, so your latest changes weren’t made. Export a copy to keep the rest, then Retry.',
            ),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
        expect(store.getPage(0).has('a2')).toBe(false);
        expect(store.getPage(0).has('a1')).toBe(true);
    });

    it('at the memory bound with nothing of this score’s held: no Export, and says to free up storage', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        const store = await mountStore(db);
        holdOps(
            db,
            'local-filler',
            Array.from({ length: MAX_HELD_OPS }, (_, i) => ({
                op: { type: 'create' as const, annotation: { ...stroke(`f${i}`), docId: 'local-filler' } },
                author: null,
            })),
        );
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create(stroke('a1')).catch(() => undefined);
        full.mockRestore();
        render(<InkSaveFailedNotice store={store} onExport={() => undefined} />);

        expect(
            screen.getByText(
                'This device can’t keep any more unsaved marks, so your latest changes weren’t made. Free up storage, then Retry.',
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('when the overtaken change was an erase: says so, and offers Export too (round 3, item 1)', async () => {
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        const store = await mountStore(db);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.delete('a1').catch(() => undefined);
        full.mockRestore();
        await db.annotations.put({ ...stroke('a1'), seq: 9, color: '#0000ff', pending: 0 });
        render(<InkSaveFailedNotice store={store} onExport={() => undefined} />);
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

        expect(
            await screen.findByText(
                'Some of your unsaved changes were overtaken by newer ones made elsewhere before this device could save them, so the newer versions are shown. Export keeps a copy of the score as it is.',
            ),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    });
});

/**
 * Where there is no Export to open (the /try demo for good, the cloud viewer
 * until it is confirmed): no button, and no copy sending the reader to one.
 */
describe('InkSaveFailedNotice with no Export', () => {
    const DEMO = 'local-demo-v1';
    const demoStroke = (id: string): Annotation => ({ ...stroke(id), docId: DEMO });
    const mountDemoStore = async (db: ScribblerDb) => {
        const store = new AnnotationStore(db, DEMO);
        await store.load();
        return store;
    };
    const mentionsExport = (container: HTMLElement) => /export/i.test(container.textContent ?? '');

    it('says to free up storage, not to export, when Retry has failed', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        const store = await mountDemoStore(db);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create(demoStroke('a1')).catch(() => undefined);
        const { container } = render(<InkSaveFailedNotice store={store} />);

        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

        expect(await screen.findByText('Still not saved. Storage may be full.')).toHaveClass('sm:hidden');
        expect(
            screen.getByText(
                'Some marks couldn’t be saved on this device, and retrying didn’t work. Free up storage, then Retry.',
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
        expect(mentionsExport(container)).toBe(false);
        full.mockRestore();
    });

    it('at the memory bound with marks of its own held: says to free up storage, not to export', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        const store = await mountDemoStore(db);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create(demoStroke('a1')).catch(() => undefined);
        holdOps(
            db,
            'local-filler',
            Array.from({ length: MAX_HELD_OPS - 1 }, (_, i) => ({
                op: { type: 'create' as const, annotation: { ...stroke(`f${i}`), docId: 'local-filler' } },
                author: null,
            })),
        );
        await store.create(demoStroke('a2')).catch(() => undefined);
        full.mockRestore();
        const { container } = render(<InkSaveFailedNotice store={store} />);

        expect(screen.getByText('Too many unsaved marks: new ones weren’t made.')).toBeInTheDocument();
        expect(
            screen.getByText(
                'This device can’t keep any more unsaved marks, so your latest changes weren’t made. Free up storage, then Retry.',
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Export' })).not.toBeInTheDocument();
        expect(mentionsExport(container)).toBe(false);
    });

    it('when a newer version overtook the held marks: no Export in the copy or the Dismiss title', async () => {
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        await db.annotations.put({ ...stroke('a1'), seq: 5, pending: 0 });
        const store = await mountStore(db);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.update('a1', { color: '#ff0000' }).catch(() => undefined);
        full.mockRestore();
        await db.annotations.put({ ...stroke('a1'), seq: 9, color: '#0000ff', pending: 0 });
        await store.retryFailedPersist();
        const { container } = render(<InkSaveFailedNotice store={store} />);

        expect(screen.getByText('Some changes were overtaken elsewhere.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveAttribute('title', 'Dismiss');
        expect(mentionsExport(container)).toBe(false);
    });
});
