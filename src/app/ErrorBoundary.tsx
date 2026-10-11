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
    /** "Clear cached data and reload" was pressed and is under way. */
    clearing: boolean;
}

const reload = () => window.location.reload();

/**
 * A crash that a reload cannot fix is usually a malformed snapshot the page
 * paints before the server answers (an old build's, or a damaged one): it
 * throws again on every load, before the fresh copy can replace it. Clear
 * those (sync/db.ts clearDisplayCaches — never queued changes or marks) and
 * reload. Reloads even if the clear itself fails: there is nothing else here.
 */
const clearCachesAndReload = async () => {
    try {
        const { clearDisplayCaches, getDb } = await import('@/sync/db');
        await clearDisplayCaches(getDb());
    } catch (err) {
        console.warn('Could not clear cached data before reloading', err);
    }
    reload();
};

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
    state: ErrorBoundaryState = { error: null, updating: false, clearing: false };

    static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
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
        const { error, updating, clearing } = this.state;
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
                    <Button onClick={reload} disabled={clearing} className="mt-4 w-full">
                        Reload
                    </Button>
                    {isChunkLoadError(error) ? null : (
                        <>
                            <Button
                                variant="secondary"
                                disabled={clearing}
                                onClick={() => {
                                    this.setState({ clearing: true });
                                    void clearCachesAndReload();
                                }}
                                className="mt-3 w-full"
                            >
                                {clearing ? 'Clearing…' : 'Clear cached data and reload'}
                            </Button>
                            <p className="mt-2 text-center text-xs text-stone-600">
                                If reloading shows this again: clears the lists this device keeps for a fast start.
                                Unsaved annotations stay on the device and still upload.
                            </p>
                        </>
                    )}
                </StaticBrandShell>
            );
        }
        return this.props.children;
    }
}
