import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router';

import { preloadDemo } from '@/features/demo/demoPreload';
import { utmSearch } from '@/features/marketing/utmSearch';
import { track } from '@/lib/webEvents';

const warmDemo = () => {
    void preloadDemo();
};

/**
 * A link into the /try demo, carrying the page's utm_ tags. Reaching for it
 * (a pointer entering, keyboard focus, a touch) starts fetching the demo's
 * route, viewer and score, so it opens without a loading screen; nothing is
 * fetched before that.
 */
export const TryLink = ({
    className,
    children,
    'aria-label': ariaLabel,
}: {
    className: string;
    children: ReactNode;
    'aria-label'?: string;
}) => {
    const { search } = useLocation();
    return (
        <Link
            to={`/try${utmSearch(search)}`}
            aria-label={ariaLabel}
            className={className}
            onPointerEnter={warmDemo}
            onFocus={warmDemo}
            onTouchStart={warmDemo}
        >
            {children}
        </Link>
    );
};

/**
 * A Start free link: on to sign-up with this page's utm_ tags, counted as a
 * first-party signup_click (lib/webEvents).
 */
export const StartFreeLink = ({ className }: { className: string }) => {
    const { search } = useLocation();
    return (
        <Link to={`/register${utmSearch(search)}`} onClick={() => track('signup_click')} className={className}>
            Start free
        </Link>
    );
};
