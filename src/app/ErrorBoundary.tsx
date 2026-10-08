import { Component, type ErrorInfo, type ReactNode } from 'react';

import { reportError } from '@/lib/monitoring';
import { BrandShell } from '@/ui/BrandShell';
import { Button } from '@/ui/Button';

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
        // Scrubbed before it leaves the browser (lib/monitoring/scrub.ts); a
        // no-op on a build without a DSN.
        reportError(error, { componentStack: info.componentStack ?? undefined, tags: { source: 'error-boundary' } });
    }

    render(): ReactNode {
        if (this.state.error) {
            return (
                <BrandShell
                    title="Something went wrong"
                    subtitle="Your annotations are saved on this device. Reload to continue where you left off."
                >
                    <Button onClick={() => window.location.reload()} className="mt-4 w-full">
                        Reload
                    </Button>
                </BrandShell>
            );
        }
        return this.props.children;
    }
}
