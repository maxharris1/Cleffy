import { useCallback, useState, useSyncExternalStore } from 'react';

import { ViewerNotice } from '@/features/viewer/ViewerNotice';
import type { AnnotationStore } from '@/sync/annotationStore';
import { subscribeInkRecovery } from '@/sync/inkRecovery';
import { Button } from '@/ui/Button';
import { Dialog } from '@/ui/Dialog';
import { CloseIcon } from '@/ui/icons';

interface InkSaveFailedNoticeProps {
    /** The viewer's store; null until the viewport has made it. */
    store: AnnotationStore | null;
    /** Opens the viewer's Export menu. Omitted where there is none yet. */
    onExport?: () => void;
}

/**
 * A count the store reads from inkRecovery: it changes with the store's own
 * edits (meta) and with anything else that writes or clears held ink — a
 * retry from an earlier mount, a sign-out.
 */
const useRecoveryCount = (store: AnnotationStore | null, read: (store: AnnotationStore) => number): number => {
    const subscribe = useCallback(
        (cb: () => void) => {
            if (!store) {
                return () => undefined;
            }
            const offMeta = store.subscribeMeta(cb);
            const offRecovery = subscribeInkRecovery(cb);
            return () => {
                offMeta();
                offRecovery();
            };
        },
        [store],
    );
    return useSyncExternalStore(subscribe, () => (store ? (read(store) ?? 0) : 0));
};

type NoticeState = 'overflow' | 'held' | 'refused' | 'conflicts';

/**
 * What the strip says: short on phones, so it stays about two lines with its
 * buttons beside it. `exportable` is whether there is something to export;
 * `canExport` whether this viewer has an Export to offer at all (the /try
 * demo has none), so the copy never sends anyone to a button that is not there.
 */
const copy = (
    state: NoticeState,
    retryFailed: boolean,
    exportable: boolean,
    canExport: boolean,
): { short: string; long: string } => {
    if (state === 'overflow') {
        // Export only when this score has unsaved marks of its own to keep.
        return exportable && canExport
            ? {
                  short: 'Too many unsaved marks: new ones weren’t made. Export a copy.',
                  long: 'This device can’t keep any more unsaved marks, so your latest changes weren’t made. Export a copy to keep the rest, then Retry.',
              }
            : {
                  short: 'Too many unsaved marks: new ones weren’t made.',
                  long: 'This device can’t keep any more unsaved marks, so your latest changes weren’t made. Free up storage, then Retry.',
              };
    }
    if (state === 'conflicts') {
        // An overtaken erase has no version of its own to draw: its Export
        // is of the score as it is now, and says the erase was overtaken.
        if (!canExport) {
            return {
                short: 'Some changes were overtaken elsewhere.',
                long: 'Some of your unsaved changes were overtaken by newer ones made elsewhere before this device could save them, so the newer versions are shown.',
            };
        }
        return exportable
            ? {
                  short: 'Some marks changed elsewhere first.',
                  long: 'Some of your unsaved marks were changed elsewhere before this device could save them, so the newer versions are shown. Export a copy to keep yours.',
              }
            : {
                  short: 'Some changes were overtaken elsewhere.',
                  long: 'Some of your unsaved changes were overtaken by newer ones made elsewhere before this device could save them, so the newer versions are shown. Export keeps a copy of the score as it is.',
              };
    }
    if (state === 'held') {
        if (retryFailed && !canExport) {
            return {
                short: 'Still not saved. Free up storage, then Retry.',
                long: 'Some marks couldn’t be saved on this device, and retrying didn’t work. Free up storage, then Retry.',
            };
        }
        return retryFailed
            ? {
                  short: 'Still not saved. Storage may be full: export a copy.',
                  long: 'Some marks couldn’t be saved on this device. Retrying didn’t work, so this device may be out of storage. Export a copy to keep them.',
              }
            : {
                  short: 'Some marks aren’t saved on this device.',
                  long: 'Some marks couldn’t be saved on this device.',
              };
    }
    return retryFailed
        ? {
              short: 'Still can’t save. Storage may be full.',
              long: 'A change couldn’t be saved on this device, so it wasn’t made. Retrying didn’t work, so this device may be out of storage.',
          }
        : {
              short: 'A change couldn’t be saved, so it wasn’t made.',
              long: 'A change couldn’t be saved on this device, so it wasn’t made. Retry, then make it again.',
          };
};

/**
 * Marks drawn on the score that could not be written to this device — the
 * browser's storage is full, or the database was closed under the page. They
 * are on screen but nowhere else: a reload loses them, and they cannot sync
 * until they are written. Leaving the score keeps them in this tab, and
 * opening it again brings the banner back (inkRecovery). Not dismissible,
 * since that is the standing state of the score until Retry writes them (the
 * banner then goes) or Export takes a copy that includes them.
 *
 * Also an edit of an existing mark refused because the day's starting point
 * could not be written first: nothing to export, but Retry writes that
 * snapshot so the edit can be made again. And edits not made at all because
 * this device already holds as many unsaved marks as it can (overflow):
 * undone on screen, with Export for the rest. And unsaved marks a newer
 * version overtook before they could be written (conflicts): the newer one
 * is drawn, Retry leaves them, and Export keeps them (an overtaken erase
 * too, its export saying so). Dismiss only hides the notice: they stay for
 * Export until the tab closes. Only Discard lets them go, and only once the
 * user has confirmed it in a dialog that offers Export first.
 *
 * Same amber strip as the viewer's other notices — the app has no toasts —
 * kept to one row on phones: short copy beside its buttons.
 */
export const InkSaveFailedNotice = ({ store, onExport }: InkSaveFailedNoticeProps) => {
    const count = useRecoveryCount(store, (s) => s.persistFailureCount);
    const refused = useRecoveryCount(store, (s) => s.refusedEditCount);
    const overflow = useRecoveryCount(store, (s) => s.overflowCount);
    const conflicts = useRecoveryCount(store, (s) => s.conflictCount);
    const exportableConflicts = useRecoveryCount(store, (s) => s.exportableConflictCount);
    const hidden = useRecoveryCount(store, (s) => (s.conflictNoticeHidden ? 1 : 0)) > 0;
    const [retrying, setRetrying] = useState(false);
    const [retryFailed, setRetryFailed] = useState(false);
    const [confirmingDiscard, setConfirmingDiscard] = useState(false);

    if (!store || (count <= 0 && refused <= 0 && overflow <= 0 && conflicts <= 0)) {
        return null;
    }
    const state: NoticeState = overflow > 0 ? 'overflow' : count > 0 ? 'held' : refused > 0 ? 'refused' : 'conflicts';
    if (state === 'conflicts' && hidden && !confirmingDiscard) {
        // Dismissed: hidden, not discarded. Export still has them.
        return null;
    }
    const exportable = count > 0 || conflicts > 0;

    const retry = async () => {
        setRetrying(true);
        const saved = await store.retryFailedPersist();
        setRetrying(false);
        setRetryFailed(!saved);
    };

    const { short, long } = copy(
        state,
        retryFailed,
        state === 'conflicts' ? exportableConflicts > 0 : exportable,
        onExport !== undefined,
    );

    return (
        <ViewerNotice bare className="flex items-center gap-2 sm:flex-wrap">
            <p className="min-w-0 flex-1 leading-snug">
                <span className="sm:hidden">{short}</span>
                <span className="hidden sm:inline">{long}</span>
            </p>
            {state !== 'conflicts' ? (
                <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    disabled={retrying}
                    onClick={() => void retry()}
                >
                    {retrying ? 'Retrying…' : 'Retry'}
                </Button>
            ) : null}
            {exportable && onExport ? (
                <Button size="sm" variant="ghost" className="shrink-0" onClick={onExport}>
                    Export
                </Button>
            ) : null}
            {state === 'conflicts' ? (
                <>
                    {/* An ×, so three actions fit beside the copy on a phone. */}
                    <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0 px-2"
                        aria-label="Dismiss"
                        title="Dismiss: hides this, and Export still has your versions"
                        onClick={() => store.hideConflictNotice()}
                    >
                        <CloseIcon size={16} className="shrink-0" />
                    </Button>
                    {/* Only where Export can be offered first. */}
                    {onExport ? (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="shrink-0"
                            onClick={() => setConfirmingDiscard(true)}
                        >
                            Discard
                        </Button>
                    ) : null}
                </>
            ) : null}
            {confirmingDiscard && onExport ? (
                <DiscardConflictsDialog
                    count={conflicts}
                    onExport={() => {
                        setConfirmingDiscard(false);
                        onExport();
                    }}
                    onDiscard={() => {
                        setConfirmingDiscard(false);
                        store.discardConflicts();
                    }}
                    onCancel={() => setConfirmingDiscard(false)}
                />
            ) : null}
        </ViewerNotice>
    );
};

/** Discard asks first, and offers Export before it: the held versions exist nowhere else. */
const DiscardConflictsDialog = ({
    count,
    onExport,
    onDiscard,
    onCancel,
}: {
    count: number;
    onExport: () => void;
    onDiscard: () => void;
    onCancel: () => void;
}) => (
    <Dialog label="Discard your unsaved versions?" onClose={onCancel}>
        <p className="text-sm leading-relaxed text-stone-600">
            {count === 1
                ? 'One of your unsaved changes was overtaken elsewhere, and is kept only in this tab.'
                : `${count} of your unsaved changes were overtaken elsewhere, and are kept only in this tab.`}{' '}
            Discarding deletes {count === 1 ? 'it' : 'them'} for good. Export a copy first to keep{' '}
            {count === 1 ? 'it' : 'them'}.
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel
            </Button>
            <Button variant="secondary" size="sm" onClick={onExport}>
                Export first
            </Button>
            <Button variant="danger" size="sm" onClick={onDiscard}>
                Discard
            </Button>
        </div>
    </Dialog>
);
