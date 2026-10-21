// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    ALERT_AFTER_ATTEMPTS,
    cancellationMailKey,
    type ConfirmationDeps,
    type Delivery,
    deliverCancellationConfirmation,
    deliverPurchaseConfirmation,
    drainBillingMail,
    OUTBOX_BATCH,
    OUTBOX_MAX_ROUNDS,
    type OutboxDeps,
    type OutboxRow,
    type PurchaseMail,
    retryDelayMs,
} from '../../supabase/functions/_shared/billingOutbox';
import * as billingTerms from '../../supabase/functions/_shared/billingTerms';

/**
 * The billing mail outbox (Codex findings 3 and 4 on #62), run against an
 * in-memory `billing_mail_outbox` that models claim_billing_mail's leases and
 * settle_billing_mail's claim-token scoping.
 *
 * What it has to show: a confirmation is never lost to a failed send or a
 * worker that dies holding it -- it is retried, with backoff, until it goes
 * out -- and it is never sent twice.
 */

const MINUTE = 60_000;

interface StoredRow extends OutboxRow {
    status: 'pending' | 'sent';
    dueAt: number;
    claimedUntil: number | null;
    lastError: string | null;
}

class FakeOutbox {
    rows: StoredRow[] = [];
    clock = 0;
    tokens = 0;

    add(kind: OutboxRow['kind'], payload: Record<string, unknown>): StoredRow {
        const row: StoredRow = {
            id: `mail-${this.rows.length + 1}`,
            kind,
            mode: 'live',
            payload,
            attempts: 0,
            claimToken: '',
            createdAt: new Date(this.clock).toISOString(),
            status: 'pending',
            dueAt: this.clock,
            claimedUntil: null,
            lastError: null,
        };
        this.rows.push(row);
        return row;
    }

    claim = (limit: number, leaseMs = 2 * MINUTE): OutboxRow[] => {
        const due = this.rows
            .filter(
                (row) =>
                    row.status === 'pending' &&
                    row.dueAt <= this.clock &&
                    (row.claimedUntil === null || row.claimedUntil < this.clock),
            )
            .slice(0, limit);
        return due.map((row) => {
            row.claimToken = `claim-${++this.tokens}`;
            row.claimedUntil = this.clock + leaseMs;
            row.attempts += 1;
            return { ...row, payload: row.payload };
        });
    };

    settle = (claimed: OutboxRow, delivery: Delivery, retryAfterMs: number): boolean => {
        const row = this.rows.find((candidate) => candidate.id === claimed.id);
        if (!row || row.claimToken !== claimed.claimToken) {
            return false;
        }
        if (delivery.outcome === 'sent' && row.kind !== 'cancel_link') {
            row.status = 'sent';
            row.claimedUntil = null;
        } else if (delivery.outcome === 'retry') {
            row.claimedUntil = null;
            row.lastError = delivery.reason;
            row.dueAt = this.clock + retryAfterMs;
        } else {
            this.rows = this.rows.filter((candidate) => candidate !== row);
        }
        return true;
    };
}

const harness = (deliver: (row: OutboxRow) => Promise<Delivery>) => {
    const outbox = new FakeOutbox();
    const logs: string[] = [];
    const errors: string[] = [];
    const deps: OutboxDeps = {
        claim: async (limit) => outbox.claim(limit),
        settle: async (row, delivery, retryAfterMs) => outbox.settle(row, delivery, retryAfterMs),
        deliver: vi.fn(deliver),
        log: (message) => logs.push(message),
        logError: (code) => errors.push(code),
    };
    return { outbox, deps, logs, errors };
};

const PURCHASE: PurchaseMail = {
    userId: 'teacher-9',
    sessionId: 'cs_9',
    subscriptionId: 'sub_9',
    consentId: 'consent-1',
    priceId: 'price_academy_annual',
    billingCountry: 'DE',
    currency: 'eur',
    amountTotalMinor: 2100,
    amountTaxMinor: 335,
    renewsAt: '2027-01-15T08:00:00.000Z',
    purchasedAt: '2026-10-21T08:00:00.000Z',
    termsVersion: '2026-10-01-consented',
    refundsVersion: '2026-10-01-refunds-consented',
};

describe('draining the billing mail outbox', () => {
    it('sends what is due and keeps the record that it went', async () => {
        const h = harness(async () => ({ outcome: 'sent' }));
        h.outbox.add('purchase_confirmation', { ...PURCHASE });

        expect(await drainBillingMail(h.deps)).toEqual({ claimed: 1, sent: 1, done: 0, retried: 0 });
        expect(h.outbox.rows[0]?.status).toBe('sent');
        // Sent once: a second drain finds nothing due.
        expect(await drainBillingMail(h.deps)).toEqual({ claimed: 0, sent: 0, done: 0, retried: 0 });
        expect(h.deps.deliver).toHaveBeenCalledTimes(1);
    });

    it('retries a failed send with backoff until it goes out, never dropping it', async () => {
        let resendUp = false;
        const h = harness(async () => (resendUp ? { outcome: 'sent' } : { outcome: 'retry', reason: 'resend failed' }));
        h.outbox.add('purchase_confirmation', { ...PURCHASE });

        for (let attempt = 1; attempt <= ALERT_AFTER_ATTEMPTS + 1; attempt += 1) {
            await drainBillingMail(h.deps);
            const row = h.outbox.rows[0];
            expect(row?.status).toBe('pending');
            expect(row?.dueAt).toBe(h.outbox.clock + retryDelayMs(attempt));
            // Not due again until the backoff is over.
            expect((await drainBillingMail(h.deps)).claimed).toBe(0);
            h.outbox.clock = row?.dueAt ?? 0;
        }
        // Past the threshold, every further failure is an ALERT a human sees.
        expect(h.logs.filter((line) => line.startsWith('ALERT'))).toHaveLength(2);

        resendUp = true;
        await drainBillingMail(h.deps);
        expect(h.outbox.rows[0]?.status).toBe('sent');
    });

    it('caps the backoff at six hours', () => {
        expect(retryDelayMs(1)).toBe(MINUTE);
        expect(retryDelayMs(2)).toBe(2 * MINUTE);
        expect(retryDelayMs(30)).toBe(6 * 60 * MINUTE);
    });

    it('turns a deliverer that throws into a retry rather than a lost mail', async () => {
        const h = harness(async () => {
            throw new Error('could not read the account email: connection reset');
        });
        h.outbox.add('cancellation_confirmation', { userId: 'teacher-1' });

        expect(await drainBillingMail(h.deps)).toMatchObject({ retried: 1 });
        expect(h.outbox.rows[0]?.lastError).toContain('connection reset');
    });

    it('picks up a mail whose worker died holding it, once the lease runs out, and sends it once', async () => {
        // Codex finding 3: a crash after claiming a notice in billing_notices
        // left a claim nobody would ever release, and the mail was never sent.
        const h = harness(async () => ({ outcome: 'sent' }));
        h.outbox.add('purchase_confirmation', { ...PURCHASE });
        const dead = h.outbox.claim(OUTBOX_BATCH);
        expect(dead).toHaveLength(1);

        // Inside the lease the row is the dead worker's.
        expect((await drainBillingMail(h.deps)).claimed).toBe(0);

        h.outbox.clock += 2 * MINUTE + 1;
        expect(await drainBillingMail(h.deps)).toMatchObject({ claimed: 1, sent: 1 });
        // And the dead worker, were it to come back, cannot settle a row that
        // is no longer its own.
        expect(h.outbox.settle(dead[0] as OutboxRow, { outcome: 'retry', reason: 'late' }, MINUTE)).toBe(false);
        expect(h.outbox.rows[0]?.status).toBe('sent');
        expect(h.deps.deliver).toHaveBeenCalledTimes(1);
    });

    it('stops after a bounded number of rounds however much is queued', async () => {
        const h = harness(async () => ({ outcome: 'sent' }));
        for (let i = 0; i < OUTBOX_BATCH * (OUTBOX_MAX_ROUNDS + 2); i += 1) {
            h.outbox.add('purchase_confirmation', { ...PURCHASE, sessionId: `cs_${i}` });
        }
        expect((await drainBillingMail(h.deps)).sent).toBe(OUTBOX_BATCH * OUTBOX_MAX_ROUNDS);
    });

    it('never throws, even when the outbox cannot be read', async () => {
        const h = harness(async () => ({ outcome: 'sent' }));
        h.deps.claim = async () => {
            throw new Error('connection reset');
        };
        expect(await drainBillingMail(h.deps)).toEqual({ claimed: 0, sent: 0, done: 0, retried: 0 });
        expect(h.errors).toEqual(['billing_outbox_claim_failed']);
    });
});

describe('the confirmations the outbox sends', () => {
    const confirmation = (overrides: Partial<ConfirmationDeps> = {}) => {
        const sent: Array<{ to: string; subject: string; text: string; tag: string }> = [];
        const logs: string[] = [];
        const deps: ConfirmationDeps = {
            emailOfUser: async () => 'ada@example.com',
            sendEmail: async (to, message, options) => {
                sent.push({ to, subject: message.subject, text: message.text, tag: options.tag });
                return 'sent';
            },
            slotForPrice: (priceId) => (priceId === 'price_academy_annual' ? 'academyAnnual' : null),
            storefrontOrigin: () => 'https://cleffy.io',
            terms: billingTerms,
            log: (message) => logs.push(message),
            ...overrides,
        };
        return { deps, sent, logs };
    };
    const row = (kind: OutboxRow['kind'], payload: Record<string, unknown>): OutboxRow => ({
        id: 'mail-1',
        kind,
        mode: 'live',
        payload,
        attempts: 1,
        claimToken: 'claim-1',
        createdAt: '2026-10-21T08:00:00.000Z',
    });

    it('names the policy versions the buyer consented under, not the ones deployed now', async () => {
        // Codex minor 2 on #62.
        const h = confirmation();
        expect(await deliverPurchaseConfirmation(h.deps, row('purchase_confirmation', { ...PURCHASE }))).toEqual({
            outcome: 'sent',
        });
        expect(h.sent[0]?.to).toBe('ada@example.com');
        expect(h.sent[0]?.text).toContain('version 2026-10-01-consented');
        expect(h.sent[0]?.text).toContain('version 2026-10-01-refunds-consented');
        expect(h.sent[0]?.text).not.toContain(billingTerms.LEGAL_VERSIONS.terms);
    });

    it('falls back to the published versions when no consent was found', async () => {
        const h = confirmation();
        await deliverPurchaseConfirmation(
            h.deps,
            row('purchase_confirmation', { ...PURCHASE, termsVersion: null, refundsVersion: null }),
        );
        expect(h.sent[0]?.text).toContain(`version ${billingTerms.LEGAL_VERSIONS.terms}`);
    });

    it('waits, rather than giving up, for a send that failed or a Resend key that is missing', async () => {
        for (const outcome of ['failed', 'unconfigured'] as const) {
            const h = confirmation({ sendEmail: async () => outcome });
            expect(await deliverPurchaseConfirmation(h.deps, row('purchase_confirmation', { ...PURCHASE }))).toEqual({
                outcome: 'retry',
                reason: `resend ${outcome}`,
            });
        }
    });

    it('waits for configuration, rather than giving up, on a price it does not know', async () => {
        const h = confirmation({ slotForPrice: () => null });
        expect(await deliverPurchaseConfirmation(h.deps, row('purchase_confirmation', { ...PURCHASE }))).toMatchObject({
            outcome: 'retry',
        });
        expect(h.sent).toEqual([]);
    });

    it('settles a confirmation for an account with no address loudly, not silently', async () => {
        const h = confirmation({ emailOfUser: async () => null });
        expect(
            await deliverCancellationConfirmation(
                h.deps,
                row('cancellation_confirmation', {
                    userId: 'gone',
                    subscriptionId: 'sub_1',
                    priceId: null,
                    endsAt: null,
                    cancelledAt: '2026-10-21T08:00:00.000Z',
                }),
            ),
        ).toEqual({ outcome: 'done', reason: 'no_address' });
        expect(h.logs.some((line) => line.startsWith('ALERT'))).toBe(true);
    });

    it('sends the cancellation confirmation, keyed once per subscription and end date', async () => {
        const h = confirmation();
        const notice = {
            userId: 'teacher-1',
            subscriptionId: 'sub_1',
            priceId: 'price_academy_annual',
            endsAt: '2027-01-15T08:00:00.000Z',
            cancelledAt: '2026-10-21T08:00:00.000Z',
        };
        expect(await deliverCancellationConfirmation(h.deps, row('cancellation_confirmation', notice))).toEqual({
            outcome: 'sent',
        });
        expect(h.sent[0]?.tag).toBe('cancellation_confirmation');
        expect(cancellationMailKey(notice)).toBe('sub_1:2027-01-15T08:00:00.000Z');
    });
});

describe('the outbox wiring', () => {
    const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

    it('records webhook notices into the outbox and sends them after the response', () => {
        const webhook = read('supabase/functions/stripe-webhook/index.ts');
        expect(webhook).toContain("enqueueBillingMail('purchase_confirmation', notice.sessionId, mode");
        expect(webhook).toContain("enqueueBillingMail('cancellation_confirmation', cancellationMailKey(notice), mode");
        expect(webhook).toContain('drainInBackground()');
        // No send in the webhook itself any more.
        expect(webhook).not.toContain('sendBillingEmail');
    });

    it('has a retry path the cron can reach, behind a shared secret', () => {
        const fn = read('supabase/functions/billing-mail-outbox/index.ts');
        expect(fn).toContain("req.headers.get('x-billing-outbox-secret')");
        expect(fn).toContain("Deno.env.get('BILLING_OUTBOX_SECRET')");
        expect(read('supabase/config.toml')).toMatch(/\[functions\.billing-mail-outbox\]\s*\nverify_jwt = false/);
        const migration = read('supabase/migrations/20261020160200_billing_mail_outbox.sql');
        expect(migration).toContain("'x-billing-outbox-secret', v_secret");
        expect(migration).toMatch(/cron\.schedule \('billing-mail-outbox'/);
        expect(migration).toMatch(/for update skip locked/);
    });
});
