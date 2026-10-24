import { useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * The look every viewer notice shares: an amber card floating over the top of
 * the score. Notices used to be full-width strips stacked above the viewport,
 * so each one that came or went pushed the whole score down or pulled it back
 * up under the reader's eyes. Over the score nothing moves, and nothing
 * animates its height either: a notice is simply there. Compact on phones
 * (less padding, tighter lines), where every line it takes is score hidden.
 */
const CARD =
    'pointer-events-auto mx-auto w-full max-w-2xl rounded-xl border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-sm leading-snug text-amber-900 shadow-lg sm:px-3 sm:py-2 sm:leading-normal';

export const ViewerNotice = ({
    children,
    className = '',
    role = 'status',
    bare = false,
    overlay = false,
}: {
    children: ReactNode;
    className?: string;
    /** Null when the content carries its own live region (a form with a status line). */
    role?: 'status' | 'alert' | null;
    /** No row layout: the caller lays out its own content. */
    bare?: boolean;
    /** data-ui-overlay, for a notice the viewer's gesture layer must ignore. */
    overlay?: boolean;
}) => (
    <div
        role={role ?? undefined}
        data-ui-overlay={overlay ? '' : undefined}
        className={`${CARD}${bare ? '' : ' flex flex-wrap items-center gap-2'}${className ? ` ${className}` : ''}`}
    >
        {children}
    </div>
);

/**
 * The one region the notices live in: absolute over the score's top edge,
 * below the phone's pager/zoom strip and below the toolbar docked at the top
 * from `sm`, inset from the notch. Lets presses through wherever there is no
 * notice. Tighter on phones, where a stack of them would otherwise cover a
 * good part of the score.
 *
 * onInsetChange hears how far down the stack reaches (px from the top of the
 * region's container, 0 with no notice up), so the viewer can keep followed
 * systems and page turns clear of it — some notices cannot be dismissed.
 */
export const ViewerNoticeRegion = ({
    children,
    onInsetChange,
}: {
    children: ReactNode;
    onInsetChange?: (inset: number) => void;
}) => {
    const regionRef = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
        const region = regionRef.current;
        const container = region?.parentElement;
        if (!region || !container || !onInsetChange) {
            return;
        }
        const measure = () => {
            const box = region.getBoundingClientRect();
            onInsetChange(
                box.height > 0 ? Math.max(0, Math.round(box.bottom - container.getBoundingClientRect().top)) : 0,
            );
        };
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        // The container too: its top edge moves at `sm`, where the region does.
        observer?.observe(region);
        observer?.observe(container);
        measure();
        return () => {
            observer?.disconnect();
            onInsetChange(0);
        };
    }, [onInsetChange]);
    return (
        <div
            ref={regionRef}
            data-ui-overlay
            data-viewer-notices
            className="pointer-events-none absolute inset-x-0 top-14 z-30 flex flex-col gap-1.5 pl-[max(0.5rem,var(--safe-left))] pr-[max(0.5rem,var(--safe-right))] sm:top-[4.5rem] sm:gap-2"
        >
            {children}
        </div>
    );
};
