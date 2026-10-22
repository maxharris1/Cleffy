import { useCallback, useState, useSyncExternalStore } from 'react';

import type { AnnotationStore } from '@/sync/annotationStore';
import { subscribeInkRecovery } from '@/sync/inkRecovery';
import { Button } from '@/ui/Button';

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

/** What the strip says: short on phones, so it stays about two lines with its buttons beside it. */
const copy = (held: boolean, retryFailed: boolean): { short: string; long: string } => {
    if (held) {
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
 * snapshot so the edit can be made again.
 *
 * Same amber strip as the viewer's other notices — the app has no toasts —
 * kept to one row on phones: short copy beside its buttons.
 */
export const InkSaveFailedNotice = ({ store, onExport }: InkSaveFailedNoticeProps) => {
    const count = useRecoveryCount(store, (s) => s.persistFailureCount);
    const refused = useRecoveryCount(store, (s) => s.refusedEditCount);
    const [retrying, setRetrying] = useState(false);
    const [retryFailed, setRetryFailed] = useState(false);

    if (!store || (count <= 0 && refused <= 0)) {
        return null;
    }

    const retry = async () => {
        setRetrying(true);
        const saved = await store.retryFailedPersist();
        setRetrying(false);
        setRetryFailed(!saved);
    };

    const { short, long } = copy(count > 0, retryFailed);

    return (
        <div
            className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 sm:flex-wrap sm:py-2"
            role="status"
        >
            <p className="min-w-0 flex-1 text-sm leading-snug text-amber-900">
                <span className="sm:hidden">{short}</span>
                <span className="hidden sm:inline">{long}</span>
            </p>
            <Button size="sm" variant="secondary" className="shrink-0" disabled={retrying} onClick={() => void retry()}>
                {retrying ? 'Retrying…' : 'Retry'}
            </Button>
            {count > 0 && onExport ? (
                <Button size="sm" variant="ghost" className="shrink-0" onClick={onExport}>
                    Export
                </Button>
            ) : null}
        </div>
    );
};
