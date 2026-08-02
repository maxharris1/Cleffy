import type { ReactNode } from 'react';

export interface LoadingTextProps {
    children: ReactNode;
    className?: string;
}

/** Pulsing status line — the app-wide loading treatment. */
export const LoadingText = ({ children, className = '' }: LoadingTextProps) => (
    <p role="status" className={`animate-pulse text-stone-500${className ? ` ${className}` : ''}`}>
        {children}
    </p>
);

/** Circular spinner for inline/button loading; sized via className. */
export const Spinner = ({ className = 'h-4 w-4' }: { className?: string }) => (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={`motion-safe:animate-spin ${className}`}>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
);
