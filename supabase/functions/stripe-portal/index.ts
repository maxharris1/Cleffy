import { requireUser, rejectAnonymous, rejectStudent } from '../_shared/auth.ts';
import { jsonResponse, optionsResponse } from '../_shared/cors.ts';
import { accountDeletionPending } from '../_shared/deletionPending.ts';
import { logError } from '../_shared/errorReporting.ts';
import { handlePortal } from '../_shared/portalFlow.ts';
import { checkRateLimit, clientKey, serviceClient } from '../_shared/rateLimit.ts';
import { appOrigin, modeForRequest, stripeClient, type StripeMode } from '../_shared/stripe.ts';

/**
 * Opens a Stripe Customer Portal session. Every decision -- who may open one,
 * against which Stripe account, and not while the account is being deleted
 * (launch-fix item 16, decision 71(6)) -- lives in _shared/portalFlow.ts, with
 * what the portal offers and why; this file is only what it runs against.
 */

/**
 * The two clients the customer lookup and the session need. `billingConfigured`
 * has already answered a 500 for a mode we cannot serve, so a throw here means
 * the configuration changed underneath the request; the flow answers it 502.
 */
const billing = (mode: StripeMode) => {
    const stripe = stripeClient(mode);
    const admin = serviceClient();
    if (!stripe || !admin) {
        throw new Error('Billing is not configured');
    }
    return { stripe, admin };
};

Deno.serve((req) =>
    handlePortal(req, {
        json: jsonResponse,
        options: optionsResponse,
        clientKey,
        checkRateLimit,
        authenticate: async (request) => {
            const auth = await requireUser(request);
            if (!auth.ok) {
                return auth.response;
            }
            const anonymous = rejectAnonymous(auth.caller);
            if (anonymous) {
                return anonymous;
            }
            // A provisioned student has no billing relationship at all: no
            // customer, no subscription, nothing to manage in the portal.
            const student = rejectStudent(auth.caller);
            if (student) {
                return student;
            }
            return { userId: auth.caller.userId };
        },
        modeForRequest,
        billingConfigured: (mode) => Boolean(stripeClient(mode) && serviceClient()),
        // The one predicate (../_shared/deletionPending.ts); a failed check is
        // `unknown`, answered with a 503.
        accountDeletionPending: async (userId) => {
            const admin = serviceClient();
            if (!admin) {
                return 'unknown';
            }
            const pending = await accountDeletionPending(admin, userId);
            if (!pending.ok) {
                console.error(`could not check whether ${userId} is being deleted: ${pending.message}`);
                return 'unknown';
            }
            return pending.pending ? 'pending' : 'clear';
        },
        customerFor: async (userId, mode) => {
            const { data: customer } = await billing(mode)
                .admin.from('billing_customers')
                .select('stripe_customer_id')
                .eq('user_id', userId)
                .eq('mode', mode)
                .maybeSingle();
            return customer?.stripe_customer_id ?? null;
        },
        createSession: async (customerId, mode, returnUrl) => {
            const session = await billing(mode).stripe.billingPortal.sessions.create({
                customer: customerId,
                return_url: returnUrl,
            });
            return session.url;
        },
        appOrigin,
        logError: (code, err) => logError('stripe-portal', err, { code }),
    }),
);
