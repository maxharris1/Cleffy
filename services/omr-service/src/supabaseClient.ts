import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Shared service-role client for writeback, job queue RPCs, and storage. */
let cached: SupabaseClient | null | undefined;

export const serviceClient = (): SupabaseClient | null => {
    if (cached !== undefined) {
        return cached;
    }
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        console.warn('[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
        cached = null;
        return null;
    }
    cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return cached;
};
