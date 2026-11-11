import type { StripeMode } from './stripeMode.ts';

/**
 * Opens a Stripe Customer Portal session (`stripe-portal`): who may open one,
 * against which Stripe account, and -- since launch-fix item 16, decision
 * 71(6) -- not while the caller's account is being deleted. The vitest suite
 * drives it in tests/billing/portalFlow.test.ts; stripe-portal/index.ts is
 * only what it runs against.
 *
 * Plan changes, card updates and cancellations all happen in the portal
 * rather than in Cleffy -- the webhook is what brings the result back into
 * `subscriptions`. What the portal actually offers is not decided here: it
 * comes from the account's default portal configuration, per mode, and this
 * only hands Stripe a customer. So "plan changes happen there" is true only
 * while `subscription_update` is enabled on that configuration with the
 * switchable products listed -- a dashboard setting, invisible from this file
 * and from the API (no version this account accepts serialises
 * `features.subscription_update.products`). DEPLOY.md §1 records the intended
 * shape; if plan switching ever silently stops working, that configuration is
 * the first thing to look at, not this code.
 *
 * NO runtime imports, for the reason checkoutFlow.ts gives.
 */

/**
 * The caller's account is being deleted (decision 71(6)): the deletion cancels
 * every subscription itself, and the webhook writes nothing for the account
 * meanwhile, so a portal session opened now could only make changes the
 * deletion then undoes, or that nothing records. deletionPending.ts's
 * ACCOUNT_DELETION_PENDING code, with the portal's own words.
 */
export const PORTAL_DELETION_PENDING = {
    error: 'This account is being deleted, so its billing can no longer be managed here.',
    code: 'account_deletion_pending',
} as const;

/**
 * Whether the caller's account is being deleted could not be checked
 * (deletionPending.ts's DELETION_CHECK_UNAVAILABLE): refused as a 503, a retry
 * prompt, since nothing was opened (decision 60(b)).
 */
export const PORTAL_DELETION_CHECK_UNAVAILABLE = {
    error: 'We could not check your account just now, so billing did not open. Please try again in a minute.',
    code: 'deletion_check_unavailable',
    retryAfterSec: 30,
} as const;

type Gate = { ok: true } | { ok: false; retryAfterSec: number };

export interface PortalDeps {
    json: (body: unknown, status?: number) => Response;
    options: () => Response;
    clientKey: (req: Request) => string;
    checkRateLimit: (key: string, limit: number, windowMs: number) => Promise<Gate>;
    /**
     * The signed-in caller, or the refusal to answer with: no session, an
     * anonymous one, or a provisioned student (who has no billing at all).
     */
    authenticate: (req: Request) => Promise<{ userId: string } | Response>;
    modeForRequest: (req: Request) => StripeMode | null;
    /** Whether Stripe and the service client are configured for this mode. */
    billingConfigured: (mode: StripeMode) => boolean;
    /**
     * account_deletion_pending() for the caller (deletionPending.ts),
     * launch-fix item 16. `unknown` is a check that could not be answered.
     */
    accountDeletionPending: (userId: string) => Promise<'clear' | 'pending' | 'unknown'>;
    /** billing_customers: the caller's Stripe customer in this mode, or null. */
    customerFor: (userId: string, mode: StripeMode) => Promise<string | null>;
    /** Stripe: a portal session for the customer; answers its URL. */
    createSession: (customerId: string, mode: StripeMode, returnUrl: string) => Promise<string>;
    appOrigin: (req: Request) => string;
    logError: (code: string, err: unknown) => void;
}

export const PORTAL_LIMIT = { limit: 10, windowMs: 60_000 } as const;

export const handlePortal = async (req: Request, deps: PortalDeps): Promise<Response> => {
    if (req.method === 'OPTIONS') {
        return deps.options();
    }
    if (req.method !== 'POST') {
        return deps.json({ error: 'Method not allowed' }, 405);
    }

    const rate = await deps.checkRateLimit(`portal:${deps.clientKey(req)}`, PORTAL_LIMIT.limit, PORTAL_LIMIT.windowMs);
    if (!rate.ok) {
        return deps.json({ error: 'Too many requests', retryAfterSec: rate.retryAfterSec }, 429);
    }

    const caller = await deps.authenticate(req);
    if (caller instanceof Response) {
        return caller;
    }

    // The portal opens against the account the caller's site sells on, so a
    // dev.cleffy.io tester manages their sandbox subscription and never sees a
    // real customer's billing.
    const mode = deps.modeForRequest(req);
    if (!mode) {
        return deps.json({ error: 'Unrecognised origin', code: 'unknown_origin' }, 400);
    }
    if (!deps.billingConfigured(mode)) {
        return deps.json({ error: 'Billing is not configured' }, 500);
    }

    // Before the customer is looked up or Stripe is called (decision 71(6)).
    const deletion = await deps.accountDeletionPending(caller.userId);
    if (deletion === 'pending') {
        return deps.json(PORTAL_DELETION_PENDING, 409);
    }
    if (deletion === 'unknown') {
        deps.logError('portal_deletion_check_failed', new Error('account_deletion_pending() did not answer'));
        return deps.json(PORTAL_DELETION_CHECK_UNAVAILABLE, 503);
    }

    try {
        const customerId = await deps.customerFor(caller.userId, mode);
        if (!customerId) {
            // Never subscribed — there is nothing to manage yet.
            return deps.json({ error: 'No billing account yet', code: 'no_customer' }, 404);
        }
        const url = await deps.createSession(customerId, mode, `${deps.appOrigin(req)}/settings`);
        return deps.json({ url });
    } catch (err) {
        deps.logError('portal_failed', err);
        return deps.json({ error: err instanceof Error ? err.message : 'Portal session failed' }, 502);
    }
};
