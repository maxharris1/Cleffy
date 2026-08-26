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
    /**
     * 'student' for a provisioned student account, null for everyone else.
     *
     * app_metadata is written by the admin API when the account is created, so —
     * unlike user_metadata — it is not something the account itself can set. That
     * is what makes it trustworthy here, and it is the same flag get_entitlements()
     * and the documents_insert policy read on the SQL side.
     */
    userType: 'student' | null;
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
            // Only the exact flag counts: any other value is an ordinary account.
            userType: data.user.app_metadata?.user_type === 'student' ? 'student' : null,
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

/**
 * A provisioned student is entitled by their teacher's plan and billed to
 * nobody: there is no subscription of theirs to buy, manage or draw down. They
 * are a registered, non-anonymous user, so `rejectAnonymous` does not catch
 * them — anything that spends money or metered budget needs this check too.
 */
export const rejectStudent = (caller: AuthedCaller): Response | null =>
    caller.userType === 'student'
        ? jsonResponse({ error: 'Student accounts are managed by your teacher', code: 'student_account' }, 403)
        : null;
