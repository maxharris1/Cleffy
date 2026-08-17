import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link } from 'react-router';

import { buttonClassName } from '@/ui/classNames';
import { ArrowLeftIcon } from '@/ui/icons';

interface ViewerHeaderProps {
    backTo: string;
    backLabel: string;
    title: string;
    /** Always-visible chrome: presence, sync status, badges. */
    children?: ReactNode;
    /** Infrequent actions — inline on wide screens, overflow "More" when narrow. */
    overflow?: ReactNode;
}

const MD_QUERY = '(min-width: 768px)';

const subscribeMdUp = (onChange: () => void): (() => void) => {
    if (typeof window.matchMedia !== 'function') {
        return () => undefined;
    }
    const mq = window.matchMedia(MD_QUERY);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
};

const mdUpSnapshot = (): boolean =>
    typeof window.matchMedia === 'function' ? window.matchMedia(MD_QUERY).matches : true;

/** Slim score-viewer top bar, shared by cloud and local viewers; safe-area aware. */
export const ViewerHeader = ({ backTo, backLabel, title, children, overflow }: ViewerHeaderProps) => {
    const wide = useSyncExternalStore(subscribeMdUp, mdUpSnapshot, () => true);

    return (
        <header className="flex items-center gap-2 border-b border-stone-200 bg-white pb-2 pl-[max(0.75rem,var(--safe-left))] pr-[max(0.75rem,var(--safe-right))] pt-[max(0.5rem,var(--safe-top))] shadow-sm sm:gap-3">
            <Link
                to={backTo}
                aria-label={backLabel}
                title={backLabel}
                className="shrink-0 rounded-lg p-1.5 text-ink-muted transition hover:bg-ink/5 hover:text-ink"
            >
                <ArrowLeftIcon size={18} />
            </Link>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{title}</span>
            <div className="flex shrink-0 items-center gap-1.5">
                {children}
                {overflow ? (
                    wide ? (
                        <div className="flex items-center gap-1">{overflow}</div>
                    ) : (
                        <MoreMenu>{overflow}</MoreMenu>
                    )
                ) : null}
            </div>
        </header>
    );
};

const MoreMenu = ({ children }: { children: ReactNode }) => {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setOpen(false);
            }
        };
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <div ref={rootRef} className="relative">
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="More"
                onClick={() => setOpen((v) => !v)}
                className={buttonClassName('ghost', 'sm')}
            >
                More
            </button>
            {open ? (
                <div
                    role="menu"
                    className="absolute right-0 z-30 mt-1 flex min-w-[12rem] flex-col rounded-xl border border-stone-200 bg-white py-1 shadow-lg"
                >
                    {children}
                </div>
            ) : null}
        </div>
    );
};
