import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LocalAnnotationSnapshot } from '@/features/viewer/history/snapshotTypes';
import type { AnnotationStore } from '@/sync/annotationStore';

const toast = vi.hoisted(() => ({
    success: vi.fn(),
    saved: vi.fn(),
    shared: vi.fn(),
    error: vi.fn(),
    promise: vi.fn(<T,>(promise: Promise<T>) => promise),
}));
vi.mock('@/ui/toast', async (importOriginal) => ({ ...(await importOriginal<object>()), toast }));

const listSnapshots = vi.fn();
const getSnapshot = vi.fn();
vi.mock('@/features/viewer/history/snapshotService', () => ({
    SNAPSHOT_PULL_LIMIT: 30,
    listSnapshots: (...args: unknown[]) => listSnapshots(...args),
    getSnapshot: (...args: unknown[]) => getSnapshot(...args),
}));

import { LessonHistoryButton } from '@/features/viewer/history/LessonHistoryButton';

const SNAPSHOT: LocalAnnotationSnapshot = {
    id: 'snap-1',
    docId: 'doc-1',
    capturedOn: '2026-10-22',
    label: null,
    payload: [],
    createdAt: '2026-10-22T08:00:00Z',
    createdBy: null,
    pending: 0,
};

const storeWith = (restoreFromSnapshot: () => Promise<void>) =>
    ({
        docId: 'doc-1',
        overlayMode: null,
        restoreFromSnapshot,
        setHistoryOverlay: vi.fn(),
    }) as unknown as AnnotationStore;

beforeEach(() => {
    listSnapshots.mockResolvedValue([SNAPSHOT]);
    getSnapshot.mockResolvedValue(SNAPSHOT);
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

const restore = async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'History' }));
    await user.click(await screen.findByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
        [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Restore') as HTMLButtonElement,
    );
};

describe('LessonHistoryButton', () => {
    it('confirms a restore with a toast as the dialog closes', async () => {
        const restoreFromSnapshot = vi.fn(async () => undefined);
        render(<LessonHistoryButton store={storeWith(restoreFromSnapshot)} canRestore />);

        await restore();

        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith('Marks restored', {
                description: expect.stringContaining('Undo brings back what was there.'),
            }),
        );
        expect(restoreFromSnapshot).toHaveBeenCalledWith([]);
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Lesson history' })).not.toBeInTheDocument());
    });

    it('keeps a failed restore in the dialog, without a toast', async () => {
        const restoreFromSnapshot = vi.fn(async () => {
            throw new Error('Restore failed: storage full');
        });
        render(<LessonHistoryButton store={storeWith(restoreFromSnapshot)} canRestore />);

        await restore();

        expect(await screen.findByText('Restore failed: storage full')).toBeInTheDocument();
        expect(toast.success).not.toHaveBeenCalled();
    });
});
