import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/imslp.ts';
import * as throttle from '../_shared/loginThrottle.ts';
import { loginThrottleSecret } from '../_shared/rateLimit.ts';
import { normalizeUsername, USERNAME_RE } from '../_shared/studentCodes.ts';
import { handleStudentLogin, type StudentLoginBackend } from './handler.ts';

/**
 * Student sign-in by username and password. The control flow — gates, their
 * order, the single floored rejection — lives in handler.ts, which says why;
 * this file is only what it runs against.
 */

const backend = (): StudentLoginBackend | null => {
    const admin = serviceClient();
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const throttleSecret = loginThrottleSecret();
    if (!admin || !supabaseUrl || !anonKey || !throttleSecret) {
        return null;
    }
    return {
        rpc: admin,
        throttleSecret,

        // Three filters, one rejection. An archived row no longer matches, which
        // is what makes archiving a student a revocation of their sign-in and not
        // just of their seat; an unclaimed row is one whose password is a
        // scramble nobody has ever seen, so matching it could only ever produce a
        // refused sign-in. An email-method row can never match at all — its
        // username is NULL.
        findClaimedStudent: async (username) => {
            const { data, error } = await admin
                .from('managed_students')
                .select('id, student_user_id, display_name')
                .eq('username', username)
                .is('archived_at', null)
                .not('claimed_at', 'is', null)
                .maybeSingle();
            if (error || !data) {
                return null;
            }
            return { id: data.id, studentUserId: data.student_user_id, displayName: data.display_name };
        },

        readAuthUser: async (userId) => {
            const { data, error } = await admin.auth.admin.getUserById(userId);
            const user = data?.user;
            if (error || !user) {
                return null;
            }
            return { email: user.email ?? null, userType: user.app_metadata?.user_type };
        },

        // A FRESH anon-key client, deliberately carrying no Authorization header:
        // nothing the caller sent travels with this sign-in, and the session it
        // produces is handed to the client rather than kept in the isolate.
        signIn: async (email, password) => {
            const anonClient = createClient(supabaseUrl, anonKey, {
                auth: { persistSession: false, autoRefreshToken: false },
            });
            const { data, error } = await anonClient.auth.signInWithPassword({ email, password });
            if (error || !data.session) {
                return null;
            }
            return { accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
        },
    };
};

Deno.serve((req) =>
    handleStudentLogin(req, {
        json: jsonResponse,
        options: optionsResponse,
        clientKey,
        checkRateLimit,
        codes: { normalizeUsername, USERNAME_RE },
        throttle,
        backend,
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        logError: (message) => console.error(message),
    }),
);
