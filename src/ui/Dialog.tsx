import { lazy, Suspense, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { dialogStack } from '@/ui/dialogStack';
import { dialogPanelModule as dialogPanel } from '@/ui/lazyPrimitives';

export interface DialogProps {
    /** Accessible name; also the visible title when withHeader is set. */
    label: string;
    onClose: () => void;
    children: ReactNode;
    /** Renders a title row with a close button. */
    withHeader?: boolean;
    /** Bottom sheet on phones, centered on sm+. */
    sheet?: boolean;
    /**
     * An alertdialog: a decision the user has to make (ConfirmDialog). A press
     * on the scrim does not dismiss it; Escape and Cancel do.
     */
    alert?: boolean;
}

const LazyDialogPanel = lazy(() => dialogPanel.load().then((module) => ({ default: module.DialogPanel })));

/**
 * The app modal (ui/DialogPanel has the details): portalled to <body>, focus
 * trapped and returned to where it was, Escape to close, page scroll locked
 * and the rest of the page inert while it is open. Open while mounted —
 * callers render it conditionally, as before.
 *
 * The panel is a lazy chunk, usually prefetched on idle or on the first
 * hover or focus (ui/lazyPrimitives). This wrapper is what callers mount, and it takes its place
 * on dialogStack in the same commit, before the panel has loaded: a key that
 * arrives while the chunk is still on its way already finds isDialogOpen()
 * true, so the viewer's shortcuts stand down from the very first open. Until
 * the panel is in, nothing renders (no flash of a fallback); once the chunk
 * has loaded, later dialogs render the panel at once.
 */
export const Dialog = (props: DialogProps) => {
    const [stackId] = useState(() => Symbol('dialog'));
    // Picked once per dialog: switching from the lazy component to the loaded
    // one later would remount the panel and throw its focus away.
    const [Panel] = useState(() => dialogPanel.get()?.DialogPanel ?? LazyDialogPanel);

    // A layout effect: registered with the commit itself, not after paint.
    useLayoutEffect(() => {
        dialogStack.push(stackId);
        return () => {
            const index = dialogStack.indexOf(stackId);
            if (index !== -1) {
                dialogStack.splice(index, 1);
            }
        };
    }, [stackId]);

    return (
        <Suspense fallback={null}>
            <Panel {...props} stackId={stackId} />
        </Suspense>
    );
};
