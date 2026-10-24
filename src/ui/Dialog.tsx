import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactNode, RefObject } from 'react';

import { CloseButton } from '@/ui/CloseButton';
import { dialogStack } from '@/ui/dialogStack';

/** A sheet dragged down this far (px), or flicked faster than this (px/ms), closes. */
const SHEET_CLOSE_DISTANCE = 96;
const SHEET_CLOSE_VELOCITY = 0.5;

/**
 * Drag a phone sheet down by its grab bar to dismiss it. The sheet follows the
 * finger 1:1 (transform only, no layout), and on release either closes or
 * springs back on the drawer curve. Only the bar starts a drag, so the sheet's
 * own content still scrolls normally. Pointer capture keeps the drag alive
 * when the finger leaves the bar.
 */
const useSheetDrag = (popupRef: RefObject<HTMLDivElement | null>, onClose: () => void) => {
    const drag = useRef<{ id: number; y: number; t: number; dy: number } | null>(null);
    const setOffset = (dy: number, animate: boolean) => {
        const popup = popupRef.current;
        if (popup) {
            popup.style.transition = animate ? 'transform var(--duration-enter) var(--ease-drawer)' : 'none';
            popup.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
        }
    };
    return {
        onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
            if (event.button !== 0) {
                return;
            }
            event.currentTarget.setPointerCapture?.(event.pointerId);
            drag.current = { id: event.pointerId, y: event.clientY, t: event.timeStamp, dy: 0 };
        },
        onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
            const current = drag.current;
            if (!current || current.id !== event.pointerId) {
                return;
            }
            current.dy = Math.max(0, event.clientY - current.y);
            setOffset(current.dy, false);
        },
        onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
            const current = drag.current;
            drag.current = null;
            if (!current || current.id !== event.pointerId) {
                return;
            }
            const velocity = current.dy / Math.max(1, event.timeStamp - current.t);
            if (current.dy > SHEET_CLOSE_DISTANCE || (current.dy > 24 && velocity > SHEET_CLOSE_VELOCITY)) {
                onClose();
            } else {
                setOffset(0, true);
            }
        },
        onPointerCancel: () => {
            drag.current = null;
            setOffset(0, true);
        },
    };
};

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

/**
 * The app modal, on Base UI's Dialog: portalled to <body>, focus trapped and
 * returned to where it was, Escape to close, page scroll locked and the rest
 * of the page inert while it is open. Open while mounted — callers render it
 * conditionally, as before.
 *
 * The scrim closes it only when a press both starts and ends on the scrim, so
 * selecting text in a field and letting go outside the panel does not throw
 * the dialog away. The viewport (the scrim's hit area) carries data-ui-overlay
 * so the viewer's gesture layer ignores pointer events that land on it.
 */
export const Dialog = ({ label, onClose, children, withHeader = true, sheet = false, alert = false }: DialogProps) => {
    const popupRef = useRef<HTMLDivElement | null>(null);
    const onCloseRef = useRef(onClose);
    const idRef = useRef<symbol | null>(null);
    const pressStartedOnScrim = useRef(false);
    if (idRef.current === null) {
        idRef.current = Symbol('dialog');
    }

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        const id = idRef.current as symbol;
        dialogStack.push(id);
        return () => {
            const index = dialogStack.indexOf(id);
            if (index !== -1) {
                dialogStack.splice(index, 1);
            }
        };
    }, []);

    const onOpenChange = (open: boolean, details: BaseDialog.Root.ChangeEventDetails) => {
        if (open) {
            return;
        }
        // Escape belongs to the top dialog: a confirm opened over another
        // dialog closes alone, even when the two are not nested in React.
        if (details.reason === 'escape-key' && dialogStack[dialogStack.length - 1] !== idRef.current) {
            details.cancel();
            return;
        }
        onCloseRef.current();
    };

    const onScrimPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        pressStartedOnScrim.current = event.target === event.currentTarget;
    };
    const onScrimClick = (event: ReactMouseEvent<HTMLDivElement>) => {
        const startedOnScrim = pressStartedOnScrim.current;
        pressStartedOnScrim.current = false;
        if (!alert && startedOnScrim && event.target === event.currentTarget) {
            onCloseRef.current();
        }
    };

    const Parts = alert ? AlertDialog : BaseDialog;
    const sheetDrag = useSheetDrag(popupRef, () => onCloseRef.current());

    return (
        // Pointer dismissal is ours (the scrim handlers); Base UI's would
        // close on a press that only ended outside the panel.
        <Parts.Root open onOpenChange={onOpenChange} disablePointerDismissal>
            <Parts.Portal>
                <Parts.Backdrop className="ui-scrim-fade fixed inset-0 z-40 bg-scrim" />
                <Parts.Viewport
                    data-ui-overlay
                    onPointerDown={onScrimPointerDown}
                    onClick={onScrimClick}
                    className={`fixed inset-0 z-40 flex justify-center p-4 ${sheet ? 'items-end sm:items-center' : 'items-center'}`}
                >
                    <Parts.Popup
                        ref={popupRef}
                        // Base UI marks the rest of the page inert; aria-modal says so
                        // to assistive tech that reads the attribute.
                        aria-modal="true"
                        aria-label={label}
                        initialFocus={popupRef}
                        className={`${sheet ? 'ui-sheet-pop' : 'ui-dialog-pop'} w-full max-w-md overscroll-contain rounded-2xl border border-stone-200 bg-white p-5 shadow-xl outline-none ${
                            sheet
                                ? 'max-h-[80dvh] overflow-y-auto overflow-x-hidden pb-[max(1.25rem,var(--safe-bottom))] pl-[max(1.25rem,var(--safe-left))] pr-[max(1.25rem,var(--safe-right))]'
                                : // Fits any viewport (the viewport's p-4 is the 2rem) and scrolls inside, so a
                                  // tall dialog on a short phone or landscape screen never pushes its title,
                                  // Close or actions off-screen — the page behind cannot scroll to reveal them.
                                  'max-h-[calc(100dvh-2rem)] overflow-y-auto'
                        }`}
                    >
                        {sheet ? (
                            // Phones only: the grab bar that drags the sheet away.
                            <div
                                {...sheetDrag}
                                aria-hidden="true"
                                data-sheet-grabber
                                className="relative z-20 -mx-5 -mt-3 flex h-4 cursor-grab touch-none items-start justify-center sm:hidden"
                            >
                                <span className="h-1 w-10 rounded-full bg-stone-300" />
                            </div>
                        ) : null}
                        {withHeader ? (
                            // Sticky, bleeding over the panel padding, so Close stays in reach while a
                            // long dialog scrolls and the content passes under an opaque header. The gap
                            // below stays a margin: some dialogs tuck a subtitle into it with -mt-2.
                            // -top-5: the sticky edge is the panel's content box, not its border.
                            <div
                                className={`sticky -top-5 z-10 -mt-5 mb-3 flex items-center justify-between gap-3 bg-white pt-5 ${
                                    sheet
                                        ? '-ml-[max(1.25rem,var(--safe-left))] -mr-[max(1.25rem,var(--safe-right))] pl-[max(1.25rem,var(--safe-left))] pr-[max(1.25rem,var(--safe-right))]'
                                        : '-mx-5 px-5'
                                }`}
                            >
                                <Parts.Title className="min-w-0 text-lg font-semibold text-stone-800 [overflow-wrap:anywhere]">
                                    {label}
                                </Parts.Title>
                                {/* 44px hit area on touch (CloseButton's hit-44), the icon where it sits on desktop. */}
                                <CloseButton onClick={() => onCloseRef.current()} />
                            </div>
                        ) : null}
                        {children}
                    </Parts.Popup>
                </Parts.Viewport>
            </Parts.Portal>
        </Parts.Root>
    );
};
