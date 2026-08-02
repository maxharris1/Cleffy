import { Component, type ErrorInfo, type ReactNode } from 'react';

import { BrandShell, brandPrimaryButtonClassName } from '@/ui/BrandShell';

interface ErrorBoundaryProps {
    children: ReactNode;
}

interface ErrorBoundaryState {
    error: Error | null;
}

/** Last-resort crash screen — annotations are safe in IndexedDB regardless. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error('Unhandled render error', error, info.componentStack);
    }

    render(): ReactNode {
        if (this.state.error) {
            return (
                <BrandShell
                    title="Something went wrong"
                    subtitle="Your annotations are saved on this device. Reload to continue where you left off."
                >
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className={brandPrimaryButtonClassName}
                    >
                        Reload
                    </button>
                </BrandShell>
            );
        }
        return this.props.children;
    }
}
