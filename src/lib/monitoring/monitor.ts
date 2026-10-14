/**
 * The error-reporting seam the app talks to, independent of Sentry.
 *
 * Sentry's SDK is loaded lazily — a separate chunk fetched off the critical
 * path, never blocking the first render, and only on a build that
 * has a DSN — so anything reported before it arrives is queued and replayed
 * once it does. That covers the errors that matter most: a crash during the
 * very first render, or a rejection fired while the shell is still loading.
 *
 * Nothing here imports Sentry. The real client is behind `load`, which the
 * module-level singleton in ./index.ts only wires up when VITE_SENTRY_DSN was
 * set at build time; otherwise the app gets NOOP_MONITOR and the SDK is never
 * even emitted into the bundle.
 */

export interface ReportContext {
    /** Short, content-free labels: where it happened, never what was in it. */
    tags?: Record<string, string>;
    /** React's component stack, from an error boundary. */
    componentStack?: string;
}

/** What the lazily-loaded client must provide. */
export interface MonitorClient {
    captureException: (error: unknown, context?: ReportContext) => void;
    setUserId: (id: string | null) => void;
}

export interface MonitorOptions {
    /** Imports and initialises the real client. Called at most once. */
    load: () => Promise<MonitorClient>;
    /** Where uncaught errors and rejections are observed — `window` in the app. */
    target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
    /** Bound on what is held while the SDK loads; older entries are dropped. */
    maxQueued?: number;
}

export interface Monitor {
    readonly enabled: boolean;
    /** Starts loading the client and begins observing global errors. Idempotent. */
    start: () => void;
    report: (error: unknown, context?: ReportContext) => void;
    setUserId: (id: string | null) => void;
}

export const NOOP_MONITOR: Monitor = {
    enabled: false,
    start: () => undefined,
    report: () => undefined,
    setUserId: () => undefined,
};

type Queued = { kind: 'error'; error: unknown; context?: ReportContext } | { kind: 'user'; id: string | null };

export const createMonitor = ({ load, target, maxQueued = 20 }: MonitorOptions): Monitor => {
    let client: MonitorClient | null = null;
    let started = false;
    let failed = false;
    const queue: Queued[] = [];

    const enqueue = (entry: Queued) => {
        if (failed) {
            return;
        }
        queue.push(entry);
        if (queue.length > maxQueued) {
            queue.shift();
        }
    };

    // Until the SDK is up, these listeners are the only thing watching. Once it
    // is, Sentry's own global handlers take over and these are removed, so an
    // error is never reported twice.
    const onError = (event: Event) => {
        const error = (event as ErrorEvent).error ?? (event as ErrorEvent).message;
        enqueue({ kind: 'error', error, context: { tags: { source: 'window.error' } } });
    };
    const onRejection = (event: Event) => {
        enqueue({
            kind: 'error',
            error: (event as PromiseRejectionEvent).reason,
            context: { tags: { source: 'unhandledrejection' } },
        });
    };

    const detach = () => {
        target?.removeEventListener('error', onError);
        target?.removeEventListener('unhandledrejection', onRejection);
    };

    return {
        enabled: true,
        start: () => {
            if (started) {
                return;
            }
            started = true;
            target?.addEventListener('error', onError);
            target?.addEventListener('unhandledrejection', onRejection);
            load()
                .then((loaded) => {
                    client = loaded;
                    detach();
                    for (const entry of queue.splice(0)) {
                        if (entry.kind === 'user') {
                            loaded.setUserId(entry.id);
                        } else {
                            loaded.captureException(entry.error, entry.context);
                        }
                    }
                })
                .catch(() => {
                    // A blocked or failed SDK download (ad blockers do this) must
                    // never become an error of its own. Monitoring is simply off.
                    failed = true;
                    detach();
                    queue.length = 0;
                });
        },
        report: (error, context) => {
            if (client) {
                client.captureException(error, context);
                return;
            }
            enqueue({ kind: 'error', error, context });
        },
        setUserId: (id) => {
            if (client) {
                client.setUserId(id);
                return;
            }
            enqueue({ kind: 'user', id });
        },
    };
};
