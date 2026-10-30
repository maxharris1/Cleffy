import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router';

import { DEMO_DOC_ID } from '@/features/demo/demoScore';
import { DemoScoreUnavailableError, loadDemoScore } from '@/features/demo/loadDemoScore';
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
 * Why the demo could not open. `missing`: the score itself is gone or wrong (a
 * fault of the deploy), so the visitor's connection is not to blame.
 * `network`: the score or the viewer's chunk could not be fetched.
 */
type Failure = 'network' | 'missing';

const failureCopy = (failure: Failure): string => {
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
    const [failure, setFailure] = useState<Failure | null>(null);
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
        const fail = (kind: Failure, err: unknown) => {
            console.warn('Could not load the demo', err);
            if (!cancelled) {
                // Both failing: the missing score is what to report.
                setFailure((current) => (current === 'missing' ? current : kind));
            }
        };
        // Both at once, either failing shows the same state, and Try again retries whichever is missing.
        loadDemoScore()
            .then((loaded) => {
                if (!cancelled) {
                    setBytes(loaded);
                }
            })
            .catch((err: unknown) => fail(err instanceof DemoScoreUnavailableError ? 'missing' : 'network', err));
        demoViewerModule.load().catch((err: unknown) => {
            // A chunk from an older build, online: reload for the current one,
            // as the app does for any stale chunk. Offline, say so instead.
            if (navigator.onLine !== false && isChunkLoadError(err) && reloadForStaleChunk()) {
                return;
            }
            if (!cancelled) {
                setViewerFailed(true);
            }
            fail('network', err);
        });
        return () => {
            cancelled = true;
        };
    }, [attempt]);

    if (failure) {
        return (
            <main className="landing-page flex min-h-full flex-col items-center justify-center p-8">
                <EmptyState title="Couldn’t load the demo score" body={failureCopy(failure)}>
                    <Button
                        onClick={() => {
                            if (viewerFailed) {
                                window.location.reload();
                                return;
                            }
                            setFailure(null);
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
