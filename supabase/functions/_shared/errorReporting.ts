import { createErrorLogger, type ErrorContext } from './errorLog.ts';

/**
 * Deno adapter over `errorLog.ts`: binds Deno.env and the real fetch, and keeps
 * the Sentry POST alive past the response.
 *
 * Call sites are catch paths that are about to return a 4xx/5xx, so the report
 * must not delay that response. EdgeRuntime.waitUntil lets the isolate finish
 * the POST after the response is sent; where it does not exist (a local
 * `supabase functions serve` of an older runtime) the promise simply runs
 * unawaited, and the console line — written synchronously — is still there.
 */

const logger = createErrorLogger({
    env: (name) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
});

interface EdgeRuntimeLike {
    waitUntil?: (promise: Promise<unknown>) => void;
}

export const logError = (fn: string, err: unknown, context?: ErrorContext): void => {
    const pending = logger(fn, err, context);
    const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeLike }).EdgeRuntime;
    if (runtime?.waitUntil) {
        runtime.waitUntil(pending);
    }
};
