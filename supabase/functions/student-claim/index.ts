import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { accountDeletionPending } from '../_shared/deletionPending.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/imslp.ts';
import { forgetLoginAccount, STUDENT_LOGIN_SCOPE } from '../_shared/loginThrottle.ts';
import { passwordProblem, passwordProblemMessage } from '../_shared/passwordPolicy.ts';
import { loginThrottleSecret } from '../_shared/rateLimit.ts';
import { readCappedJson } from '../_shared/readCappedJson.ts';
import {
    hashLoginCode,
    isPlausibleLoginCode,
    isValidUsername,
    normalizeLoginCode,
    normalizeUsername,
    USERNAME_MAX,
    USERNAME_MIN,
} from '../_shared/studentCodes.ts';
import { type ClaimReservation, handleStudentClaim, type StudentClaimBackend } from './handler.ts';

/**
 * Spending a login code. The control flow — the gates, the reservation, and
 * why each step comes where it does — lives in handler.ts; this file is only
 * what it runs against.
 */

const backend = (): StudentClaimBackend | null => {
    const admin = serviceClient();
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!admin || !supabaseUrl || !anonKey) {
        return null;
    }
    return {
        reserveClaim: async (codeHash) => {
            const { data, error } = await admin.rpc('reserve_student_claim', { p_code_hash: codeHash });
            if (error || !data || typeof data !== 'object') {
                if (error) {
                    console.error(`reserve_student_claim failed: ${error.message}`);
                }
                return null;
            }
            const row = data as Record<string, unknown>;
            if (row['status'] === 'busy') {
                return { status: 'busy', retryAfterSec: Number(row['retry_after_seconds']) || 60 };
            }
            if (row['status'] === 'reserved') {
                return {
                    status: 'reserved',
                    reservation: String(row['reservation']),
                    studentId: String(row['student_id']),
                    studentUserId: String(row['student_user_id']),
                    displayName: String(row['display_name'] ?? ''),
                } satisfies ClaimReservation;
            }
            return { status: 'not_found' };
        },

        readAuthUser: async (userId) => {
            const { data, error } = await admin.auth.admin.getUserById(userId);
            const user = data?.user;
            if (error || !user) {
                return null;
            }
            return { email: user.email ?? null, userType: user.app_metadata?.user_type };
        },

        // A throw (a dropped connection, a body that is not JSON) is 'unknown'
        // like an error answer: the handler releases the card and answers 503.
        teacherDeletionPending: async (studentId) => {
            try {
                const { data, error } = await admin
                    .from('managed_students')
                    .select('teacher_id')
                    .eq('id', studentId)
                    .maybeSingle();
                if (error || !data) {
                    console.error(
                        `could not read the teacher of roster row ${studentId}: ${error?.message ?? 'no row'}`,
                    );
                    return 'unknown';
                }
                const pending = await accountDeletionPending(admin, data.teacher_id as string);
                if (!pending.ok) {
                    console.error(`could not check whether ${data.teacher_id} is being deleted: ${pending.message}`);
                    return 'unknown';
                }
                return pending.pending ? 'pending' : 'clear';
            } catch (err) {
                console.error(`could not check the teacher of roster row ${studentId}:`, err);
                return 'unknown';
            }
        },

        usernameTakenByOther: async (username, studentId) => {
            const { data } = await admin
                .from('managed_students')
                .select('id')
                .eq('username', username)
                .neq('id', studentId)
                .maybeSingle();
            return Boolean(data);
        },

        setPassword: async (userId, password) => {
            const { error } = await admin.auth.admin.updateUserById(userId, { password });
            return error ? error.message : null;
        },

        // A FRESH anon-key client, deliberately carrying no Authorization header:
        // nothing the caller sent travels with this sign-in, and the session it
        // produces is handed to the client rather than kept in the isolate.
        signIn: async (email, password, captchaToken) => {
            const anonClient = createClient(supabaseUrl, anonKey, {
                auth: { persistSession: false, autoRefreshToken: false },
            });
            const { data, error } = await anonClient.auth.signInWithPassword({
                email,
                password,
                // `options` is omitted entirely without a token, so nothing about
                // this request changes on a project with captcha disabled.
                ...(captchaToken ? { options: { captchaToken } } : {}),
            });
            if (error || !data.session) {
                return { ok: false, error: error ? { code: error.code ?? null, message: error.message } : null };
            }
            return {
                ok: true,
                session: { accessToken: data.session.access_token, refreshToken: data.session.refresh_token },
            };
        },

        completeClaim: async (studentId, reservation, codeHash, username) => {
            const { data, error } = await admin.rpc('complete_student_claim', {
                p_student: studentId,
                p_reservation: reservation,
                p_code_hash: codeHash,
                p_username: username,
            });
            if (error) {
                if (error.code === '23505') {
                    return 'username_taken';
                }
                console.error(`complete_student_claim failed for ${studentId}: ${error.message}`);
                return 'error';
            }
            return data === 'claimed' ? 'claimed' : 'lost';
        },

        releaseClaim: async (studentId, reservation) => {
            const { error } = await admin.rpc('release_student_claim', {
                p_student: studentId,
                p_reservation: reservation,
            });
            if (error) {
                // The reservation runs out on its own; a retry waits until then.
                console.error(`release_student_claim failed for ${studentId}: ${error.message}`);
            }
        },

        // `'local'` -- this ONE session -- and never `'global'` (QA round 4
        // review of #57): a global sign-out would revoke every session the
        // account has, which can include the one a concurrent winner was handed.
        signOutSession: async (accessToken) => {
            try {
                await admin.auth.admin.signOut(accessToken, 'local');
            } catch (err) {
                console.error('could not revoke the session of an uncommitted claim:', err);
            }
        },

        forgetLogin: async (username) => {
            await forgetLoginAccount(admin, loginThrottleSecret(), STUDENT_LOGIN_SCOPE, username);
        },
    };
};

Deno.serve((req) =>
    handleStudentClaim(req, {
        json: jsonResponse,
        options: optionsResponse,
        clientKey,
        checkRateLimit,
        readJson: readCappedJson,
        codes: {
            hashLoginCode,
            isPlausibleLoginCode,
            isValidUsername,
            normalizeLoginCode,
            normalizeUsername,
            USERNAME_MAX,
            USERNAME_MIN,
        },
        password: { passwordProblem, passwordProblemMessage },
        backend: backend(),
        logError: (message) => console.error(message),
    }),
);
