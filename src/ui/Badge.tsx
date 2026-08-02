import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn';

const TONE_CLASSES: Record<BadgeTone, string> = {
    neutral: 'bg-stone-100 text-stone-600',
    accent: 'bg-accent-soft text-accent',
    ok: 'bg-emerald-100 text-emerald-700',
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
        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}${className ? ` ${className}` : ''}`}
    >
        {children}
    </span>
);
