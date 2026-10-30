// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ACCOUNT_DELETION_PENDING, DELETION_CHECK_UNAVAILABLE } from '../../supabase/functions/_shared/deletionPending';
import {
    handlePortal,
    PORTAL_DELETION_CHECK_UNAVAILABLE,
    PORTAL_DELETION_PENDING,
    type PortalDeps,
} from '../../supabase/functions/_shared/portalFlow';

/**
 * stripe-portal's handler (_shared/portalFlow.ts) against stand-ins for auth,
 * billing_customers and Stripe. Launch-fix item 16, decision 71(6): no new
 * portal session while the caller's account is being deleted.
 */

const USER = '0b5e0000-0000-4000-8000-0000000000d1';

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const post = () =>
    new Request('https://edge.test/functions/v1/stripe-portal', {
        method: 'POST',
        headers: { Origin: 'https://cleffy.io', Authorization: 'Bearer user-jwt' },
    });

const harness = (deletion: 'clear' | 'pending' | 'unknown' = 'clear') => {
    const errors: string[] = [];
    const deps: PortalDeps = {
        json,
        options: () => new Response(null, { status: 204 }),
        clientKey: () => '203.0.113.7',
        checkRateLimit: vi.fn(async () => ({ ok: true as const })),
        authenticate: vi.fn(async () => ({ userId: USER })),
        modeForRequest: () => 'live',
        billingConfigured: () => true,
        accountDeletionPending: vi.fn(async () => deletion),
        customerFor: vi.fn(async () => 'cus_1'),
        createSession: vi.fn(async (customerId: string) => `https://billing.stripe.test/session/${customerId}`),
        appOrigin: () => 'https://cleffy.io',
        logError: (code) => errors.push(code),
    };
    return { deps, errors };
};

const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe('stripe-portal', () => {
    it('opens a portal session for the caller’s customer, returning to Settings', async () => {
        const { deps } = harness();
        const response = await handlePortal(post(), deps);
        expect(response.status).toBe(200);
        expect(await body(response)).toEqual({ url: 'https://billing.stripe.test/session/cus_1' });
        expect(deps.accountDeletionPending).toHaveBeenCalledWith(USER);
        expect(deps.createSession).toHaveBeenCalledWith('cus_1', 'live', 'https://cleffy.io/settings');
    });

    it('refuses with 409 while the account is being deleted: no customer looked up, no session opened', async () => {
        const { deps } = harness('pending');
        const response = await handlePortal(post(), deps);
        expect(response.status).toBe(409);
        expect(await body(response)).toEqual(PORTAL_DELETION_PENDING);
        expect(deps.customerFor).not.toHaveBeenCalled();
        expect(deps.createSession).not.toHaveBeenCalled();
    });

    it('refuses with 503 and a retry when the check cannot be answered: nothing opened', async () => {
        const { deps, errors } = harness('unknown');
        const response = await handlePortal(post(), deps);
        expect(response.status).toBe(503);
        expect(await body(response)).toEqual(PORTAL_DELETION_CHECK_UNAVAILABLE);
        expect(deps.customerFor).not.toHaveBeenCalled();
        expect(deps.createSession).not.toHaveBeenCalled();
        expect(errors).toContain('portal_deletion_check_failed');
    });

    it('answers with the codes every other writer refuses with', () => {
        expect(PORTAL_DELETION_PENDING.code).toBe(ACCOUNT_DELETION_PENDING.code);
        expect(PORTAL_DELETION_CHECK_UNAVAILABLE.code).toBe(DELETION_CHECK_UNAVAILABLE.code);
        expect(PORTAL_DELETION_CHECK_UNAVAILABLE.retryAfterSec).toBe(DELETION_CHECK_UNAVAILABLE.retryAfterSec);
    });

    it('asks only once the caller is known, and not before the rate limit or for a refused caller', async () => {
        const { deps } = harness('pending');
        deps.authenticate = vi.fn(async () => json({ error: 'Student accounts are managed by your teacher' }, 403));
        expect((await handlePortal(post(), deps)).status).toBe(403);
        expect(deps.accountDeletionPending).not.toHaveBeenCalled();
    });

    it('a caller who never subscribed has nothing to manage', async () => {
        const { deps } = harness();
        deps.customerFor = vi.fn(async () => null);
        const response = await handlePortal(post(), deps);
        expect(response.status).toBe(404);
        expect(await body(response)).toMatchObject({ code: 'no_customer' });
    });

    it('a Stripe failure is a 502, logged', async () => {
        const { deps, errors } = harness();
        deps.createSession = vi.fn(async () => {
            throw new Error('Stripe is down');
        });
        const response = await handlePortal(post(), deps);
        expect(response.status).toBe(502);
        expect(errors).toContain('portal_failed');
    });
});

describe('stripe-portal/index.ts is wiring only', () => {
    const source = readFileSync(resolve(process.cwd(), 'supabase/functions/stripe-portal/index.ts'), 'utf8');

    it('serves handlePortal', () => {
        expect(source).toMatch(/Deno\.serve\(\(req\) =>\s*\n\s*handlePortal\(req, \{/);
    });

    it('asks account_deletion_pending() for the caller, and a failed check is `unknown` (decision 71(6))', () => {
        const port = source.slice(source.indexOf('accountDeletionPending: async (userId) =>'));
        expect(port.slice(0, 600)).toContain('await accountDeletionPending(admin, userId)');
        expect(port.slice(0, 600)).toMatch(/if \(!pending\.ok\) \{[\s\S]{0,200}?return 'unknown';/);
        expect(port.slice(0, 600)).toContain("return pending.pending ? 'pending' : 'clear';");
    });

    it('still refuses anonymous callers and students before anything else', () => {
        const auth = source.slice(source.indexOf('authenticate: async (request) =>'));
        expect(auth.slice(0, 700)).toContain('rejectAnonymous(auth.caller)');
        expect(auth.slice(0, 700)).toContain('rejectStudent(auth.caller)');
    });
});
