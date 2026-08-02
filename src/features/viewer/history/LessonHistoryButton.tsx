import { useEffect, useState } from 'react';

import { getSnapshot, listSnapshots, SNAPSHOT_PULL_LIMIT } from '@/features/viewer/history/snapshotService';
import type { LocalAnnotationSnapshot } from '@/features/viewer/history/snapshotTypes';
import type { AnnotationStore } from '@/sync/annotationStore';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Dialog } from '@/ui/Dialog';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { buttonClassName } from '@/ui/classNames';

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
                className={buttonClassName('ghost', 'sm')}
            >
                History
            </button>
            {open ? <LessonHistoryDialog store={store} canRestore={canRestore} onClose={() => setOpen(false)} /> : null}
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
    const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
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
            setConfirmRestoreId(null);
        }
    };

    const exitView = () => {
        store.setHistoryOverlay(null);
        onClose();
    };

    return (
        <Dialog label="Lesson history" onClose={onClose} sheet>
            <p className="-mt-2 text-xs text-stone-500">Starting point captured on first edit each day</p>

            {viewing ? (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                    <p className="text-sm text-amber-900">Viewing a past starting point (read-only).</p>
                    <button
                        type="button"
                        onClick={exitView}
                        className="mt-2 rounded-lg bg-amber-800 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-700"
                    >
                        Back to current
                    </button>
                </div>
            ) : null}

            <div className="mt-3">
                {error ? <ErrorText className="mb-2">{error}</ErrorText> : null}
                {rows === null ? (
                    <LoadingText className="text-sm">Loading…</LoadingText>
                ) : rows.length === 0 ? (
                    <p className="text-sm text-stone-600">
                        No daily starting points yet. The first mark you make each day freezes that morning&apos;s state
                        automatically.
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
                                    className="flex flex-wrap items-center gap-2 rounded-xl border border-stone-200/80 px-3 py-2"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-medium text-stone-800">
                                            {formatDay(row.capturedOn)}
                                        </p>
                                        <p className="text-xs text-stone-500">
                                            {row.payload.filter((a) => !a.deletedAt).length} marks
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void viewDay(row.id)}
                                        className="rounded-lg px-2.5 py-1 text-sm text-accent transition hover:bg-accent-soft disabled:opacity-50"
                                    >
                                        View
                                    </button>
                                    {canRestore ? (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={busy}
                                            onClick={() => setConfirmRestoreId(row.id)}
                                            className="px-2.5 py-1"
                                        >
                                            Restore
                                        </Button>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>

            {confirmRestoreId ? (
                <ConfirmDialog
                    title="Restore this day?"
                    body="Current marks will be replaced with this day's starting annotations. You can undo afterwards."
                    confirmLabel="Restore"
                    danger
                    busy={busy}
                    onConfirm={() => void restoreDay(confirmRestoreId)}
                    onCancel={() => setConfirmRestoreId(null)}
                />
            ) : null}
        </Dialog>
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
