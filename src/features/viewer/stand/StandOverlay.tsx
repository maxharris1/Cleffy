import { useViewerStore } from '@/state/store';
import { enterStandMode, exitStandMode } from '@/features/viewer/stand/standMode';
import { buttonClassName } from '@/ui/classNames';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, FullScreenIcon } from '@/ui/icons';

const roundButtonClassName =
    'flex h-11 w-11 items-center justify-center rounded-full text-stone-700 active:bg-stone-100 disabled:opacity-40 disabled:active:bg-transparent';

/**
 * Stand mode's controls, up for a few seconds after a tap in the middle of the
 * score (and on entering): previous, the page, next, and Exit. Fades in,
 * instantly under reduced motion; gone at once when it goes. With no pages
 * (the score still loading, or failed) only Exit.
 */
export const StandOverlay = ({
    page,
    pageCount,
    onTurn,
    onInteract,
}: {
    /** 0-based page on screen. */
    page: number;
    /** 0 while there is no score to page through. */
    pageCount: number;
    onTurn: (direction: -1 | 1) => void;
    /** A control was used: keep the overlay up a while longer. */
    onInteract: () => void;
}) => (
    <div
        data-ui-overlay
        data-stand-overlay
        className="pointer-events-none absolute inset-x-0 bottom-[calc(1rem+var(--safe-bottom))] z-30 flex justify-center px-2"
    >
        <div
            role="toolbar"
            aria-label="Full screen controls"
            className="chrome-glass pointer-events-auto flex items-center gap-1 rounded-full border border-stone-200 bg-white/95 p-1 shadow-lg motion-safe:animate-[ui-fade-in_var(--duration-dialog)_var(--ease-out)]"
        >
            {pageCount > 0 ? (
                <>
                    <button
                        type="button"
                        aria-label="Previous page"
                        disabled={page <= 0}
                        onClick={() => {
                            onInteract();
                            onTurn(-1);
                        }}
                        className={roundButtonClassName}
                    >
                        <ChevronLeftIcon size={22} />
                    </button>
                    <span aria-live="polite" className="px-2 text-sm font-medium tabular-nums text-stone-700">
                        Page {Math.min(page + 1, pageCount)} / {pageCount}
                    </span>
                    <button
                        type="button"
                        aria-label="Next page"
                        disabled={page >= pageCount - 1}
                        onClick={() => {
                            onInteract();
                            onTurn(1);
                        }}
                        className={roundButtonClassName}
                    >
                        <ChevronRightIcon size={22} />
                    </button>
                    <span aria-hidden="true" className="mx-1 h-6 w-px bg-stone-200" />
                </>
            ) : null}
            <button
                type="button"
                onClick={exitStandMode}
                className={buttonClassName('ghost', 'sm', 'h-11 rounded-full px-4')}
            >
                <CloseIcon size={16} />
                Exit
            </button>
        </div>
    </div>
);

/**
 * The header's one way in: the score alone, full screen, for the music stand.
 * Sits on the title's row, pulled in vertically so that row keeps its height
 * (ViewerHeader's titleAction). Pressed while stand mode is on (the header is
 * covered then, but a screen reader still reads it).
 */
export const StandModeButton = () => {
    const standMode = useViewerStore((s) => s.standMode);
    return (
        <button
            type="button"
            title="Full screen — just the score, for playing from the stand"
            aria-label="Full screen"
            aria-pressed={standMode}
            onClick={() => (standMode ? exitStandMode() : enterStandMode())}
            className={buttonClassName('ghost', 'sm', '-my-1 shrink-0 pointer-coarse:hit-44-y')}
        >
            <FullScreenIcon size={16} />
            <span className="hidden sm:inline">Full screen</span>
        </button>
    );
};
