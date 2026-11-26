import type { ReactNode } from 'react';

export interface PageHeadProps {
    eyebrow?: ReactNode;
    title: ReactNode;
    subtitle?: ReactNode;
    action?: ReactNode;
}

export const PageHead = ({ eyebrow, title, subtitle, action }: PageHeadProps) => (
    // The shell's content wrapper already pads 32/40px; the extra top padding
    // lands the head 48px under the bar from sm up without moving other routes.
    <header className="border-b border-hairline pb-6 sm:pt-4 sm:pb-8 lg:pt-2">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-[18px]">
            <div className="min-w-0 max-w-[760px]">
                {eyebrow ? (
                    <p className="mb-3 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-muted">
                        {eyebrow}
                    </p>
                ) : null}
                <h1 className="display-opsz text-balance font-display text-[44px] font-semibold leading-[1.02] tracking-[-0.02em] text-ink sm:text-[60px]">
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
