import { requireUser } from '../_shared/auth.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { mailLimit } from '../_shared/mailBudget.ts';
import { checkRateLimit, refundRateLimit, serviceClient } from '../_shared/rateLimit.ts';
import { readCappedJson } from '../_shared/readCappedJson.ts';
import { resendIdempotencyKey, sendViaResend } from '../_shared/resendDelivery.ts';
import { handleShareInvite, type InviteCaller, type RpcResult } from './handler.ts';

/** Wiring for handler.ts. JWT required (supabase/config.toml): the caller is the score's owner. */

const env = (name: string): string | undefined => Deno.env.get(name);

/** PostgREST takes a bytea argument as `\x` and hex. */
const bytea = (hex: string): string => `\\x${hex}`;

const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> => {
    const admin = serviceClient();
    if (!admin) {
        return { ok: false, code: null };
    }
    const { data, error } = await admin.rpc(fn, args);
    if (error) {
        console.error(`${fn} failed: ${error.code ?? ''} ${error.message}`);
        return { ok: false, code: error.code ?? null };
    }
    return { ok: true, data: data as T };
};

Deno.serve((req) =>
    handleShareInvite(req, {
        enabled: () => env('SHARE_V2_ENABLED') === '1',
        json: jsonResponse,
        options: optionsResponse,
        readJson: readCappedJson,
        authenticate: async (req): Promise<InviteCaller | Response> => {
            const auth = await requireUser(req);
            if (!auth.ok) {
                return auth.response;
            }
            const { userClient, userId, isAnonymous, userType } = auth.caller;
            return {
                userId,
                isAnonymous,
                userType,
                ownerReady: async (documentId) => {
                    const { data, error } = await userClient.rpc('share_owner_ready', { p_document: documentId });
                    return !error && data === true;
                },
            };
        },
        checkRateLimit,
        refundRateLimit,
        secret: () => env('SHARE_INVITE_SECRET') || env('SUPABASE_SERVICE_ROLE_KEY') || null,
        mailBudget: { hour: mailLimit('shareInvite', 'hour', env), day: mailLimit('shareInvite', 'day', env) },
        createInvite: ({ caller, documentId, email, role, tokenHash }) =>
            rpc('share_invite_create', {
                p_caller: caller,
                p_document: documentId,
                p_email: email,
                p_role: role,
                p_token_hash: bytea(tokenHash),
            }),
        reissueInvite: (caller, inviteId, tokenHash) =>
            rpc('share_invite_reissue', { p_caller: caller, p_invite: inviteId, p_token_hash: bytea(tokenHash) }),
        cancelInvite: (caller, inviteId) => rpc('share_invite_cancel', { p_caller: caller, p_invite: inviteId }),
        sendEmail: async (to, message, idempotencyKey) => {
            const result = await sendViaResend({
                apiKey: env('RESEND_API_KEY'),
                idempotencyKey,
                email: { from: env('SHARE_INVITE_FROM') ?? 'Cleffy <noreply@cleffy.io>', to: [to], ...message },
            });
            if (result.outcome !== 'sent') {
                console.error(`share-invite: resend ${result.outcome}: ${result.reason}`);
            }
            return result;
        },
        idempotencyKey: resendIdempotencyKey,
        siteUrl: (env('APP_URL')?.trim() || 'https://cleffy.io').replace(/\/+$/, ''),
        randomToken: () => crypto.getRandomValues(new Uint8Array(32)),
    }),
);
