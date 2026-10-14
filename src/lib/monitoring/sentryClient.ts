import * as Sentry from '@sentry/react';

import type { MonitorClient } from '@/lib/monitoring/monitor';
import { scrubBreadcrumb, scrubEvent, type Scrubbable } from '@/lib/monitoring/scrub';

export interface SentryClientConfig {
    dsn: string;
    release: string;
    environment: string;
}

/**
 * The only module that imports @sentry/react. It is reached through a dynamic
 * import in ./index.ts that exists only on a build with VITE_SENTRY_DSN set, so
 * a build without one never emits the SDK at all.
 *
 * Deliberately minimal: errors only. No performance tracing and no session
 * replay — replay records the screen, which on this product is a teacher's
 * annotated score, and that is exactly what the privacy policy promises stays
 * out of third-party hands.
 */
export const initSentry = ({ dsn, release, environment }: SentryClientConfig): MonitorClient => {
    Sentry.init({
        dsn,
        release,
        environment,
        // No IP address, cookies or request headers attached by the SDK itself.
        sendDefaultPii: false,
        maxBreadcrumbs: 50,
        beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb as unknown as Scrubbable) as unknown as typeof crumb,
        beforeSend: (event) => scrubEvent(event as unknown as Scrubbable) as unknown as typeof event,
    });

    return {
        captureException: (error, context) => {
            Sentry.captureException(error, {
                tags: context?.tags,
                contexts: context?.componentStack ? { react: { componentStack: context.componentStack } } : undefined,
            });
        },
        // An opaque account id lets a report be matched to a support request
        // without the report itself saying who anyone is.
        setUserId: (id) => Sentry.setUser(id ? { id } : null),
    };
};
