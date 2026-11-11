import { Popover } from '@base-ui/react/popover';
import { useState, type KeyboardEvent } from 'react';

import { buttonClassName } from '@/ui/classNames';

export interface FingeringSelectionPopoverProps {
    /** Anchor: viewport CSS coords of the selection rect's bottom-center. */
    anchorX: number;
    anchorY: number;
    /** Recognition in flight — show progress instead of actions. */
    busy?: boolean;
    error?: string | null;
    /** Present when Claude-vision recognition is available (cloud docs). */
    onReadNotes: (() => void) | null;
    onEnterNotes: () => void;
    onCancel: () => void;
}

/** Left/Right (and Home/End) move between the action buttons. */
const onToolbarKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        return;
    }
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled)'));
    if (buttons.length === 0) {
        return;
    }
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLElement);
    const next =
        event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
};

/**
 * Action popover shown after a region is selected with the fingering tool. A
 * Base UI popover anchored to a zero-size point under the selection: it flips
 * and shifts to stay on screen, grows from that point (--transform-origin),
 * and Escape cancels. A press elsewhere on the score does not — the selection
 * is still being looked at.
 */
export const FingeringSelectionPopover = ({
    anchorX,
    anchorY,
    busy = false,
    error = null,
    onReadNotes,
    onEnterNotes,
    onCancel,
}: FingeringSelectionPopoverProps) => {
    const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
    return (
        <>
            <span
                ref={setAnchor}
                aria-hidden="true"
                className="pointer-events-none absolute size-0"
                style={{ left: anchorX, top: anchorY }}
            />
            <Popover.Root
                open
                onOpenChange={(open, details) => {
                    if (open) {
                        return;
                    }
                    if (details.reason === 'outside-press' || details.reason === 'focus-out') {
                        details.cancel();
                        return;
                    }
                    onCancel();
                }}
            >
                <Popover.Portal>
                    <Popover.Positioner
                        anchor={anchor}
                        side="bottom"
                        align="center"
                        sideOffset={8}
                        collisionPadding={8}
                        className="z-30"
                    >
                        <Popover.Popup
                            data-ui-overlay
                            aria-label="Fingering actions"
                            initialFocus={false}
                            className="chrome-glass ui-menu-pop flex max-w-[calc(100vw-1rem)] flex-col gap-1 rounded-xl border border-stone-200 bg-white/95 p-1.5 shadow-lg outline-none"
                        >
                            {error ? <p className="max-w-64 px-1 text-xs text-amber-800">{error}</p> : null}
                            {busy ? (
                                <p className="px-2 py-1 text-sm text-stone-600" role="status">
                                    Reading the passage…
                                </p>
                            ) : (
                                <div
                                    role="toolbar"
                                    aria-label="Fingering actions"
                                    onKeyDown={onToolbarKeyDown}
                                    className="flex items-center gap-1"
                                >
                                    {onReadNotes ? (
                                        <button
                                            type="button"
                                            onClick={onReadNotes}
                                            className={buttonClassName('primary', 'sm')}
                                        >
                                            Read notes
                                        </button>
                                    ) : null}
                                    <button
                                        type="button"
                                        onClick={onEnterNotes}
                                        className={buttonClassName(onReadNotes ? 'ghost' : 'primary', 'sm')}
                                    >
                                        Enter notes
                                    </button>
                                    <button type="button" onClick={onCancel} className={buttonClassName('ghost', 'sm')}>
                                        Cancel
                                    </button>
                                </div>
                            )}
                        </Popover.Popup>
                    </Popover.Positioner>
                </Popover.Portal>
            </Popover.Root>
        </>
    );
};
