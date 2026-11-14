import type { AgeGate } from '@/features/auth/ageCheck';
import { requireSupabaseConfig } from '@/lib/supabase';

export interface InvitePeek {
    title: string | null;
    inviterName: string | null;
    role: 'viewer' | 'editor';
    emailMasked: string;
}

type PeekResult = { kind: 'pending'; invite: InvitePeek } | { kind: 'dead'; state: string } | { kind: 'failed' };

export type AcceptResult =
    | { kind: 'ok'; documentId: string; email: string | null }
    | { kind: 'sign_in_required' }
    | { kind: 'email_mismatch' }
    | { kind: 'below_consent_age' }
    | { kind: 'age_check_missing' }
    | { kind: 'weak_password'; message: string }
    | { kind: 'dead'; state: string }
    | { kind: 'failed'; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const callInviteAccept = async (
    payload: Record<string, unknown>,
    accessToken: string | null,
): Promise<{ status: number; body: Record<string, unknown> }> => {
    const { url, anonKey } = requireSupabaseConfig();
    const res = await fetch(`${url}/functions/v1/share-invite-accept`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            apikey: anonKey,
            authorization: `Bearer ${accessToken ?? anonKey}`,
        },
        body: JSON.stringify(payload),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
    });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body: isRecord(body) ? body : {} };
};

export const peekInvite = async (token: string): Promise<PeekResult> => {
    try {
        const { status, body } = await callInviteAccept({ action: 'peek', token }, null);
        if (status !== 200) {
            return { kind: 'failed' };
        }
        if (body['state'] !== 'pending') {
            return { kind: 'dead', state: typeof body['state'] === 'string' ? body['state'] : 'invalid' };
        }
        return {
            kind: 'pending',
            invite: {
                title: typeof body['title'] === 'string' ? body['title'] : null,
                inviterName: typeof body['inviter_name'] === 'string' ? body['inviter_name'] : null,
                role: body['role'] === 'editor' ? 'editor' : 'viewer',
                emailMasked: typeof body['email_masked'] === 'string' ? body['email_masked'] : '',
            },
        };
    } catch {
        return { kind: 'failed' };
    }
};

/**
 * share-invite-accept's accept. With no account token (`accessToken` null) the
 * server checks for an existing account before the age gate, so a first call
 * with neither gate nor password just asks which way to go.
 */
export const acceptInvite = async (
    token: string,
    accessToken: string | null,
    extra: { password?: string; ageGate?: AgeGate } = {},
): Promise<AcceptResult> => {
    try {
        const { status, body } = await callInviteAccept(
            {
                action: 'accept',
                token,
                ...(extra.password ? { password: extra.password } : {}),
                ...(extra.ageGate ? { age_gate: extra.ageGate } : {}),
            },
            accessToken,
        );
        if (status === 200 && body['ok'] === true && typeof body['document_id'] === 'string') {
            return {
                kind: 'ok',
                documentId: body['document_id'],
                email: typeof body['email'] === 'string' ? body['email'] : null,
            };
        }
        const error = body['error'];
        if (
            error === 'sign_in_required' ||
            error === 'email_mismatch' ||
            error === 'below_consent_age' ||
            error === 'age_check_missing'
        ) {
            return { kind: error };
        }
        if (error === 'weak_password') {
            const message = typeof body['message'] === 'string' ? body['message'] : 'Choose a stronger password.';
            return { kind: 'weak_password', message };
        }
        if (status === 410 || status === 404) {
            return { kind: 'dead', state: typeof body['state'] === 'string' ? body['state'] : 'invalid' };
        }
        return { kind: 'failed', message: 'Could not accept the invite. Check your connection and try again.' };
    } catch {
        return { kind: 'failed', message: 'Could not accept the invite. Check your connection and try again.' };
    }
};

export const deadInviteMessage = (state: string): string => {
    switch (state) {
        case 'expired':
            return 'This invite expired. Ask the owner to send a new one.';
        case 'used':
            return 'This invite was already used.';
        case 'cancelled':
            return 'The owner cancelled this invite.';
        default:
            return "This invite doesn't work. Check you copied all of the link.";
    }
};
