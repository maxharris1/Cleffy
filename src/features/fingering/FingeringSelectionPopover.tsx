import { buttonClassName } from '@/ui/classNames';

export interface FingeringSelectionPopoverProps {
    /** Anchor: viewport CSS coords of the selection rect's bottom-center. */
    anchorX: number;
    anchorY: number;
    /** Present when Claude-vision recognition is available (cloud + online). */
    onReadNotes: (() => void) | null;
    onEnterNotes: () => void;
    onCancel: () => void;
}

/** Action popover shown after a region is selected with the fingering tool. */
export const FingeringSelectionPopover = ({
    anchorX,
    anchorY,
    onReadNotes,
    onEnterNotes,
    onCancel,
}: FingeringSelectionPopoverProps) => {
    return (
        <div
            data-ui-overlay
            className="absolute z-30 flex items-center gap-1 rounded-xl border border-stone-200 bg-white/95 p-1 shadow-lg backdrop-blur"
            style={{ left: anchorX, top: anchorY + 8, transform: 'translateX(-50%)' }}
            role="menu"
            aria-label="Fingering actions"
            onPointerDown={(e) => e.stopPropagation()}
        >
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
    );
};
