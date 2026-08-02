import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { ArrowLeftIcon } from '@/ui/icons';

interface ViewerHeaderProps {
    backTo: string;
    backLabel: string;
    title: string;
    /** Right-side chrome: presence, sync status, badges, actions. */
    children?: ReactNode;
}

/** Slim score-viewer top bar, shared by cloud and local viewers; safe-area aware. */
export const ViewerHeader = ({ backTo, backLabel, title, children }: ViewerHeaderProps) => (
    <header className="flex items-center gap-3 border-b border-stone-200 bg-white pb-2 pl-[max(0.75rem,var(--safe-left))] pr-[max(0.75rem,var(--safe-right))] pt-[max(0.5rem,var(--safe-top))] shadow-sm">
        <Link
            to={backTo}
            aria-label={backLabel}
            title={backLabel}
            className="rounded-lg p-1.5 text-stone-600 transition hover:bg-ink/5"
        >
            <ArrowLeftIcon size={18} />
        </Link>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-700">{title}</span>
        {children}
    </header>
);
