import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Launch-fix item 16, decision 70(1): what every queue and cache writer does
 * for an account whose deletion is pending, pinned so a writer cannot change
 * sides unnoticed. The behaviour of each refusal is tested beside its flow
 * (webhook.test.ts, cancelFlow.test.ts, guestEmail.test.ts,
 * deletionPendingWiring.test.ts); this file holds the classification.
 *
 *  * keep -- legally required, or the account's own billing record: content
 *    reports and the moderation queue, the content notices to uploaders,
 *    receipts and cancellation confirmations (and the cancel-link requests that
 *    lead to the refund request), district retention notices, inbound support
 *    mail. These never ask.
 *  * refuse -- user-originated writes nothing requires: guest email
 *    verification (both halves). These ask account_deletion_pending() first.
 *  * unchanged -- caches that are not user data (IMSLP, the OMR score cache)
 *    and user-keyed quota and rate counters, which cascade with the account.
 *    These never ask.
 */
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const asks = (source: string) => /accountDeletionPending\(/.test(source);

const KEEP = [
    'supabase/functions/content-report/index.ts',
    'supabase/functions/content-moderation/index.ts',
    'supabase/functions/content-notices/index.ts',
    'supabase/functions/_shared/contentReports.ts',
    'supabase/functions/_shared/contentReportsWiring.ts',
    'supabase/functions/billing-mail-outbox/index.ts',
    'supabase/functions/_shared/billingMailWorker.ts',
    'supabase/functions/_shared/billingMail.ts',
    'supabase/functions/_shared/billingOutbox.ts',
    'supabase/functions/district-retention-notices/index.ts',
    'supabase/functions/_shared/districtNotice.ts',
    'supabase/functions/resend-inbound/index.ts',
    'supabase/functions/_shared/supportMail.ts',
];

const UNCHANGED = [
    'supabase/functions/imslp-search/index.ts',
    'supabase/functions/imslp-work/index.ts',
    'supabase/functions/imslp-sync/index.ts',
    'supabase/functions/analyze-annotations/index.ts',
    'supabase/functions/analyze-notes/index.ts',
    'supabase/functions/student-login/index.ts',
    'supabase/functions/_shared/quota.ts',
    'supabase/functions/_shared/rateLimit.ts',
    'supabase/functions/_shared/loginThrottle.ts',
];

describe('deletion-pending policy per writer (launch-fix item 16, decision 70(1))', () => {
    it.each(KEEP)('keeps %s: legally required or the billing record, never refused', (path) => {
        expect(asks(read(path))).toBe(false);
    });

    it.each(UNCHANGED)('leaves %s alone: a cache or a counter that cascades', (path) => {
        expect(asks(read(path))).toBe(false);
    });

    it('refuses new guest email verification, both halves, before anything is stored, mailed or tried', () => {
        const flow = read('supabase/functions/_shared/guestEmail.ts');
        const start = flow.slice(flow.indexOf('export const handleGuestEmailStart'));
        const confirm = flow.slice(flow.indexOf('export const handleGuestEmailConfirm'));
        for (const [body, first] of [
            [start, 'await deps.emailTaken('],
            [start, 'await deps.savePending('],
            [start, 'await deps.sendEmail('],
            [confirm, 'await deps.checkCode('],
            [confirm, 'await deps.attach('],
        ] as const) {
            const at = body.indexOf('await deletionRefusal(deps, userId)');
            expect(at, first).toBeGreaterThan(-1);
            expect(body.indexOf(first), first).toBeGreaterThan(at);
        }
        // Both functions get the port from the shared wiring, which asks the one predicate.
        const wiring = read('supabase/functions/_shared/guestEmailWiring.ts');
        const port = wiring.slice(wiring.indexOf('accountDeletionPending: async (userId: string)'));
        expect(port.slice(0, 600)).toContain('await accountDeletionPending(admin, userId)');
        expect(port.slice(0, 600)).toMatch(/if \(!pending\.ok\) \{[\s\S]{0,200}?return 'unknown';/);
        for (const fn of ['guest-email-start', 'guest-email-confirm']) {
            expect(read(`supabase/functions/${fn}/index.ts`)).toContain('...common,');
        }
    });

    it('stripe-webhook refuses (503, claim released) and billing-cancel leaves Stripe alone but sends the refund request', () => {
        const events = read('supabase/functions/_shared/stripeEvents.ts');
        expect(events).toContain('const deletionRefusal = async (');
        expect(events).toMatch(/await store\.releaseEvent\(event\.id\);\s+return \{\s+status: 503,/);
        const cancel = read('supabase/functions/_shared/cancelFlow.ts');
        const pending = cancel.slice(cancel.indexOf('const deletionPendingCancel = async'));
        expect(pending.slice(0, 400)).toContain('await requestRefund(deps, body, resolved, mirrored, true)');
        expect(pending.slice(0, 400)).not.toContain('cancelAtPeriodEnd');
        expect(pending.slice(0, 400)).not.toContain('consumeToken');
    });
});
