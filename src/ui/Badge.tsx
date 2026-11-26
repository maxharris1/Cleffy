import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn';

const TONE_CLASSES: Record<BadgeTone, string> = {
    neutral: 'bg-ink/6 text-ink-soft',
    accent: 'bg-accent-soft text-accent',
    ok: 'bg-tick/10 text-tick',
    warn: 'bg-amber-100 text-amber-800',
};

export interface BadgeProps {
    tone?: BadgeTone;
    className?: string;
    children: ReactNode;
}

/** Small status pill ("view only", "edit", "this device only"). */
export const Badge = ({ tone = 'neutral', className = '', children }: BadgeProps) => (
    <span
        className={`inline-flex h-[22px] items-center rounded-full px-2 text-[11px] font-semibold ${TONE_CLASSES[tone]}${className ? ` ${className}` : ''}`}
    >
        {children}
    </span>
);
