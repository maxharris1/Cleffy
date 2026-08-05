import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

/**
 * Shared Edge Function rate limiting (extracted from imslp.ts so non-IMSLP
 * functions can use it without pulling MediaWiki helpers).
 */

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

const memoryRateLimit = (
    key: string,
    limit: number,
    windowMs: number,
): { ok: true } | { ok: false; retryAfterSec: number } => {
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
        rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
        return { ok: true };
    }
    if (bucket.count >= limit) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    return { ok: true };
};

/** Service-role client for shared rate-limit RPCs (cached). */
let cachedService: SupabaseClient | null | undefined;

export const serviceClient = (): SupabaseClient | null => {
    if (cachedService !== undefined) {
        return cachedService;
    }
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) {
        cachedService = null;
        return null;
    }
    cachedService = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return cachedService;
};

/**
 * Cross-isolate sliding window via Postgres. When a service-role client is
 * available, RPC failure fails closed (429) so Free-plan quotas are not
 * silently bypassed by per-isolate memory. Memory fallback is only for local
 * Edge without service-role credentials.
 */
export const checkRateLimit = async (
    key: string,
    limit: number,
    windowMs: number,
): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> => {
    const admin = serviceClient();
    if (!admin) {
        return memoryRateLimit(key, limit, windowMs);
    }
    try {
        const { data, error } = await admin.rpc('check_edge_rate_limit', {
            p_key: key,
            p_limit: limit,
            p_window_ms: windowMs,
        });
        if (!error && data && typeof data === 'object') {
            const record = data as { ok?: boolean; retryAfterSec?: number };
            if (record.ok === true) {
                return { ok: true };
            }
            if (record.ok === false) {
                return {
                    ok: false,
                    retryAfterSec: typeof record.retryAfterSec === 'number' ? record.retryAfterSec : 1,
                };
            }
        }
    } catch {
        // fall through to fail-closed
    }
    return { ok: false, retryAfterSec: 5 };
};

export const clientKey = (req: Request): string => {
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) {
        return forwarded.split(',')[0]?.trim() || 'unknown';
    }
    return req.headers.get('cf-connecting-ip') ?? 'unknown';
};
