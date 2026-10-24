import { createMonitor, NOOP_MONITOR, type Monitor, type ReportContext } from '@/lib/monitoring/monitor';
import { environmentForHost } from '@/lib/monitoring/scrub';

/**
 * App-wide error reporting.
 *
 * `__SENTRY_DSN__` is substituted by Vite at build time (see vite.config.ts)
 * from VITE_SENTRY_DSN. When it is empty the ternary below folds to
 * NOOP_MONITOR during minification and the dynamic import of the SDK is dead
 * code — it is not fetched, not precached by the service worker, and not even
 * emitted as a chunk. That is the "zero cost when unset" guarantee, and it is
 * why this reads a define rather than import.meta.env, whose unset keys are not
 * guaranteed to constant-fold.
 */
const monitor: Monitor = __SENTRY_DSN__
    ? createMonitor({
          load: () =>
              import('@/lib/monitoring/sentryClient').then(({ initSentry }) =>
                  initSentry({
                      dsn: __SENTRY_DSN__,
                      release: __APP_RELEASE__,
                      environment: environmentForHost(window.location.hostname),
                  }),
              ),
          target: typeof window === 'undefined' ? undefined : window,
      })
    : NOOP_MONITOR;

/** Begin observing errors. Called once from main.tsx; a no-op without a DSN. */
export const startMonitoring = (): void => monitor.start();

/** Report a caught error. Safe to call anywhere, any time, with monitoring off. */
export const reportError = (error: unknown, context?: ReportContext): void => monitor.report(error, context);

/** Attach (or clear) the signed-in account's opaque id on future reports. */
export const setMonitoringUser = (id: string | null): void => monitor.setUserId(id);

/** The part of a Supabase session monitoringUserIdOf reads. */
interface SessionLike {
    user: { id: string; app_metadata?: Record<string, unknown> };
}

/**
 * The id to attach to reports for this session, or null.
 *
 * Never a roster student's: a student account belongs to a child or teenager
 * whose teacher made it, and an error report is no place to be able to pick
 * one out, opaque id or not. Their reports still arrive, unattributed.
 * `app_metadata.user_type` is admin-set (student-provision), so it is the
 * same flag userTypeOf() routes on.
 */
export const monitoringUserIdOf = (session: SessionLike | null | undefined): string | null => {
    if (!session) {
        return null;
    }
    return session.user.app_metadata?.['user_type'] === 'student' ? null : session.user.id;
};

export const monitoringEnabled = (): boolean => monitor.enabled;
