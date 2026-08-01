import { Component, type ErrorInfo, type ReactNode } from 'react';

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
                <main className="flex min-h-full flex-col items-center justify-center gap-4 p-8">
                    <h1 className="text-xl font-semibold text-stone-800">Something went wrong</h1>
                    <p className="max-w-md text-center text-sm text-stone-500">
                        Your annotations are saved on this device. Reload to continue where you left off.
                    </p>
                    <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white shadow hover:bg-indigo-500"
                    >
                        Reload
                    </button>
                </main>
            );
        }
        return this.props.children;
    }
}
