import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

/**
 * Lazily-initialized Supabase client singleton.
 *
 * Lazy so the app shell (and tests) can run without Supabase env configured;
 * only code paths that actually need the backend will throw.
 */
export const getSupabase = (): SupabaseClient => {
    if (client) {
        return client;
    }

    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    if (!url || !anonKey) {
        throw new Error(
            'Supabase is not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example)',
        );
    }

    client = createClient(url, anonKey, {
        realtime: {
            // Live ink streams at up to ~20 events/s per writer; the realtime-js
            // default client-side throttle (10/s) would silently degrade it.
            params: { eventsPerSecond: 40 },
        },
    });
    return client;
};
