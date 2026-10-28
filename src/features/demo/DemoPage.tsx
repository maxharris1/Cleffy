import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';

import { DEMO_DOC_ID, DemoScoreMissingError, loadDemoScore } from '@/features/demo/demoScore';
import { getLocalDoc } from '@/lib/localDocs';
import { isChunkLoadError, reloadForStaleChunk } from '@/lib/staleChunk';
import { Button } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { LoadingText } from '@/ui/Loading';
import { linkClassName } from '@/ui/classNames';
import { lazyModule } from '@/ui/lazyModule';

/**
 * The viewer (pdf.js, the ink stack, Dexie) is its own chunk, requested the
 * moment this page mounts, so it downloads while the score does rather than
 * after it. A lazyModule rather than React.lazy, so a failed import shows the
 * demo's own error state rather than the app's crash screen.
 */
const demoViewerModule = lazyModule(() => import('@/features/demo/DemoViewer'));

const DEMO_DOCUMENT_TITLE = 'Try Cleffy';

/**
 * Why the demo could not open. missing: the server answered without the score
 * (a 404, or the SPA's index.html), a fault on our side that no check of the
 * visitor's connection will fix. connection: everything else — offline, a
 * dropped request, the viewer's chunk.
 */
type Failure = 'connection' | 'missing';

const failureBody = (failure: Failure): string => {
    if (failure === 'missing') {
        return 'The demo score didn’t load. Try again, or come back in a minute.';
    }
    return navigator.onLine === false
        ? 'You’re offline. Reconnect, then try again.'
        : 'Check your connection, then try again.';
};

const DemoLoading = () => (
    <main className="flex min-h-full items-center justify-center p-8">
        <LoadingText>Loading demo…</LoadingText>
    </main>
);

/**
 * /try: where the ads land. Straight into a score with the pen ready — no
 * account, no form, nothing sent anywhere. Public and ungated on purpose: a
 * signed-in teacher who taps an ad gets the demo too. The URL stays /try (and
 * keeps whatever UTM query it came with) for the whole visit.
 */
export const DemoPage = () => {
    // A return to /try in the same page load already has the bytes.
    const [bytes, setBytes] = useState<ArrayBuffer | null>(() => getLocalDoc(DEMO_DOC_ID) ?? null);
    const viewer = useSyncExternalStore(demoViewerModule.subscribe, demoViewerModule.get);
    const [failed, setFailed] = useState<Failure | null>(null);
    /**
     * The viewer's chunk failed, not only the score. The browser keeps a failed
     * module import for the life of the page, so importing it again cannot
     * work: Try again reloads instead (same URL, UTMs and all).
     */
    const [viewerFailed, setViewerFailed] = useState(false);
    /** Bumped by Try again. */
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const previous = document.title;
        document.title = DEMO_DOCUMENT_TITLE;
        return () => {
            document.title = previous;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        const fail = (err: unknown) => {
            console.warn('Could not load the demo', err);
            if (!cancelled) {
                // Both can fail at once: a connection problem is the one the visitor can act on.
                const failure: Failure = err instanceof DemoScoreMissingError ? 'missing' : 'connection';
                setFailed((previous) => (previous === 'connection' ? previous : failure));
            }
        };
        // Both at once, either failing shows the same state, and Try again retries whichever is missing.
        loadDemoScore()
            .then((loaded) => {
                if (!cancelled) {
                    setBytes(loaded);
                }
            })
            .catch(fail);
        demoViewerModule.load().catch((err: unknown) => {
            // A chunk from an older build, online: reload for the current one,
            // as the app does for any stale chunk. Offline, say so instead.
            if (navigator.onLine !== false && isChunkLoadError(err) && reloadForStaleChunk()) {
                return;
            }
            if (!cancelled) {
                setViewerFailed(true);
            }
            fail(err);
        });
        return () => {
            cancelled = true;
        };
    }, [attempt]);

    if (failed) {
        return (
            <main className="landing-page flex min-h-full flex-col items-center justify-center p-8">
                <EmptyState title="Couldn’t load the demo score" body={failureBody(failed)}>
                    <Button
                        onClick={() => {
                            if (viewerFailed) {
                                window.location.reload();
                                return;
                            }
                            setFailed(null);
                            setAttempt((n) => n + 1);
                        }}
                    >
                        Try again
                    </Button>
                    <Link to="/" className={linkClassName}>
                        Back to home
                    </Link>
                </EmptyState>
            </main>
        );
    }

    if (!bytes || !viewer) {
        return <DemoLoading />;
    }

    return <viewer.DemoViewer bytes={bytes} />;
};
