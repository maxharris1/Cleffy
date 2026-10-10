import { Component, type ErrorInfo, type ReactNode } from 'react';

import { reportError } from '@/lib/monitoring';
import {
    canReloadForStaleChunk,
    isChunkLoadError,
    isStaleChunkReloadPending,
    reloadForStaleChunk,
} from '@/lib/staleChunk';
import { StaticBrandShell } from '@/ui/BrandShell';
import { Button } from '@/ui/Button';

interface ErrorBoundaryProps {
    children: ReactNode;
}

interface ErrorBoundaryState {
    error: Error | null;
    /** The error is a chunk from an older build, and the page is reloading for the current one. */
    updating: boolean;
}

const reload = () => window.location.reload();

/**
 * Last-resort crash screen — annotations are safe in IndexedDB regardless.
 *
 * It sits ABOVE the router (App.tsx), so nothing it renders may need one:
 * StaticBrandShell, a plain button, no Link and no hooks from react-router.
 *
 * A lazy chunk that no longer exists (a tab left open across a deploy, see
 * lib/staleChunk.ts) is not a crash: the page reloads once to fetch the
 * current build, and shows "Updating" meanwhile instead of an error. Only when
 * that was already tried moments ago does it fall through to the crash screen.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null, updating: false };

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return {
            error,
            updating: isStaleChunkReloadPending() || (isChunkLoadError(error) && canReloadForStaleChunk()),
        };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        if (isStaleChunkReloadPending() || (isChunkLoadError(error) && reloadForStaleChunk())) {
            // Expected after every deploy, and the reload is the fix: not a report.
            console.warn('A part of Cleffy from an older version could not load; reloading', error);
            return;
        }
        if (this.state.updating) {
            // The reload turned out not to be possible after all (storage refused the guard).
            this.setState({ updating: false });
        }
        console.error('Unhandled render error', error, info.componentStack);
        // Scrubbed before it leaves the browser (lib/monitoring/scrub.ts); a
        // no-op on a build without a DSN.
        reportError(error, { componentStack: info.componentStack ?? undefined, tags: { source: 'error-boundary' } });
    }

    render(): ReactNode {
        const { error, updating } = this.state;
        if (error && updating) {
            return (
                <StaticBrandShell title="Updating Cleffy…" subtitle="A new version is available. Reloading the page.">
                    <Button variant="secondary" onClick={reload} className="mt-4 w-full">
                        Reload now
                    </Button>
                </StaticBrandShell>
            );
        }
        if (error) {
            return (
                <StaticBrandShell
                    title="Something went wrong"
                    subtitle={
                        isChunkLoadError(error)
                            ? 'Part of Cleffy could not be loaded. Check your connection, then reload. Your annotations are saved on this device.'
                            : 'Your annotations are saved on this device. Reload to continue where you left off.'
                    }
                >
                    <Button onClick={reload} className="mt-4 w-full">
                        Reload
                    </Button>
                </StaticBrandShell>
            );
        }
        return this.props.children;
    }
}
