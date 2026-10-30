import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
 * Rendered after the panel, inside its Suspense boundary: commits when the
 * panel does, never before, and its effect runs after the panel's own (Base
 * UI's Escape listener among them).
 */
const OnPanelCommit = ({ onCommit }: { onCommit: () => void }) => {
    useEffect(onCommit, [onCommit]);
    return null;
};

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
 *
 * Escape closes a dialog whose panel is still loading, as it closes the panel
 * (an alertdialog too, which ignores only the scrim), and only the top dialog
 * on the stack. The panel never shows up afterwards for a dialog its
 * caller has taken down.
 */
export const Dialog = (props: DialogProps) => {
    const [stackId] = useState(() => Symbol('dialog'));
    // Picked once per dialog: switching from the lazy component to the loaded
    // one later would remount the panel and throw its focus away.
    const [Panel] = useState(() => dialogPanel.get()?.DialogPanel ?? LazyDialogPanel);
    const pending = Panel === LazyDialogPanel;
    /** The panel has committed; Base UI handles Escape from then on. */
    const panelIn = useRef(!pending);
    const markPanelIn = useCallback(() => {
        panelIn.current = true;
    }, []);
    const onCloseRef = useRef(props.onClose);
    useEffect(() => {
        onCloseRef.current = props.onClose;
    }, [props.onClose]);

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

    useLayoutEffect(() => {
        if (!pending) {
            return undefined;
        }
        // As Base UI's own Escape handling: not mid-composition, and the key stops here.
        const onKeyDown = (event: KeyboardEvent) => {
            if (
                event.key !== 'Escape' ||
                event.isComposing ||
                panelIn.current ||
                dialogStack[dialogStack.length - 1] !== stackId
            ) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            onCloseRef.current();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [pending, stackId]);

    return (
        <Suspense fallback={null}>
            <Panel {...props} stackId={stackId} />
            {pending ? <OnPanelCommit onCommit={markPanelIn} /> : null}
        </Suspense>
    );
};
