import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse } from './cors.ts';

/**
 * Resolve the calling user.
 *
 * The IMSLP functions deliberately never extract an identity — they forward the
 * caller's JWT to an anon-key client and let RLS decide. Billing and metering
 * cannot do that: a Stripe customer and a usage counter are keyed BY user id,
 * and the counters are written under the service role, so the id has to be
 * established explicitly. Hence `auth.getUser()`, which validates the token
 * with the Auth server rather than trusting an unverified claim.
 */
export interface AuthedCaller {
    /** Anon-key client carrying the caller's JWT — still fully RLS-scoped. */
    userClient: SupabaseClient;
    userId: string;
    isAnonymous: boolean;
}

export type AuthResult = { ok: true; caller: AuthedCaller } | { ok: false; response: Response };

export const requireUser = async (req: Request): Promise<AuthResult> => {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return { ok: false, response: jsonResponse({ error: 'Unauthorized' }, 401) };
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !anonKey) {
        return { ok: false, response: jsonResponse({ error: 'Server misconfigured' }, 500) };
    }

    const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await userClient.auth.getUser();
    if (error || !data.user) {
        return { ok: false, response: jsonResponse({ error: 'Unauthorized' }, 401) };
    }

    return {
        ok: true,
        caller: {
            userClient,
            userId: data.user.id,
            isAnonymous: data.user.is_anonymous === true,
        },
    };
};

/**
 * Billing is teacher-only. Anonymous sessions are share-link students, who are
 * never gated and never billed — they must not be able to start a checkout.
 */
export const rejectAnonymous = (caller: AuthedCaller): Response | null =>
    caller.isAnonymous
        ? jsonResponse({ error: 'Create an account to manage a subscription', code: 'anonymous_session' }, 403)
        : null;
