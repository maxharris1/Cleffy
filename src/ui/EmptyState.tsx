import type { ReactNode } from 'react';

export interface EmptyStateProps {
    icon?: ReactNode;
    title: string;
    body?: ReactNode;
    /** Action buttons/links. */
    children?: ReactNode;
    className?: string;
}

/** Centered empty-surface message: an invitation to act, not a dead end. */
export const EmptyState = ({ icon, title, body, children, className = '' }: EmptyStateProps) => (
    <div className={`mx-auto max-w-sm text-center${className ? ` ${className}` : ''}`}>
        {icon ? <div className="mb-4 flex justify-center text-stone-400">{icon}</div> : null}
        <h2 className="font-display text-2xl font-semibold text-stone-800">{title}</h2>
        {body ? <p className="mt-2 text-sm leading-relaxed text-stone-600">{body}</p> : null}
        {children ? <div className="mt-6 flex flex-wrap items-center justify-center gap-3">{children}</div> : null}
    </div>
);
