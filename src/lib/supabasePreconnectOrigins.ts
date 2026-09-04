const PRECONNECT_KEYS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PROD_URL', 'VITE_SUPABASE_DEV_URL'] as const;

/**
 * HTTPS origins to `<link rel="preconnect">` from a Vite env map.
 * Production builds often omit `VITE_SUPABASE_URL` and pick the project at
 * runtime from hostname, so `_PROD` and `_DEV` must both emit.
 */
export const collectSupabasePreconnectOrigins = (env: Record<string, string | undefined>): string[] => {
    const seen = new Set<string>();
    const origins: string[] = [];
    for (const key of PRECONNECT_KEYS) {
        const url = env[key];
        if (!url) {
            continue;
        }
        try {
            const origin = new URL(url).origin;
            if (!/^https:/.test(origin) || seen.has(origin)) {
                continue;
            }
            seen.add(origin);
            origins.push(origin);
        } catch {
            // Invalid URL — skip; the client will fail the same way.
        }
    }
    return origins;
};
