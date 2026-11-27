import type { ReactNode } from 'react';

/** The README's page max widths (1360, 1180 and 880 px) less the 40 px gutters. */
const HEAD_WIDTH = {
    wide: 'max-w-[1280px]',
    narrow: 'max-w-[1100px]',
    home: 'max-w-[800px]',
} as const;

const TITLE_SIZE: Record<keyof typeof HEAD_WIDTH, string> = {
    wide: 'text-[44px] sm:text-[60px]',
    narrow: 'text-[44px] sm:text-[60px]',
    home: 'text-[46px] sm:text-[64px]',
};

export interface PageHeadProps {
    width: keyof typeof HEAD_WIDTH;
    eyebrow?: ReactNode;
    title: ReactNode;
    subtitle?: ReactNode;
    action?: ReactNode;
}

export const PageHead = ({ width, eyebrow, title, subtitle, action }: PageHeadProps) => (
    // The shell's content wrapper already pads 32/40px; the extra top padding
    // lands the head 48px under the bar from sm up without moving other routes.
    <header className={`page-head ${HEAD_WIDTH[width]} mb-8 border-b border-hairline pb-6 sm:pt-4 sm:pb-8 lg:pt-2`}>
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-[18px]">
            <div className="max-w-[760px] min-w-0 [overflow-wrap:anywhere]">
                {eyebrow ? (
                    <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                        {eyebrow}
                    </p>
                ) : null}
                <h1
                    className={`display-opsz text-balance font-display ${TITLE_SIZE[width]} font-semibold leading-[1.02] tracking-[-0.02em] text-ink`}
                >
                    {title}
                </h1>
                {subtitle ? (
                    <div className="mt-2.5 text-pretty text-[15px] leading-normal text-ink-muted sm:mt-3.5 sm:text-[17px]">
                        {subtitle}
                    </div>
                ) : null}
            </div>
            {action}
        </div>
    </header>
);
