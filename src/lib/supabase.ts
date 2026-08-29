import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database';

export type TypedSupabaseClient = SupabaseClient<Database>;

let client: TypedSupabaseClient | null = null;

const env = (key: string): string | undefined => {
    const value = import.meta.env[key] as string | undefined;
    return value && value.length > 0 ? value : undefined;
};

/**
 * Only cleffy.io talks to the production project. Every other host —
 * dev.cleffy.io, the Vercel preview URLs, localhost — talks to the `dev` branch
 * project, so nothing but the real storefront can write production rows.
 */
const PRODUCTION_HOSTS = ['cleffy.io', 'www.cleffy.io'];

export interface SupabaseConfig {
    url: string | undefined;
    anonKey: string | undefined;
}

/**
 * Which Supabase project this page talks to.
 *
 * The choice is made here, from the hostname, rather than by a Vercel Preview
 * environment variable. That setting is invisible from the repo and easy to
 * believe in without checking: DEPLOY.md recorded dev.cleffy.io as pointing at
 * the branch project while every deploy it ever served was in fact built
 * against production. A rule in the bundle cannot be true only on paper.
 *
 * An explicit `VITE_SUPABASE_URL` still wins, which is what a local `.env` sets
 * — including the `supabase start` stack on 127.0.0.1 — and what a Vercel
 * environment variable would set if one is ever added.
 */
export const supabaseConfig = (): SupabaseConfig => {
    const url = env('VITE_SUPABASE_URL');
    const anonKey = env('VITE_SUPABASE_ANON_KEY');
    if (url && anonKey) {
        return { url, anonKey };
    }

    const host = typeof location === 'undefined' ? '' : location.hostname.toLowerCase();
    const prefix = PRODUCTION_HOSTS.includes(host) ? 'VITE_SUPABASE_PROD' : 'VITE_SUPABASE_DEV';
    return { url: env(`${prefix}_URL`), anonKey: env(`${prefix}_ANON_KEY`) };
};

/** True when Supabase config is present (cloud features available). */
export const isSupabaseConfigured = (): boolean => {
    const { url, anonKey } = supabaseConfig();
    return Boolean(url && anonKey);
};

/**
 * The same config for callers that cannot proceed without it — every direct
 * Edge Function call. They used to read the env vars and cast away `undefined`,
 * which turned a missing config into `apikey: undefined` on the wire and a 401
 * to puzzle over; this throws the same message `getSupabase` does instead.
 */
export const requireSupabaseConfig = (): { url: string; anonKey: string } => {
    const { url, anonKey } = supabaseConfig();
    if (!url || !anonKey) {
        throw new Error(
            'Supabase is not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example)',
        );
    }
    return { url, anonKey };
};

/**
 * Lazily-initialized Supabase client singleton.
 *
 * Lazy so the app shell (and tests) can run without Supabase env configured;
 * only code paths that actually need the backend will throw.
 */
export const getSupabase = (): TypedSupabaseClient => {
    if (client) {
        return client;
    }

    const { url, anonKey } = requireSupabaseConfig();

    client = createClient<Database>(url, anonKey, {
        realtime: {
            // Live ink streams at up to ~20 events/s per writer; the realtime-js
            // default client-side throttle (10/s) would silently degrade it.
            params: { eventsPerSecond: 40 },
        },
    });
    return client;
};
