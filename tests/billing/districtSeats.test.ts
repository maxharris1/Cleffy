import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    DISTRICT_PLAN_METADATA,
    endedAtOf,
    handleStripeEvent,
    isDistrictSubscription,
    SUBSCRIPTION_MISSING,
    subscriptionRowFrom,
    type StripeEventLike,
    type StripeSubscriptionLike,
    type SubscriptionUpsert,
    type WebhookStore,
} from '../../supabase/functions/_shared/stripeEvents';

/**
 * District seats (migration 20261020180400_district_seat_overrides.sql).
 *
 * A district is an Academy sold on a custom quote through Stripe Invoicing
 * (collection_method = send_invoice), with an admin-set seat count above
 * Academy's 5. The behaviour of the override itself -- honoured by the seat
 * trigger, lapsing with the subscription, logged, admin-only -- is proven
 * against Postgres by tests/sql/district_seats.sql. What CI holds here, without
 * a database:
 *
 *  * the webhook maps a district subscription to Academy and records how it is
 *    collected, which is the fact the override is tied to;
 *  * nothing in the webhook can reach the override, so no Stripe event can reset
 *    it;
 *  * the migration's grants keep every admin function and both tables away from
 *    signed-in users.
 *
 * Resolved from the project root: the jsdom test environment gives import.meta a
 * non-file URL, so fileURLToPath cannot be used here.
 */

const PRICE_TIERS = {
    price_teacher_annual: 'teacher',
    price_academy_monthly: 'academy',
    price_academy_annual: 'academy',
} as const;

const DISTRICT_METADATA = { user_id: 'owner-1', [DISTRICT_PLAN_METADATA.key]: DISTRICT_PLAN_METADATA.value };

/** A district contract as Max would create it: Invoicing, a quoted price, marked. */
const districtSubscription = (overrides: Partial<StripeSubscriptionLike> = {}): StripeSubscriptionLike => ({
    id: 'sub_district',
    status: 'active',
    customer: 'cus_district',
    collection_method: 'send_invoice',
    current_period_end: 1_800_000_000,
    items: { data: [{ price: { id: 'price_quote_district_2026' } }] },
    metadata: DISTRICT_METADATA,
    ...overrides,
});

describe('the webhook maps a district contract', () => {
    it('to Academy, recording send_invoice, though its quoted price is in no catalogue', () => {
        const row = subscriptionRowFrom(districtSubscription(), 'owner-1', PRICE_TIERS);
        expect(row.tier).toBe('academy');
        expect(row.collection_method).toBe('send_invoice');
        expect(row.price_id).toBe('price_quote_district_2026');
    });

    it('not from the metadata alone: a card-paid subscription marked district stays free', () => {
        const sub = districtSubscription({ collection_method: 'charge_automatically' });
        expect(isDistrictSubscription(sub)).toBe(false);
        const row = subscriptionRowFrom(sub, 'owner-1', PRICE_TIERS);
        expect(row.tier).toBe('free');
        expect(row.collection_method).toBe('charge_automatically');
    });

    it('not from send_invoice alone: an unmarked invoiced subscription stays free', () => {
        const sub = districtSubscription({ metadata: { user_id: 'owner-1' } });
        expect(isDistrictSubscription(sub)).toBe(false);
        expect(subscriptionRowFrom(sub, 'owner-1', PRICE_TIERS).tier).toBe('free');
    });

    it('to Academy while past due, so the grace period has a plan to honour', () => {
        const row = subscriptionRowFrom(districtSubscription({ status: 'past_due' }), 'owner-1', PRICE_TIERS);
        expect(row.tier).toBe('academy');
        expect(row.collection_method).toBe('send_invoice');
    });

    it('to free once it has ended or gone unpaid (decision 25: unpaid is not paying), whatever the collection method', () => {
        for (const status of ['unpaid', 'canceled', 'incomplete_expired', 'incomplete']) {
            expect(subscriptionRowFrom(districtSubscription({ status }), 'owner-1', PRICE_TIERS).tier, status).toBe(
                'free',
            );
        }
    });

    // Decisions 21 and 25 (Codex round-4 review of #61, new major 1): past-due
    // grace is the same for card and Stripe Invoicing Academy billing, so a
    // card-paid Academy past due keeps naming Academy -- subscription_is_live()
    // decides how long it pays (30 days from when past_due was first recorded).
    it('to Academy while a card-paid Academy is past due: the same grace as Stripe Invoicing', () => {
        const card = districtSubscription({
            status: 'past_due',
            collection_method: 'charge_automatically',
            metadata: { user_id: 'owner-1' },
            items: { data: [{ price: { id: 'price_academy_monthly' } }] },
        });
        expect(subscriptionRowFrom(card, 'owner-1', PRICE_TIERS).tier).toBe('academy');
    });

    it('to free once that card-paid Academy goes unpaid', () => {
        const card = districtSubscription({
            status: 'unpaid',
            collection_method: 'charge_automatically',
            metadata: { user_id: 'owner-1' },
            items: { data: [{ price: { id: 'price_academy_monthly' } }] },
        });
        expect(subscriptionRowFrom(card, 'owner-1', PRICE_TIERS).tier).toBe('free');
    });

    it('to free while a card Teacher plan is past due: only Academy and Stripe Invoicing get grace', () => {
        const card = districtSubscription({
            status: 'past_due',
            collection_method: 'charge_automatically',
            metadata: { user_id: 'owner-1' },
            items: { data: [{ price: { id: 'price_teacher_annual' } }] },
        });
        expect(subscriptionRowFrom(card, 'owner-1', PRICE_TIERS).tier).toBe('free');
    });

    it('by its price when that price is in the catalogue', () => {
        const sub = districtSubscription({ items: { data: [{ price: { id: 'price_teacher_annual' } }] } });
        expect(subscriptionRowFrom(sub, 'owner-1', PRICE_TIERS).tier).toBe('teacher');
    });

    it('leaves collection_method null when Stripe did not say, so the write keeps the stored one', () => {
        const { collection_method: _omitted, ...withoutMethod } = districtSubscription();
        void _omitted;
        expect(subscriptionRowFrom(withoutMethod, 'owner-1', PRICE_TIERS).collection_method).toBeNull();
    });
});

/** Just enough of the webhook's store to watch what a district event writes. */
const storeFor = (remote: StripeSubscriptionLike, customers = new Map<string, string>()) => {
    const written: SubscriptionUpsert[] = [];
    const logs: string[] = [];
    const done = new Set<string>();
    const store: WebhookStore = {
        claimEvent: async (id) => (done.has(id) ? 'done' : 'claimed'),
        markEventDone: async (id) => {
            done.add(id);
        },
        // billing_customers, keyed by customer: what stripe-portal resolves the
        // owner's customer from.
        userIdForCustomer: async (customerId) => customers.get(customerId) ?? null,
        linkCustomer: async (customerId, userId) => {
            for (const [mapped, user] of customers) {
                if (user === userId) {
                    customers.delete(mapped); // one customer per user and mode
                }
            }
            customers.set(customerId, userId);
        },
        upsertSubscription: async (row) => {
            written.push(row);
            return { outcome: 'written' };
        },
        fetchSubscription: async (id) => (id === remote.id ? remote : SUBSCRIPTION_MISSING),
        userIdForSubscription: async () => null,
        storedStatusOf: async () => written.at(-1)?.status ?? null,
        applyFreeTierArchival: async () => {},
        restorePlanArchivedScores: async () => {},
        releaseEvent: async () => {},
        lockSubscription: async () => 'holder-1',
        unlockSubscription: async () => {},
        cancelDuplicateSubscription: async () => ({ stopped: true, refund: 'nothing_to_refund', detail: '' }),
        pendingDuplicateUndo: async () => null,
        recordPendingDuplicateUndo: async () => {},
        settleDuplicateUndo: async () => {},
        recordPurchaseNotice: async () => {},
        recordCancellationNotice: async () => {},
        accountDeletionPending: async () => 'clear',
        log: (message) => {
            logs.push(message);
        },
    };
    return { store, written, customers, logs };
};

const event = (id: string, type: string, object: unknown): StripeEventLike => ({
    id,
    type,
    created: 1_760_000_000,
    livemode: false,
    data: { object },
});

describe('a send_invoice subscription grants entitlement through the webhook', () => {
    it('on customer.subscription.created, attributed by its metadata (no Checkout ever linked the customer)', async () => {
        const sub = districtSubscription();
        const { store, written } = storeFor(sub);

        const result = await handleStripeEvent(
            event('evt_created', 'customer.subscription.created', sub),
            store,
            PRICE_TIERS,
        );

        expect(result.status).toBe(200);
        expect(written).toEqual([
            expect.objectContaining({
                stripe_subscription_id: 'sub_district',
                user_id: 'owner-1',
                tier: 'academy',
                status: 'active',
                collection_method: 'send_invoice',
            }),
        ]);
    });

    it('on invoice.paid, reading the subscription back', async () => {
        const sub = districtSubscription();
        const { store, written } = storeFor(sub);

        const result = await handleStripeEvent(
            event('evt_paid', 'invoice.paid', { customer: 'cus_district', subscription: 'sub_district' }),
            store,
            PRICE_TIERS,
        );

        expect(result.status).toBe(200);
        expect(written.at(-1)).toMatchObject({ tier: 'academy', collection_method: 'send_invoice' });
    });
});

/** stripe-portal's lookup: the customer billing_customers maps the user to. */
const portalCustomerOf = (customers: Map<string, string>, userId: string): string | null =>
    [...customers].find(([, user]) => user === userId)?.[0] ?? null;

describe('an invoice-created district links its billing customer (Codex #61 minor 1)', () => {
    it('so the owner’s billing portal finds the district’s customer', async () => {
        const sub = districtSubscription();
        const { store, customers } = storeFor(sub);

        await handleStripeEvent(event('evt_created', 'customer.subscription.created', sub), store, PRICE_TIERS);

        expect(portalCustomerOf(customers, 'owner-1')).toBe('cus_district');
    });

    it('replacing an older customer of the owner’s own, so the portal opens the district account', async () => {
        const sub = districtSubscription();
        const { store, customers } = storeFor(sub, new Map([['cus_old_card', 'owner-1']]));

        await handleStripeEvent(event('evt_created', 'customer.subscription.created', sub), store, PRICE_TIERS);

        expect(portalCustomerOf(customers, 'owner-1')).toBe('cus_district');
    });

    it('but never moving a customer already linked to someone else', async () => {
        const sub = districtSubscription();
        const { store, customers, logs } = storeFor(sub, new Map([['cus_district', 'someone-else']]));

        const result = await handleStripeEvent(
            event('evt_created', 'customer.subscription.created', sub),
            store,
            PRICE_TIERS,
        );

        expect(result.status).toBe(200);
        expect(customers.get('cus_district')).toBe('someone-else');
        expect(logs.some((line) => /already linked to another user/.test(line))).toBe(true);
    });

    it('and links nothing for a subscription that is not a district', async () => {
        const card = districtSubscription({ collection_method: 'charge_automatically' });
        const { store, customers } = storeFor(card);

        await handleStripeEvent(event('evt_created', 'customer.subscription.created', card), store, PRICE_TIERS);

        expect(customers.size).toBe(0);
    });
});

const read = (...segments: string[]): string => readFileSync(resolve(process.cwd(), ...segments), 'utf8');

describe('the webhook records when a district actually ended (Codex #61 round 2, major 3)', () => {
    // The district's contract end -- and the retention purge counted from it --
    // is derived from this and nothing else Stripe sends.
    const AT = (iso: string) => Date.parse(iso) / 1000;

    it('nothing while the subscription is live, however its cancellation is scheduled', () => {
        expect(endedAtOf(districtSubscription({ cancel_at_period_end: true }))).toBeNull();
        expect(endedAtOf(districtSubscription({ cancel_at: AT('2027-10-21T00:00:00Z') }))).toBeNull();
        expect(
            endedAtOf(districtSubscription({ status: 'past_due', cancel_at: AT('2027-10-21T00:00:00Z') })),
        ).toBeNull();
    });

    it('Stripe’s ended_at once it has ended -- not the scheduled date, not the period end', () => {
        const sub = districtSubscription({
            status: 'canceled',
            cancel_at: AT('2027-10-21T00:00:00Z'),
            ended_at: AT('2026-10-21T12:00:00Z'),
            current_period_end: AT('2027-01-01T00:00:00Z'),
        });
        expect(endedAtOf(sub)).toBe('2026-10-21T12:00:00.000Z');
        expect(subscriptionRowFrom(sub, 'owner-1', PRICE_TIERS).ended_at).toBe('2026-10-21T12:00:00.000Z');
    });

    it('the cancel_at it ended on, when the object lacks ended_at and its status confirms it', () => {
        const sub = districtSubscription({ status: 'canceled', cancel_at: AT('2026-09-30T00:00:00Z') });
        expect(endedAtOf(sub)).toBe('2026-09-30T00:00:00.000Z');
    });

    it('never a billing-period date, even with nothing else to go on', () => {
        const sub = districtSubscription({ status: 'canceled', current_period_end: AT('2026-07-01T00:00:00Z') });
        expect(endedAtOf(sub)).toBeNull();
        expect(
            endedAtOf(districtSubscription({ status: 'incomplete_expired', ended_at: AT('2026-10-01T00:00:00Z') })),
        ).toBe('2026-10-01T00:00:00.000Z');
    });

    it('is passed to the subscription write', () => {
        expect(read('supabase/functions/stripe-webhook/index.ts')).toMatch(/p_ended_at:\s*row\.ended_at/);
    });
});

describe('no Stripe event can reset a seat override', () => {
    const webhookSources = [
        read('supabase/functions/stripe-webhook/index.ts'),
        read('supabase/functions/_shared/stripeEvents.ts'),
        read('supabase/functions/_shared/stripe.ts'),
    ];

    it('the webhook never names the override, its log, the admin functions or a seat limit', () => {
        for (const source of webhookSources) {
            expect(source).not.toMatch(/studio_seat_override|admin_(?:set|clear)_studio_seat_override|seat_limit/);
        }
    });

    it('the webhook passes collection_method to the subscription write', () => {
        expect(webhookSources[0]).toMatch(/p_collection_method:\s*row\.collection_method/);
    });

    it('Checkout never creates what a district is made of', () => {
        // The district rule is only safe because no customer can produce a
        // send_invoice subscription carrying the district marking.
        const checkout =
            read('supabase/functions/_shared/checkoutFlow.ts') + read('supabase/functions/stripe-checkout/index.ts');
        expect(checkout).not.toMatch(/send_invoice|collection_method|cleffy_plan/);
    });
});

const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');
const MIGRATION = '20261020180400_district_seat_overrides.sql';

/** The text of the last migration that (re)defines `fn`, as limitsInSync reads it. */
const latestDefining = (fn: string): { name: string; sql: string } => {
    const pattern = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, 'i');
    const latest = readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql') && !/imslp_works_catalog/.test(name))
        .sort()
        .map((name) => ({ name, sql: readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8') }))
        .filter((m) => pattern.test(m.sql))
        .at(-1);
    if (!latest) {
        throw new Error(`no migration defines ${fn}()`);
    }
    return latest;
};

const definition = (sql: string, fn: string): string => {
    const start = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, 'i'));
    const bodyOpen = sql.indexOf('$$', start);
    return sql.slice(start, sql.indexOf('$$', bodyOpen + 2) + 2);
};

const granted = (sql: string, fn: string, role: string): boolean =>
    new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s+to\\s+${role}\\s*;`, 'i').test(
        sql,
    );

const revoked = (sql: string, fn: string, role: string): boolean =>
    new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s+from\\s+${role}\\s*;`, 'i').test(
        sql,
    );

describe('the district-seats migration', () => {
    it('makes the seat trigger read the effective limit, and is the definition that counts', () => {
        const latest = latestDefining('studios_enforce_seat_limit');
        expect(latest.name).toBe(MIGRATION);
        const def = definition(latest.sql, 'studios_enforce_seat_limit');
        expect(def).toMatch(/public\.studio_effective_seat_limit\s*\(new\.studio_id\)/i);
        expect(def).toMatch(/pg_advisory_xact_lock/i);
        expect(def).not.toMatch(/select\s+st\.seat_limit\s+into/i);
    });

    it('honours an override only for the owner’s live send_invoice Academy subscription', () => {
        const def = definition(latestDefining('studio_effective_seat_limit').sql, 'studio_effective_seat_limit');
        expect(def).toMatch(/s\.user_id\s*=\s*st\.owner_id/i);
        expect(def).toMatch(/s\.collection_method\s*=\s*'send_invoice'/i);
        expect(def).toMatch(/s\.tier\s*=\s*'academy'/i);
        expect(def).toMatch(/public\.subscription_is_live\s*\(s\)/i);

        // Live: the mode filter, active or trialing inside the period -- or
        // past due inside its grace, for Academy (card or Stripe Invoicing) and
        // any Stripe Invoicing plan; never unpaid (decisions 21 and 25).
        const live = definition(latestDefining('subscription_is_live').sql, 'subscription_is_live');
        expect(live).toMatch(/s\.mode\s*=\s*any\s*\(public\.entitling_billing_modes\s*\(\)\)/i);
        expect(live).toMatch(/s\.status\s+in\s*\('active',\s*'trialing'\)/i);
        expect(live).toMatch(/current_period_end\s+is\s+null\s+or\s+s\.current_period_end\s*>\s*now\(\)/i);
        expect(live).toMatch(
            /s\.status\s*=\s*'past_due'\s+and\s+\(s\.tier\s*=\s*'academy'\s+or\s+s\.collection_method\s*=\s*'send_invoice'\)/i,
        );
        expect(live).not.toMatch(/'unpaid'/i);
    });

    it.each(['admin_set_studio_seat_override', 'admin_clear_studio_seat_override', 'studio_effective_seat_limit'])(
        '%s is the service role’s alone',
        (fn) => {
            const { sql } = latestDefining(fn);
            for (const role of ['public', 'anon', 'authenticated']) {
                expect(revoked(sql, fn, role), role).toBe(true);
                expect(granted(sql, fn, role), role).toBe(false);
            }
            expect(granted(sql, fn, 'service_role')).toBe(true);
        },
    );

    it.each(['admin_set_studio_seat_override', 'admin_clear_studio_seat_override'])(
        '%s also refuses a signed-in caller itself, behind the grant',
        (fn) => {
            const def = definition(latestDefining(fn).sql, fn);
            expect(def).toMatch(/if\s+auth\.uid\(\)\s+is\s+not\s+null\s+then\s*\n\s*raise\s+exception/i);
            expect(def).toMatch(/security\s+definer/i);
        },
    );

    it('lets owners and members read the effective limit, checked inside the function', () => {
        const { sql } = latestDefining('studio_seat_limit');
        expect(granted(sql, 'studio_seat_limit', 'authenticated')).toBe(true);
        expect(granted(sql, 'studio_seat_limit', 'anon')).toBe(false);
        expect(definition(sql, 'studio_seat_limit')).toMatch(/public\.studio_role\s*\(p_studio\)\s+is\s+null/i);
    });

    it('keeps both tables out of every client role, with RLS on', () => {
        const sql = read('supabase/migrations', MIGRATION);
        for (const table of ['studio_seat_overrides', 'studio_seat_override_log']) {
            expect(sql).toMatch(new RegExp(`alter table public\\.${table} enable row level security;`, 'i'));
            for (const role of ['public', 'anon', 'authenticated']) {
                expect(sql).toMatch(new RegExp(`revoke all on table public\\.${table} from ${role};`, 'i'));
            }
            expect(sql).not.toMatch(new RegExp(`grant [^;]+ on table public\\.${table} to (anon|authenticated)`, 'i'));
            expect(sql).not.toMatch(new RegExp(`create policy [^;]+ on public\\.${table}`, 'i'));
        }
    });

    it('logs every override write by trigger, whoever makes it', () => {
        const sql = read('supabase/migrations', MIGRATION);
        expect(sql).toMatch(
            /create trigger studio_seat_overrides_log after insert or update or delete on public\.studio_seat_overrides/i,
        );
    });

    it('ties an override to a recorded subscription and keeps it above the Academy cap', () => {
        const sql = read('supabase/migrations', MIGRATION);
        expect(sql).toMatch(/check \(seat_limit > 5 and seat_limit <= 10000\)/i);
        expect(sql).toMatch(
            /stripe_subscription_id text not null references public\.subscriptions \(stripe_subscription_id\)/i,
        );
    });
});
