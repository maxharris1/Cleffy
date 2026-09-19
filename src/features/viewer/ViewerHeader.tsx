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

/**
 * Slim score-viewer top bar, shared by cloud and local viewers; safe-area aware.
 *
 * The action cluster wraps, and below md it takes its own row, so Invite / Share
 * / Notes stay on-screen on a phone. A single nowrap row clipped those controls
 * off the right edge of the `fixed inset-0` viewer.
 */
export const ViewerHeader = ({ backTo, backLabel, title, children }: ViewerHeaderProps) => (
    <header className="border-b border-stone-200 bg-white pb-2 pl-[max(0.75rem,var(--safe-left))] pr-[max(0.75rem,var(--safe-right))] pt-[max(0.5rem,var(--safe-top))] shadow-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex min-w-0 flex-1 items-center gap-3">
                <Link
                    to={backTo}
                    aria-label={backLabel}
                    title={backLabel}
                    className="shrink-0 rounded-lg p-1.5 text-stone-600 transition hover:bg-ink/5"
                >
                    <ArrowLeftIcon size={18} />
                </Link>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-700">{title}</span>
            </div>
            {children ? (
                <nav
                    aria-label="Score"
                    className="flex min-w-0 flex-[1_1_100%] flex-wrap items-center justify-end gap-x-0.5 gap-y-1 md:flex-[0_1_auto] [&>*]:shrink-0"
                >
                    {children}
                </nav>
            ) : null}
        </div>
    </header>
);
