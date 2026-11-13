import { useEffect, useRef, useState, type ComponentType } from 'react';

import { ViewScore } from '@/view/ViewScore';
import {
    loadViewPdf,
    mergeAnnotations,
    pollView,
    visibleMarks,
    type ViewAnnotation,
    type ViewMark,
} from '@/view/viewLinkClient';

/**
 * The /v page: a score shown read-only through an under-13 view link.
 *
 * Memory only. It reads and writes no localStorage, sessionStorage,
 * IndexedDB, cookie, Cache Storage or service worker (ViewApp.test.tsx guards
 * every one), asks nothing of the person and stores nothing about them.
 * Every 2.5 s it asks /api/view for marks newer than the last it has.
 */

export interface ViewScoreProps {
    bytes: ArrayBuffer;
    annotations: readonly ViewMark[];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ViewAppProps {
    /** From location.hash; null when absent or malformed. */
    token: string | null;
    /** features.viewLinks: the build switch. */
    enabled: boolean;
    fetchImpl?: FetchLike;
    /** The renderer; tests replace pdf.js, which jsdom cannot run. */
    Score?: ComponentType<ViewScoreProps>;
    pollMs?: number;
}

export const VIEW_POLL_MS = 2500;

type Phase = 'loading' | 'ready' | 'gone' | 'unavailable';

export const ViewApp = ({ token, enabled, fetchImpl, Score = ViewScore, pollMs = VIEW_POLL_MS }: ViewAppProps) => {
    const active = enabled && token !== null;
    const [phase, setPhase] = useState<Phase>(active ? 'loading' : 'unavailable');
    const [offline, setOffline] = useState(false);
    const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
    const [marks, setMarks] = useState<readonly ViewMark[]>([]);
    const retryNow = useRef<() => void>(() => undefined);

    useEffect(() => {
        if (!active || token === null) {
            return;
        }
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let since = 0;
        let shown = new Map<string, ViewAnnotation>();
        let pdfRev: number | null = null;

        const stop = (end: 'gone' | 'unavailable') => {
            stopped = true;
            clearTimeout(timer);
            setBytes(null);
            setMarks([]);
            setOffline(false);
            setPhase(end);
        };
        const schedule = (ms: number) => {
            clearTimeout(timer);
            timer = setTimeout(() => void tick(), ms);
        };

        const tick = async (): Promise<void> => {
            // A hidden tab waits rather than spending the link's shared rate limit.
            if (document.visibilityState === 'hidden') {
                schedule(pollMs);
                return;
            }
            const result = await pollView(token, since, fetchImpl);
            if (stopped) {
                return;
            }
            if (result.kind === 'gone' || result.kind === 'unavailable') {
                stop(result.kind);
                return;
            }
            if (result.kind === 'offline') {
                setOffline(true);
                schedule(pollMs);
                return;
            }
            if (result.kind === 'busy') {
                schedule(Math.max(pollMs, result.retryAfterMs));
                return;
            }
            const { poll } = result;
            if (poll.doc.pdf_rev !== pdfRev) {
                const pdf = await loadViewPdf(token, fetchImpl);
                if (stopped) {
                    return;
                }
                if (pdf.kind === 'gone' || pdf.kind === 'unavailable') {
                    stop(pdf.kind);
                    return;
                }
                if (pdf.kind !== 'ok') {
                    setOffline(pdf.kind === 'offline');
                    schedule(pdf.kind === 'busy' ? Math.max(pollMs, pdf.retryAfterMs) : pollMs);
                    return;
                }
                pdfRev = poll.doc.pdf_rev;
                setBytes(pdf.bytes);
            }
            shown = mergeAnnotations(shown, poll.annotations);
            since = poll.max_seq;
            setMarks(visibleMarks(shown));
            setOffline(false);
            setPhase('ready');
            schedule(poll.more ? 0 : pollMs);
        };

        retryNow.current = () => {
            if (!stopped) {
                schedule(0);
            }
        };
        void tick();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [active, token, fetchImpl, pollMs]);

    return (
        <div className="flex min-h-dvh flex-col bg-paper text-ink">
            <header className="flex items-center justify-between px-4 py-3">
                <span className="font-display text-lg">Cleffy</span>
                <span className="text-xs text-ink-muted">View only</span>
            </header>
            {offline ? (
                <div role="status" className="mx-4 mb-2 flex items-center gap-3 rounded-lg bg-amber-50 px-3 py-2">
                    <p className="flex-1 text-sm text-amber-900">Can’t reach Cleffy. Trying again…</p>
                    <button
                        type="button"
                        onClick={() => retryNow.current()}
                        className="rounded px-2 py-1 text-sm text-amber-900 underline pointer-coarse:min-h-11"
                    >
                        Try now
                    </button>
                </div>
            ) : null}
            <main className="flex min-h-0 flex-1 flex-col">
                {phase === 'ready' && bytes ? <Score bytes={bytes} annotations={marks} /> : <Message phase={phase} />}
            </main>
            <footer className="px-4 py-1 text-center text-xs text-ink-muted">
                <a
                    href="/children-privacy"
                    rel="noreferrer"
                    className="inline-flex min-h-11 items-center px-2 underline"
                >
                    Children’s privacy
                </a>
            </footer>
        </div>
    );
};

const Message = ({ phase }: { phase: Phase }) => {
    const text =
        phase === 'gone'
            ? 'This link was turned off. Ask your teacher for a new one.'
            : phase === 'unavailable'
              ? 'This view link isn’t available.'
              : 'Loading the score…';
    return (
        <div className="flex flex-1 items-center justify-center p-6">
            <p role={phase === 'loading' ? 'status' : 'alert'} className="max-w-sm text-center text-base text-ink">
                {text}
            </p>
        </div>
    );
};
