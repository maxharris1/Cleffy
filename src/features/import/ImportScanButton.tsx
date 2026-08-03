import { useState } from 'react';

import { ImportReviewPanel } from '@/features/import/ImportReviewPanel';
import type { ClassifyFn, CleanFn } from '@/features/import/importTypes';
import type { AnnotationStore } from '@/sync/annotationStore';
import { buttonClassName } from '@/ui/classNames';

interface ImportScanButtonProps {
    store: AnnotationStore;
    docId: string;
    bytes: ArrayBuffer;
    classify: ClassifyFn | null;
    includeBornDigital: boolean;
    clean: CleanFn | null;
    /** Open the panel immediately (post-upload `?import=1` flow). */
    autoOpen?: boolean;
}

/** Viewer-header entry point for adopting a score's pre-existing annotations. */
export const ImportScanButton = ({
    store,
    docId,
    bytes,
    classify,
    includeBornDigital,
    clean,
    autoOpen = false,
}: ImportScanButtonProps) => {
    const [open, setOpen] = useState(autoOpen);

    return (
        <>
            <button
                type="button"
                title="Detect handwritten marks already on the pages and make them editable"
                onClick={() => setOpen(true)}
                className={buttonClassName('ghost', 'sm')}
            >
                Import marks
            </button>
            {open ? (
                <ImportReviewPanel
                    store={store}
                    docId={docId}
                    bytes={bytes}
                    classify={classify}
                    includeBornDigital={includeBornDigital}
                    clean={clean}
                    onClose={() => setOpen(false)}
                />
            ) : null}
        </>
    );
};
