import { requireSupabaseConfig } from '@/lib/supabase';

/**
 * The signed-out cancellation calls (supabase/functions/billing-cancel, flow in
 * _shared/cancelFlow.ts). A bare fetch with the anon apikey and no
 * Authorization header, like studentApi.ts: the person cancelling may have no
 * session, and the emailed token -- not a session -- is the credential.
 */

/** What became of a refund request the buyer asked for, as an answer reports it. */
export interface RefundOutcome {
    refundRequested: boolean;
    refundRequestFailed: boolean;
}

export class CancelError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        /** Set when the refusal still reports a refund request (a subscription already ended). */
        public readonly refund?: RefundOutcome,
    ) {
        super(message);
        this.name = 'CancelError';
    }
}

const refundOutcomeOf = (body: Record<string, unknown>): RefundOutcome | undefined =>
    body.refundRequested === true || body.refundRequestFailed === true
        ? { refundRequested: body.refundRequested === true, refundRequestFailed: body.refundRequestFailed === true }
        : undefined;

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
            refundOutcomeOf(body),
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
    /**
     * The account is being deleted (launch-fix item 16): the deletion cancels
     * the subscription, so the page offers only the refund request.
     */
    deletionPending?: boolean;
}

export const peekCancel = (token: string): Promise<CancelSummary> => call({ action: 'peek', token });

export type CancelResult =
    | {
          cancelled: true;
          cancelledAt: string;
          endsAt: string | null;
          refundRequested: boolean;
          refundRequestFailed: boolean;
      }
    | {
          /** The account is being deleted: nothing was changed here, the link is still good. */
          cancelled: false;
          deletionPending: true;
          refundRequested: boolean;
          refundRequestFailed: boolean;
      }
    | {
          /**
           * Stripe had already ended the subscription, so there was nothing to
           * cancel -- but the refund request asked for went to support all the
           * same (decision 72(1)). The answer is billing-cancel's 404
           * `nothing_to_cancel`, carrying what became of the request.
           */
          cancelled: false;
          alreadyEnded: true;
          refundRequested: boolean;
          refundRequestFailed: boolean;
      };

export const confirmCancel = async (token: string, requestRefund: boolean): Promise<CancelResult> => {
    try {
        return await call<CancelResult>({ action: 'cancel', token, requestRefund });
    } catch (err) {
        if (err instanceof CancelError && err.code === 'nothing_to_cancel' && err.refund) {
            return { cancelled: false, alreadyEnded: true, ...err.refund };
        }
        throw err;
    }
};
