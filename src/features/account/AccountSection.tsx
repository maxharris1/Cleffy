import type { ReactNode } from 'react';

export interface AccountSectionProps {
    title: ReactNode;
    children: ReactNode;
}

/** One ruled Account section: a 220 px label column beside a content column, stacking on narrow screens. */
export const AccountSection = ({ title, children }: AccountSectionProps) => (
    <section className="flex flex-wrap gap-x-10 gap-y-3.5 border-t border-hairline py-[30px]">
        <div className="flex-[0_0_220px]">
            <h2 className="display-opsz text-balance font-display text-2xl leading-[1.15] font-semibold tracking-[-0.01em] text-ink">
                {title}
            </h2>
        </div>
        <div className="max-w-[720px] min-w-0 flex-[999_1_420px]">{children}</div>
    </section>
);

export const ACCOUNT_SUB_HEADING = 'text-base font-semibold text-ink';
export const ACCOUNT_BODY = 'text-pretty text-sm leading-normal text-ink-muted';
export const ACCOUNT_NOTE = 'text-pretty text-[13px] leading-normal text-ink-muted';
export const ACCOUNT_SUBSECTION = 'mt-5 border-t border-hairline pt-5';
