import { useState, type ReactNode } from 'react';

import { PdfViewport } from '@/features/viewer/PdfViewport';
import { PdfProvider } from '@/features/viewer/pdf/PdfProvider';
import { ViewerNoticeRegion } from '@/features/viewer/ViewerNotice';
import type { AnnotationStore } from '@/sync/annotationStore';

interface LocalViewerFrameProps {
    docId: string;
    bytes: ArrayBuffer;
    /** The ViewerHeader, with this viewer's own chrome. */
    header: ReactNode;
    /** Notices floating over the top of the score (ViewerNoticeRegion). */
    notices?: ReactNode;
    /**
     * Floats over the score below any notices, but is not part of their
     * inset: the score is not fitted around it, so it can come and go without
     * the music moving (the demo's first-run hint).
     */
    overlay?: ReactNode;
    onStoreReady: (store: AnnotationStore) => void;
    /**
     * The viewport's key. A new one mounts a new viewport, and with it a new
     * AnnotationStore that hydrates from Dexie again (and an empty undo
     * history). Defaults to the doc id.
     */
    viewportKey?: string | number;
    /**
     * False holds the viewport back, `placeholder` in its place: the demo
     * wipes its stored ink first, since a store hydrating meanwhile would
     * paint the old marks and race the delete.
     */
    showViewport?: boolean;
    placeholder?: ReactNode;
}

/**
 * The body every on-device viewer shares (the local viewer, the /try demo):
 * header, the notice region over the score, and the PDF viewport with no
 * sync — its ink stays in IndexedDB on this device.
 */
export const LocalViewerFrame = ({
    docId,
    bytes,
    header,
    notices,
    overlay,
    onStoreReady,
    viewportKey = docId,
    showViewport = true,
    placeholder = null,
}: LocalViewerFrameProps) => {
    /** How far the notices over the score reach down it (ViewerNoticeRegion). */
    const [noticeInset, setNoticeInset] = useState(0);
    return (
        // Fixed, so the whole viewer is one stack: UI floating over it from
        // outside (the demo's value card, z-40) would cover a toolbar popup
        // whatever the toolbar's own z-index. While one is open (Toolbar marks
        // it data-toolbar-popup) the viewer is lifted over that UI.
        <div className="fixed inset-0 flex flex-col has-[[data-toolbar-popup]]:z-50">
            {header}
            <main className="flex min-h-0 flex-1 flex-col">
                <div className="relative min-h-0 flex-1">
                    <ViewerNoticeRegion onInsetChange={setNoticeInset}>{notices}</ViewerNoticeRegion>
                    {overlay ? (
                        <div
                            data-ui-overlay
                            // Where the notice region starts, or just below its notices.
                            style={noticeInset > 0 ? { top: noticeInset + 8 } : undefined}
                            className="pointer-events-none absolute inset-x-0 top-14 z-30 flex flex-col pl-[max(0.5rem,var(--safe-left))] pr-[max(0.5rem,var(--safe-right))] sm:top-[4.5rem]"
                        >
                            {overlay}
                        </div>
                    ) : null}
                    <PdfProvider data={bytes}>
                        {showViewport ? (
                            <PdfViewport
                                key={viewportKey}
                                docId={docId}
                                onStoreReady={onStoreReady}
                                noticeInset={noticeInset}
                            />
                        ) : (
                            placeholder
                        )}
                    </PdfProvider>
                </div>
            </main>
        </div>
    );
};
