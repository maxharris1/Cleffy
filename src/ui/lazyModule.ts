import { loadAsPrefetch } from '@/lib/staleChunk';

/**
 * A module kept out of the shell bundle and imported on demand, that the UI
 * can also read synchronously once it has arrived.
 *
 * The Base UI dialog and menu are a large slice of the app's JavaScript and
 * none of it is needed to draw the first screen. Their wrappers (ui/Dialog,
 * ui/Menu) import them through this: `prefetch` warms the chunk on idle or on
 * a trigger's hover or focus, `load` is the import a first open waits on, and
 * `get`/`subscribe` let a mounted wrapper switch to the real component the
 * moment the chunk is in, without suspending a frame on React.lazy.
 */
export interface LazyModule<T> {
    /** The module, once loaded; null until then. */
    get: () => T | null;
    /** Import it. Once per page load; a failed import is tried again on the next call. */
    load: () => Promise<T>;
    /** Warm it in the background: a failure is dropped (and a stale chunk does not reload the page). */
    prefetch: () => void;
    /** Called once, when the module arrives. */
    subscribe: (listener: () => void) => () => void;
}

export const lazyModule = <T>(importModule: () => Promise<T>): LazyModule<T> => {
    let loaded: T | null = null;
    let pending: Promise<T> | null = null;
    const listeners = new Set<() => void>();

    const load = (): Promise<T> => {
        pending ??= importModule().then(
            (module) => {
                loaded = module;
                for (const listener of [...listeners]) {
                    listener();
                }
                return module;
            },
            (error: unknown) => {
                pending = null;
                throw error;
            },
        );
        return pending;
    };

    return {
        get: () => loaded,
        load,
        prefetch: () => {
            if (loaded === null) {
                void loadAsPrefetch(load).catch(() => undefined);
            }
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
};
