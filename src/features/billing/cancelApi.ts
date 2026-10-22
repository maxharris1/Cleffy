import { requireSupabaseConfig } from '@/lib/supabase';

/**
 * The signed-out cancellation calls (supabase/functions/billing-cancel, flow in
 * _shared/cancelFlow.ts). A bare fetch with the anon apikey and no
 * Authorization header, like studentApi.ts: the person cancelling may have no
 * session, and the emailed token -- not a session -- is the credential.
 */

export class CancelError extends Error {
    constructor(
        message: string,
        public readonly code: string,
    ) {
        super(message);
        this.name = 'CancelError';
    }
}

const NETWORK_FAILURE = 'Could not reach Cleffy. Check your connection and try again.';

const call = async <T>(payload: object): Promise<T> => {
    const { url: projectUrl, anonKey } = requireSupabaseConfig();
    let response: Response;
    try {
        response = await fetch(`${projectUrl}/functions/v1/billing-cancel`, {
            method: 'POST',
            headers: { apikey: anonKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    } catch {
        throw new CancelError(NETWORK_FAILURE, 'network');
    }
    let body: Record<string, unknown> = {};
    try {
        body = (await response.json()) as Record<string, unknown>;
    } catch {
        // An empty or non-JSON answer is reported by status below.
    }
    if (!response.ok) {
        throw new CancelError(
            typeof body.error === 'string' ? body.error : `Request failed (${response.status})`,
            typeof body.code === 'string' ? body.code : 'unknown',
        );
    }
    return body as T;
};

/** Mails a one-time cancel link, if the address has a subscription. Always answers the same. */
export const requestCancelLink = (email: string): Promise<{ sent: true }> => call({ action: 'start', email });

export interface CancelSummary {
    /** Masked: `a•••@example.com`. */
    email: string | null;
    plan: string | null;
    status: string | null;
    periodEnd: string | null;
    alreadyCancelling: boolean;
    refundEligible: boolean;
}

export const peekCancel = (token: string): Promise<CancelSummary> => call({ action: 'peek', token });

export interface CancelResult {
    cancelled: true;
    cancelledAt: string;
    endsAt: string | null;
    refundRequested: boolean;
    refundRequestFailed: boolean;
}

export const confirmCancel = (token: string, requestRefund: boolean): Promise<CancelResult> =>
    call({ action: 'cancel', token, requestRefund });
