import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { CloseIcon } from '@/ui/icons';

const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open dialogs, oldest first — Escape and the focus trap act on the top one only. */
const dialogStack: symbol[] = [];

export interface DialogProps {
    /** Accessible name; also the visible title when withHeader is set. */
    label: string;
    onClose: () => void;
    children: ReactNode;
    /** Renders a title row with a close button. */
    withHeader?: boolean;
    /** Bottom sheet on phones, centered on sm+. */
    sheet?: boolean;
}

/**
 * The app modal: unified scrim, aria-modal semantics, Escape-to-close, focus
 * trap with restore. The scrim root carries data-ui-overlay so the viewer's
 * gesture layer ignores pointer events that land on dialog chrome.
 */
export const Dialog = ({ label, onClose, children, withHeader = true, sheet = false }: DialogProps) => {
    const panelRef = useRef<HTMLDivElement | null>(null);
    const onCloseRef = useRef(onClose);
    const idRef = useRef<symbol | null>(null);
    if (idRef.current === null) {
        idRef.current = Symbol('dialog');
    }

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        const id = idRef.current as symbol;
        dialogStack.push(id);
        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        panelRef.current?.focus();

        const onKeyDown = (event: KeyboardEvent) => {
            if (dialogStack[dialogStack.length - 1] !== id) {
                return;
            }
            if (event.key === 'Escape') {
                event.stopPropagation();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab') {
                return;
            }
            const panel = panelRef.current;
            if (!panel) {
                return;
            }
            const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (!first || !last) {
                event.preventDefault();
                panel.focus();
                return;
            }
            const active = document.activeElement;
            if (event.shiftKey) {
                if (active === first || !panel.contains(active)) {
                    event.preventDefault();
                    last.focus();
                }
            } else if (active === last || !panel.contains(active)) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            const index = dialogStack.indexOf(id);
            if (index !== -1) {
                dialogStack.splice(index, 1);
            }
            previouslyFocused?.focus();
        };
    }, []);

    return (
        <div
            data-ui-overlay
            className={`fixed inset-0 z-40 flex justify-center bg-scrim p-4 ${sheet ? 'items-end sm:items-center' : 'items-center'}`}
            onClick={onClose}
        >
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-label={label}
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
                className={`w-full max-w-md rounded-2xl border border-stone-200 bg-white p-5 shadow-xl outline-none ${
                    sheet ? 'max-h-[80vh] overflow-auto' : ''
                }`}
            >
                {withHeader ? (
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <h2 className="text-lg font-semibold text-stone-800">{label}</h2>
                        <button
                            type="button"
                            aria-label="Close"
                            onClick={onClose}
                            className="rounded-lg p-1.5 text-stone-500 transition hover:bg-stone-100"
                        >
                            <CloseIcon size={18} />
                        </button>
                    </div>
                ) : null}
                {children}
            </div>
        </div>
    );
};
