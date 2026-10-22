import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as snapshotService from '@/features/viewer/history/snapshotService';
import { InkSaveFailedNotice } from '@/features/viewer/InkSaveFailedNotice';
import { AnnotationStore } from '@/sync/annotationStore';
import { ScribblerDb } from '@/sync/db';
import { clearAccountInk, resetInkRecoveryForTests } from '@/sync/inkRecovery';
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

    it('goes when sign-out clears the account’s held ink', async () => {
        const db = new ScribblerDb(`notice-${crypto.randomUUID()}`);
        const store = await mountStore(db);
        const full = vi.spyOn(db.ops, 'bulkAdd').mockRejectedValue(quotaError());
        await store.create(stroke('a1')).catch(() => undefined);
        full.mockRestore();
        render(<InkSaveFailedNotice store={store} />);
        expect(screen.getByRole('status')).toBeInTheDocument();

        clearAccountInk();

        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
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
});
