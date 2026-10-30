/**
 * Build-time constants substituted by the `build-constants` plugin in
 * vite.config.ts. Declared here so application code can read them as plain
 * identifiers, which is what lets the minifier fold them.
 */

/** VITE_SENTRY_DSN at build time, or '' when unset (monitoring compiled out). */
declare const __SENTRY_DSN__: string;

/** Release tag for error reports: `cleffy@<commit>` on Vercel, else the package version. */
declare const __APP_RELEASE__: string;
