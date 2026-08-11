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

/** Action popover shown after a region is selected with the fingering tool. */
export const FingeringSelectionPopover = ({
    anchorX,
    anchorY,
    busy = false,
    error = null,
    onReadNotes,
    onEnterNotes,
    onCancel,
}: FingeringSelectionPopoverProps) => {
    return (
        <div
            data-ui-overlay
            className="absolute z-30 flex max-w-[calc(100vw-1rem)] flex-col gap-1 rounded-xl border border-stone-200 bg-white/95 p-1.5 shadow-lg backdrop-blur"
            style={{ left: anchorX, top: anchorY + 8, transform: 'translateX(-50%)' }}
            role="menu"
            aria-label="Fingering actions"
            onPointerDown={(e) => e.stopPropagation()}
        >
            {error ? <p className="max-w-64 px-1 text-xs text-amber-800">{error}</p> : null}
            {busy ? (
                <p className="px-2 py-1 text-sm text-stone-600" role="status">
                    Reading the passage…
                </p>
            ) : (
                <div className="flex items-center gap-1">
                    {onReadNotes ? (
                        <button type="button" onClick={onReadNotes} className={buttonClassName('primary', 'sm')}>
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
        </div>
    );
};
