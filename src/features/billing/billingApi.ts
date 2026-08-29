import { parseLimitResponse, type LimitReachedError } from '@/features/billing/limitErrors';
import { getSupabase, requireSupabaseConfig } from '@/lib/supabase';

/**
 * Calls into the billing Edge Functions.
 *
 * These use raw fetch rather than `functions.invoke` for the same reason
 * imslpApi.importImslpPdfToStorage does: invoke collapses any non-2xx into a
 * FunctionsHttpError and throws the parsed body away, and the whole point of the
 * 402 responses is that the client can read and render them.
 */

const messageFromJsonBody = async (res: Response): Promise<string> => {
    try {
        const body = (await res.json()) as { error?: string; message?: string };
        return body.message || body.error || `Request failed (${res.status})`;
    } catch {
        return `Request failed (${res.status})`;
    }
};

export const callEdgeFunction = async (name: string, payload: unknown): Promise<Response> => {
    const supabase = getSupabase();
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
        throw new Error('Not signed in');
    }

    const { url: projectUrl, anonKey } = requireSupabaseConfig();
    return fetch(`${projectUrl}/functions/v1/${name}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: anonKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
    });
};

/** Reads a 402 out of any metered endpoint's response, or null if it is not one. */
export const limitErrorFrom = async (response: Response): Promise<LimitReachedError | null> =>
    parseLimitResponse(response);

const urlFrom = async (response: Response): Promise<string> => {
    const body = (await response.json()) as { url?: string };
    if (!body.url) {
        throw new Error('Stripe did not return a URL');
    }
    return body.url;
};

/** Starts Checkout for a price and returns the hosted URL to send the teacher to. */
export const createCheckoutSession = async (priceId: string): Promise<string> => {
    const response = await callEdgeFunction('stripe-checkout', { priceId });
    if (!response.ok) {
        throw new Error(await messageFromJsonBody(response));
    }
    return urlFrom(response);
};

export class NoBillingAccountError extends Error {
    constructor() {
        super('You have not subscribed yet, so there is nothing to manage.');
        this.name = 'NoBillingAccountError';
    }
}

/** Opens the Customer Portal, where plan changes and cancellation happen. */
export const createPortalSession = async (): Promise<string> => {
    const response = await callEdgeFunction('stripe-portal', {});
    if (response.status === 404) {
        throw new NoBillingAccountError();
    }
    if (!response.ok) {
        throw new Error(await messageFromJsonBody(response));
    }
    return urlFrom(response);
};

/** Stripe's hosted pages are full-page redirects, not embeds. */
export const redirectTo = (url: string): void => {
    window.location.assign(url);
};
