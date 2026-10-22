import { useCallback, useState, useSyncExternalStore } from 'react';

import type { AnnotationStore } from '@/sync/annotationStore';
import { Button } from '@/ui/Button';

interface InkSaveFailedNoticeProps {
    /** The viewer's store; null until the viewport has made it. */
    store: AnnotationStore | null;
    /** Opens the viewer's Export menu. Omitted where there is none yet. */
    onExport?: () => void;
}

/** How many marks `store` holds that it could not write to this device (AnnotationStore.hasPersistFailure). */
const useUnsavedMarkCount = (store: AnnotationStore | null): number => {
    const subscribe = useCallback((cb: () => void) => (store ? store.subscribeMeta(cb) : () => undefined), [store]);
    return useSyncExternalStore(subscribe, () => store?.persistFailureCount ?? 0);
};

/**
 * Marks drawn on the score that could not be written to this device — the
 * browser's storage is full, or the database was closed under the page. They
 * are on screen but nowhere else: a reload, or leaving the score, loses them,
 * and they cannot sync until they are written. Not dismissible, since that is
 * the standing state of the score until Retry writes them (the banner then
 * goes) or Export takes a copy that includes them. Same amber strip as the
 * viewer's other notices — the app has no toasts.
 */
export const InkSaveFailedNotice = ({ store, onExport }: InkSaveFailedNoticeProps) => {
    const count = useUnsavedMarkCount(store);
    const [retrying, setRetrying] = useState(false);
    const [retryFailed, setRetryFailed] = useState(false);

    if (!store || count <= 0) {
        return null;
    }

    const retry = async () => {
        setRetrying(true);
        const saved = await store.retryFailedPersist();
        setRetrying(false);
        setRetryFailed(!saved);
    };

    return (
        <div
            className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2"
            role="status"
        >
            <p className="flex-1 text-sm text-amber-900">
                Some marks couldn’t be saved on this device.
                {retryFailed
                    ? ' Retrying didn’t work, so this device may be out of storage. Export a copy to keep them.'
                    : null}
            </p>
            <Button size="sm" variant="secondary" disabled={retrying} onClick={() => void retry()}>
                {retrying ? 'Retrying…' : 'Retry'}
            </Button>
            {onExport ? (
                <Button size="sm" variant="ghost" onClick={onExport}>
                    Export
                </Button>
            ) : null}
        </div>
    );
};
