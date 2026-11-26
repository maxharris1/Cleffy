import { useEffect, useState } from 'react';

import { getSnapshot, listSnapshots, SNAPSHOT_PULL_LIMIT } from '@/features/viewer/history/snapshotService';
import type { LocalAnnotationSnapshot } from '@/features/viewer/history/snapshotTypes';
import type { AnnotationStore } from '@/sync/annotationStore';
import { Button } from '@/ui/Button';
import { ConfirmDialog } from '@/ui/ConfirmDialog';
import { Dialog } from '@/ui/Dialog';
import { ErrorText } from '@/ui/ErrorText';
import { LoadingText } from '@/ui/Loading';
import { toast } from '@/ui/toast';
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
    // Only true history viewing counts — an import-preview overlay is not ours.
    const viewing = store.overlayMode === 'history';

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
            // Fired with the close, so the dialog's exit and the toast's
            // entrance read as one hand-off.
            toast.success('Marks restored', {
                description: `To the starting point of ${formatDay(snap.capturedOn)}. Undo brings back what was there.`,
            });
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
            <p className="-mt-0.5 text-[15px] leading-normal text-pretty text-ink-muted">
                Starting point captured on first edit each day
            </p>

            {viewing ? (
                <div className="mt-4 rounded-[14px] border border-amber-200 bg-amber-50 px-4 py-3.5">
                    <p className="text-[15px] leading-normal text-due">Viewing a past starting point (read-only).</p>
                    <button type="button" onClick={exitView} className={buttonClassName('secondary', 'sm', 'mt-2.5')}>
                        Back to current
                    </button>
                </div>
            ) : null}

            <div className="mt-4">
                {error ? <ErrorText className="mb-2">{error}</ErrorText> : null}
                {rows === null ? (
                    <LoadingText className="text-sm">Loading…</LoadingText>
                ) : rows.length === 0 ? (
                    <p className="text-[15px] leading-normal text-ink-muted">
                        No daily starting points yet. The first mark you make each day freezes that morning&apos;s state
                        automatically.
                    </p>
                ) : (
                    <>
                        {rows.length >= SNAPSHOT_PULL_LIMIT ? (
                            <p className="mb-2 text-[13px] text-ink-muted">
                                Showing the latest {SNAPSHOT_PULL_LIMIT} starting points.
                            </p>
                        ) : null}
                        <ul className="border-b border-hairline">
                            {rows.map((row) => (
                                <li
                                    key={row.id}
                                    className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-hairline py-3"
                                >
                                    <div className="min-w-0 flex-[1_1_180px]">
                                        <p className="text-[15px] font-semibold text-ink">
                                            {formatDay(row.capturedOn)}
                                        </p>
                                        <p className="text-[13px] text-ink-muted tabular-nums">
                                            {row.payload.filter((a) => !a.deletedAt).length} marks
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => void viewDay(row.id)}
                                        className={buttonClassName('accentGhost', 'sm')}
                                    >
                                        View
                                    </button>
                                    {canRestore ? (
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            disabled={busy}
                                            onClick={() => setConfirmRestoreId(row.id)}
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
