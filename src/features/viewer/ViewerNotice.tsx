import type { ReactNode } from 'react';

/**
 * The look every viewer notice shares: an amber card floating over the top of
 * the score. Notices used to be full-width strips stacked above the viewport,
 * so each one that came or went pushed the whole score down or pulled it back
 * up under the reader's eyes. Over the score nothing moves, and nothing
 * animates its height either: a notice is simply there.
 */
const CARD =
    'pointer-events-auto mx-auto w-full max-w-2xl rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 shadow-lg';

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
 * notice.
 */
export const ViewerNoticeRegion = ({ children }: { children: ReactNode }) => (
    <div
        data-ui-overlay
        className="pointer-events-none absolute inset-x-0 top-14 z-30 flex flex-col gap-2 pl-[max(0.5rem,var(--safe-left))] pr-[max(0.5rem,var(--safe-right))] sm:top-[4.5rem]"
    >
        {children}
    </div>
);
