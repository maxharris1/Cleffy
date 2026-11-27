import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { Wordmark } from '@/ui/Wordmark';

/** The wordmark home, a navigation slot beside it, and a hairline under both. */
export const DocumentHeader = ({ children }: { children: ReactNode }) => (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-hairline pb-5">
        <Link
            to="/"
            className="inline-flex text-[26px] leading-none pointer-coarse:-my-[9px] pointer-coarse:py-[9px] sm:text-[30px]"
        >
            <Wordmark />
        </Link>
        {children}
    </header>
);
