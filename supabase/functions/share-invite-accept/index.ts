import { createClient } from 'npm:@supabase/supabase-js@2';

import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { passwordProblem, passwordProblemMessage } from '../_shared/passwordPolicy.ts';
import { checkRateLimit, serviceClient } from '../_shared/rateLimit.ts';
import { readCappedJson } from '../_shared/readCappedJson.ts';
import { type ConsumeResult, handleShareInviteAccept, type PeekResult } from './handler.ts';

/** Wiring for handler.ts. No JWT required (supabase/config.toml): the visitor may have no account yet. */

const env = (name: string): string | undefined => Deno.env.get(name);

const bytea = (hex: string): string => `\\x${hex}`;

Deno.serve((req) =>
    handleShareInviteAccept(req, {
        enabled: () => env('SHARE_V2_ENABLED') === '1',
        json: jsonResponse,
        options: optionsResponse,
        readJson: readCappedJson,
        checkRateLimit,
        signedInUser: async (req) => {
            const authHeader = req.headers.get('Authorization');
            const url = env('SUPABASE_URL');
            const anonKey = env('SUPABASE_ANON_KEY');
            if (!authHeader?.startsWith('Bearer ') || !url || !anonKey) {
                return null;
            }
            const client = createClient(url, anonKey, {
                global: { headers: { Authorization: authHeader } },
                auth: { persistSession: false, autoRefreshToken: false },
            });
            const { data, error } = await client.auth.getUser();
            if (error || !data.user || data.user.is_anonymous) {
                return null;
            }
            return { userId: data.user.id, email: data.user.email ?? null };
        },
        peek: async (tokenHash) => {
            const admin = serviceClient();
            if (!admin) {
                return null;
            }
            const { data, error } = await admin.rpc('share_invite_peek', { p_token_hash: bytea(tokenHash) });
            if (error || !data) {
                console.error(`share_invite_peek failed: ${error?.message ?? 'no answer'}`);
                return null;
            }
            return data as PeekResult;
        },
        consume: async (tokenHash, userId) => {
            const admin = serviceClient();
            if (!admin) {
                return null;
            }
            const { data, error } = await admin.rpc('share_invite_consume', {
                p_token_hash: bytea(tokenHash),
                p_user: userId,
            });
            if (error || !data) {
                console.error(`share_invite_consume failed: ${error?.message ?? 'no answer'}`);
                return null;
            }
            return data as ConsumeResult;
        },
        emailTaken: async (email) => {
            const admin = serviceClient();
            if (!admin) {
                return null;
            }
            const { data, error } = await admin.rpc('guest_email_taken', { p_email: email });
            if (error || typeof data !== 'boolean') {
                console.error(`guest_email_taken failed: ${error?.message ?? 'no answer'}`);
                return null;
            }
            return data;
        },
        ageGateProblem: async (gate) => {
            const admin = serviceClient();
            if (!admin) {
                return 'unknown';
            }
            const { data, error } = await admin.rpc('age_gate_problem_for', {
                p_user_metadata: { age_gate: gate },
                p_is_anonymous: false,
            });
            if (error) {
                console.error(`age_gate_problem_for failed: ${error.message}`);
                return 'unknown';
            }
            return typeof data === 'string' ? data : null;
        },
        password: { passwordProblem, passwordProblemMessage },
        // email_confirm: the invite's token reached this mailbox. The auth.users
        // insert trigger checks the age gate again (20261111170000).
        createUser: async ({ email, password, ageGate }) => {
            const admin = serviceClient();
            if (!admin) {
                return { ok: false, reason: 'failed' };
            }
            const { data, error } = await admin.auth.admin.createUser({
                email,
                password,
                email_confirm: true,
                user_metadata: { age_gate: ageGate },
            });
            if (!error && data.user) {
                return { ok: true, userId: data.user.id };
            }
            const code = (error as { code?: unknown } | null)?.code;
            if (code === 'email_exists' || /already been registered/i.test(error?.message ?? '')) {
                return { ok: false, reason: 'email_exists' };
            }
            if (code === 'weak_password') {
                return { ok: false, reason: 'weak_password' };
            }
            console.error(`share-invite-accept: could not create the account: ${error?.message ?? 'no user'}`);
            return { ok: false, reason: 'failed' };
        },
        deleteUser: async (userId) => {
            const admin = serviceClient();
            const { error } = (await admin?.auth.admin.deleteUser(userId)) ?? { error: new Error('no client') };
            if (error) {
                console.error(
                    `share-invite-accept: could not delete ${userId} after a failed accept: ${error.message}`,
                );
            }
        },
    }),
);
