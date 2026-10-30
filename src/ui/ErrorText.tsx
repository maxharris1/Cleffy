import type { ReactNode } from 'react';

export interface ErrorTextProps {
    children: ReactNode;
    className?: string;
}

/**
 * Inline error line. role="status" matches the app's existing live-region
 * usage. It fades in (150ms, opacity only, so reduced motion keeps it too):
 * paired with a refused code's shake, the shake says "no" and the line says why.
 */
export const ErrorText = ({ children, className = '' }: ErrorTextProps) => (
    <p role="status" className={`ui-error-in text-sm text-danger${className ? ` ${className}` : ''}`}>
        {children}
    </p>
);
