import type { ReactNode } from 'react';

export interface ErrorTextProps {
    children: ReactNode;
    className?: string;
}

/** Inline error line. role="status" matches the app's existing live-region usage. */
export const ErrorText = ({ children, className = '' }: ErrorTextProps) => (
    <p role="status" className={`text-sm text-danger${className ? ` ${className}` : ''}`}>
        {children}
    </p>
);
