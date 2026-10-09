/**
 * Which Supabase origin a page will talk to, decided where both the client
 * (src/lib/supabase.ts) and the build (vite.config.ts) can read it.
 *
 * NO imports: vite.config.ts loads this file under Node before any alias or
 * bundler exists.
 */

/**
 * Only cleffy.io talks to the production project. Every other host —
 * dev.cleffy.io, the Vercel preview URLs, localhost — talks to the `dev` branch
 * project, so nothing but the real storefront can write production rows.
 */
export const PRODUCTION_HOSTS: readonly string[] = ['cleffy.io', 'www.cleffy.io'];

/** The env prefix whose `_URL` / `_ANON_KEY` this host uses when no explicit project is set. */
export const supabaseEnvPrefixFor = (hostname: string): 'VITE_SUPABASE_PROD' | 'VITE_SUPABASE_DEV' =>
    PRODUCTION_HOSTS.includes(hostname.toLowerCase()) ? 'VITE_SUPABASE_PROD' : 'VITE_SUPABASE_DEV';

/** Public path of the preconnect script the build emits for host-picked backends. */
export const SUPABASE_PRECONNECT_SCRIPT_PATH = '/supabase-preconnect.js';

const httpsOrigin = (url: string | undefined): string | null => {
    if (!url) {
        return null;
    }
    try {
        const origin = new URL(url).origin;
        return /^https:/.test(origin) ? origin : null;
    } catch {
        // Invalid URL — nothing to warm; the client will fail the same way.
        return null;
    }
};

/**
 * How index.html warms the connection to the backend this page will use:
 * - `static`: the build already knows (an explicit VITE_SUPABASE_URL + key,
 *   which supabaseConfig always honours) — a plain `<link rel="preconnect">`;
 * - `by-host`: one build serves cleffy.io and dev.cleffy.io and the hostname
 *   picks at runtime, so a static tag would have to name both projects and
 *   dev.cleffy.io would open a connection to production on every load. A tiny
 *   same-origin script picks the origin the same way supabaseConfig does;
 * - `none`: nothing over https to warm (local stack, unconfigured).
 */
export type SupabasePreconnectPlan =
    | { kind: 'none' }
    | { kind: 'static'; origin: string }
    | { kind: 'by-host'; prodOrigin: string | null; devOrigin: string | null };

export const supabasePreconnectPlan = (env: Record<string, string | undefined>): SupabasePreconnectPlan => {
    if (env['VITE_SUPABASE_URL'] && env['VITE_SUPABASE_ANON_KEY']) {
        const origin = httpsOrigin(env['VITE_SUPABASE_URL']);
        return origin ? { kind: 'static', origin } : { kind: 'none' };
    }
    const prodOrigin = httpsOrigin(env['VITE_SUPABASE_PROD_URL']);
    const devOrigin = httpsOrigin(env['VITE_SUPABASE_DEV_URL']);
    if (!prodOrigin && !devOrigin) {
        return { kind: 'none' };
    }
    return { kind: 'by-host', prodOrigin, devOrigin };
};

/**
 * Source of the `by-host` script: classic (not a module) and dependency-free so
 * it runs the moment it arrives, while the app bundle is still downloading. It
 * is loaded `async` from our own origin because the CSP (`script-src 'self'`)
 * forbids an inline one.
 */
export const supabasePreconnectScript = (plan: { prodOrigin: string | null; devOrigin: string | null }): string =>
    [
        '(function () {',
        `    var production = ${JSON.stringify(PRODUCTION_HOSTS)};`,
        `    var origin = production.indexOf(location.hostname.toLowerCase()) >= 0 ? ${JSON.stringify(plan.prodOrigin)} : ${JSON.stringify(plan.devOrigin)};`,
        '    if (!origin) return;',
        "    var link = document.createElement('link');",
        "    link.rel = 'preconnect';",
        '    link.href = origin;',
        "    link.crossOrigin = '';",
        '    document.head.appendChild(link);',
        '})();',
        '',
    ].join('\n');
