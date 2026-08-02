import { useEffect, useState } from 'react';

import {
    getSnapshot,
    listSnapshots,
    SNAPSHOT_PULL_LIMIT,
} from '@/features/viewer/history/snapshotService';
import type { LocalAnnotationSnapshot } from '@/features/viewer/history/snapshotTypes';
import type { AnnotationStore } from '@/sync/annotationStore';

interface LessonHistoryButtonProps {
    store: AnnotationStore;
    canRestore: boolean;
}

export const LessonHistoryButton = ({ store, canRestore }: LessonHistoryButtonProps) => {
    const [open, setOpen] = useState(false);

    return (
        <>
            <button
                type="button"
                title="Lesson history — starting points by day"
                onClick={() => setOpen(true)}
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-100"
            >
                History
            </button>
            {open ? (
                <LessonHistoryDialog store={store} canRestore={canRestore} onClose={() => setOpen(false)} />
            ) : null}
        </>
    );
};

const LessonHistoryDialog = ({
    store,
    canRestore,
    onClose,
}: {
    store: AnnotationStore;
    canRestore: boolean;
    onClose: () => void;
}) => {
    const [rows, setRows] = useState<LocalAnnotationSnapshot[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const viewing = store.isHistoryMode;

    useEffect(() => {
        let cancelled = false;
        void listSnapshots(store.docId)
            .then((list) => {
                if (!cancelled) {
                    setRows(list);
                }
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : 'Could not load history');
                }
            });
        return () => {
            cancelled = true;
        };
    }, [store.docId]);

    const viewDay = async (snapshotId: string) => {
        setBusy(true);
        try {
            const snap = await getSnapshot(store.docId, snapshotId);
            if (!snap) {
                setError('Snapshot not found');
                return;
            }
            store.setHistoryOverlay(snap.payload);
            onClose();
        } finally {
            setBusy(false);
        }
    };

    const restoreDay = async (snapshotId: string) => {
        if (!canRestore) {
            return;
        }
        const ok = window.confirm(
            'Restore this day’s starting annotations? Current marks will be replaced (you can undo).',
        );
        if (!ok) {
            return;
        }
        setBusy(true);
        try {
            const snap = await getSnapshot(store.docId, snapshotId);
            if (!snap) {
                setError('Snapshot not found');
                return;
            }
            await store.restoreFromSnapshot(snap.payload);
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Restore failed');
        } finally {
            setBusy(false);
        }
    };

    const exitView = () => {
        store.setHistoryOverlay(null);
        onClose();
    };

    return (
        <div
            className="fixed inset-0 z-40 flex items-end justify-center bg-stone-900/40 p-4 sm:items-center"
            role="dialog"
            aria-modal
            aria-label="Lesson history"
            onClick={onClose}
        >
            <div
                className="max-h-[80vh] w-full max-w-md overflow-auto rounded-2xl border border-stone-200 bg-white shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
                    <div>
                        <h2 className="text-sm font-semibold text-stone-800">Lesson history</h2>
                        <p className="text-xs text-stone-500">Starting point captured on first edit each day</p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-lg px-2 py-1 text-sm text-stone-500 hover:bg-stone-100"
                    >
                        Close
                    </button>
                </div>

                {viewing ? (
                    <div className="border-b border-amber-100 bg-amber-50 px-4 py-3">
                        <p className="text-sm text-amber-900">Viewing a past starting point (read-only).</p>
                        <button
                            type="button"
                            onClick={exitView}
                            className="mt-2 rounded-lg bg-amber-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700"
                        >
                            Back to current
                        </button>
                    </div>
                ) : null}

                <div className="px-4 py-3">
                    {error ? <p className="mb-2 text-sm text-red-600">{error}</p> : null}
                    {rows === null ? (
                        <p className="animate-pulse text-sm text-stone-500">Loading…</p>
                    ) : rows.length === 0 ? (
                        <p className="text-sm text-stone-600">
                            No daily starting points yet. The first mark you make each day freezes that morning&apos;s
                            state automatically.
                        </p>
                    ) : (
                        <>
                            {rows.length >= SNAPSHOT_PULL_LIMIT ? (
                                <p className="mb-2 text-xs text-stone-500">
                                    Showing the latest {SNAPSHOT_PULL_LIMIT} starting points.
                                </p>
                            ) : null}
                        <ul className="flex flex-col gap-2">
                            {rows.map((row) => (
                                <li
                                    key={row.id}
                                    className="flex flex-wrap items-center gap-2 rounded-xl border border-stone-100 px-3 py-2"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-medium text-stone-800">{formatDay(row.capturedOn)}</p>
                                        <p className="text-xs text-stone-500">
                                            {row.payload.filter((a) => !a.deletedAt).length} marks
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void viewDay(row.id)}
                                        className="rounded-lg px-2.5 py-1 text-sm text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                                    >
                                        View
                                    </button>
                                    {canRestore ? (
                                        <button
                                            type="button"
                                            disabled={busy}
                                            onClick={() => void restoreDay(row.id)}
                                            className="rounded-lg px-2.5 py-1 text-sm text-stone-600 hover:bg-stone-100 disabled:opacity-50"
                                        >
                                            Restore
                                        </button>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

const formatDay = (isoDate: string): string => {
    const [y, m, d] = isoDate.split('-').map(Number);
    if (!y || !m || !d) {
        return isoDate;
    }
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
};
