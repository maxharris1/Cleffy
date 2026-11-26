import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { ArrowLeftIcon } from '@/ui/icons';
import { OnInkContext } from '@/ui/onInk';

interface ViewerHeaderProps {
    backTo: string;
    backLabel: string;
    title: string;
    /** Right-side chrome: presence, sync status, badges, actions. */
    children?: ReactNode;
    primary?: ReactNode;
}

const TITLE_SEPARATOR = ' — ';

const ScoreTitle = ({ title }: { title: string }) => {
    const at = title.indexOf(TITLE_SEPARATOR);
    if (at <= 0 || at + TITLE_SEPARATOR.length >= title.length) {
        return title;
    }
    return (
        <>
            {title.slice(0, at + TITLE_SEPARATOR.length)}
            <em>{title.slice(at + TITLE_SEPARATOR.length)}</em>
        </>
    );
};

/**
 * The score viewer's ink strip, shared by cloud and local viewers; safe-area aware.
 *
 * The action cluster wraps, and below lg it takes its own row, so Share / Export
 * / Notes stay on-screen on a phone or a ~768px tablet. A single nowrap row at
 * md clipped the title to unreadable crumbs beside the actions.
 */
export const ViewerHeader = ({ backTo, backLabel, title, children, primary }: ViewerHeaderProps) => {
    const [titleOpen, setTitleOpen] = useState(false);
    return (
        <header className="bg-ink pb-1.5 pl-[max(0.5rem,var(--safe-left))] pr-[max(0.5rem,var(--safe-right))] pt-[max(0.25rem,var(--safe-top))] text-paper sm:pl-[max(1rem,var(--safe-left))] sm:pr-[max(1rem,var(--safe-right))] sm:pt-[max(0.375rem,var(--safe-top))] [&_:focus-visible]:outline-ink-rule">
            <OnInkContext.Provider value>
                <div className="flex min-h-[3.25rem] flex-wrap items-center gap-x-4 gap-y-0.5">
                    <div className="flex min-w-[12rem] flex-1 items-center gap-0.5 sm:gap-1.5">
                        <Link
                            to={backTo}
                            aria-label={backLabel}
                            title={backLabel}
                            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] text-on-ink-muted transition-colors hover:bg-paper/10"
                        >
                            <ArrowLeftIcon size={20} />
                        </Link>
                        {/* Truncated to one line; a tap (or click) shows the whole title, which
                        a phone otherwise had no way to read — there is no hover there. */}
                        <button
                            type="button"
                            aria-expanded={titleOpen}
                            title={titleOpen ? undefined : title}
                            onClick={() => setTitleOpen((open) => !open)}
                            className={`min-w-0 flex-1 cursor-default text-left font-display text-[19px] font-semibold leading-tight tracking-[-0.01em] text-paper [font-variation-settings:'opsz'_10] pointer-coarse:hit-44-y sm:text-[22px] ${
                                titleOpen ? '[overflow-wrap:anywhere]' : 'truncate'
                            }`}
                        >
                            <ScoreTitle title={title} />
                        </button>
                    </div>
                    {children ? (
                        <nav
                            aria-label="Score"
                            className="order-2 flex min-w-0 flex-[1_1_100%] flex-wrap items-center justify-start gap-x-1.5 gap-y-0.5 lg:order-none lg:flex-[0_1_auto] lg:justify-end [&>*]:max-w-full [&>button]:px-3"
                        >
                            {children}
                        </nav>
                    ) : null}
                    {primary ? <div className="order-1 shrink-0 lg:order-none">{primary}</div> : null}
                </div>
            </OnInkContext.Provider>
        </header>
    );
};
