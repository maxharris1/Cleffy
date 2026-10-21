import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    DISTRICT_INVOICE_GRACE_DAYS,
    READ_ONLY_SEAT_LIMITS,
    STUDENT_LIMITS,
    TIER_LIMITS,
    resolveEntitlements,
    type SubscriptionLike,
} from '../../supabase/functions/_shared/entitlements';

/**
 * The district seat cap and invoice grace (migration
 * 20261020180500_district_seat_cap_and_grace.sql). Postgres is the authority and
 * tests/sql/district_seat_cap.sql proves it against a real database: the seats
 * past a studio's effective limit read-only after an override is lowered,
 * cleared or lapses, the owner's pick, payment restoring every seat, 30 days of
 * full access past due, an admin's extension, and contract_ends_at following
 * Stripe. What CI holds here, without a database: the executable specification
 * in entitlements.ts says the same thing, and the migration still has the shape
 * that proof relies on.
 *
 * Resolved from the project root: the jsdom test environment gives import.meta a
 * non-file URL, so fileURLToPath cannot be used here.
 */

const NOW = Date.parse('2026-11-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

const academy = (overrides: Partial<SubscriptionLike> = {}): SubscriptionLike => ({
    user_id: 'owner-1',
    tier: 'academy',
    status: 'active',
    current_period_end: iso(NOW + 300 * DAY),
    collection_method: 'send_invoice',
    ...overrides,
});

const teacher = (ownerSubscriptions: SubscriptionLike[], readOnlySeatOwnerIds?: string[]) =>
    resolveEntitlements(
        {
            userId: 'teacher-1',
            subscriptions: [],
            studioOwnerIds: ['owner-1'],
            ownerSubscriptions,
            readOnlySeatOwnerIds,
        },
        NOW,
    );

describe('resolveEntitlements enforces the seat cap', () => {
    it('an active seat in a paying academy is Academy', () => {
        const ent = teacher([academy()]);
        expect(ent.tier).toBe('academy');
        expect(ent.source).toBe('studio_member');
        expect(ent.seat_read_only).toBe(false);
    });

    it('a seat past the limit is read-only: free tier, nothing new, unlimited export', () => {
        const ent = teacher([academy()], ['owner-1']);
        expect(ent.tier).toBe('free');
        expect(ent.source).toBe('studio_member');
        expect(ent.seat_read_only).toBe(true);
        expect(ent.limits).toEqual(READ_ONLY_SEAT_LIMITS);
        expect(ent.limits.cloud_scores).toBe(0);
        expect(ent.limits.smart_imports).toBe(0);
        expect(ent.limits.students).toBe(0);
        expect(ent.limits.pdf_exports).toBe(-1);
    });

    it('is read-only even when the academy is not paying at all', () => {
        expect(teacher([academy({ status: 'canceled' })], ['owner-1']).seat_read_only).toBe(true);
    });

    it('an active seat elsewhere beats a read-only one', () => {
        const ent = resolveEntitlements(
            {
                userId: 'teacher-1',
                subscriptions: [],
                studioOwnerIds: ['owner-1', 'owner-2'],
                ownerSubscriptions: [
                    academy(),
                    academy({ user_id: 'owner-2', collection_method: 'charge_automatically' }),
                ],
                readOnlySeatOwnerIds: ['owner-1'],
            },
            NOW,
        );
        expect(ent.tier).toBe('academy');
        expect(ent.seat_read_only).toBe(false);
    });

    it('the teacher’s own plan beats a read-only seat', () => {
        const ent = resolveEntitlements(
            {
                userId: 'teacher-1',
                subscriptions: [academy({ user_id: 'teacher-1', tier: 'teacher', collection_method: null })],
                studioOwnerIds: ['owner-1'],
                ownerSubscriptions: [academy()],
                readOnlySeatOwnerIds: ['owner-1'],
            },
            NOW,
        );
        expect(ent.tier).toBe('teacher');
        expect(ent.source).toBe('subscription');
        expect(ent.seat_read_only).toBeUndefined();
    });

    it('reuses the student ceilings, which are exactly view and export', () => {
        expect(READ_ONLY_SEAT_LIMITS).toEqual(STUDENT_LIMITS);
    });
});

describe('a Stripe Invoicing subscription past due keeps full access through its grace period', () => {
    const pastDue = (sinceDays: number, overrides: Partial<SubscriptionLike> = {}) =>
        academy({ status: 'past_due', past_due_since: iso(NOW - sinceDays * DAY), ...overrides });

    it('on day 29', () => {
        expect(teacher([pastDue(29)]).tier).toBe('academy');
    });

    it('not on day 31', () => {
        expect(teacher([pastDue(31)]).tier).toBe('free');
    });

    it('unpaid counts as past due', () => {
        expect(teacher([pastDue(10, { status: 'unpaid' })]).tier).toBe('academy');
    });

    it('until an admin’s later extension', () => {
        expect(teacher([pastDue(45, { grace_extended_until: iso(NOW + DAY) })]).tier).toBe('academy');
        expect(teacher([pastDue(45, { grace_extended_until: iso(NOW - DAY) })]).tier).toBe('free');
    });

    it('for its owner too', () => {
        const ent = resolveEntitlements(
            { userId: 'owner-1', subscriptions: [pastDue(5)], studioOwnerIds: [], ownerSubscriptions: [] },
            NOW,
        );
        expect(ent.tier).toBe('academy');
        expect(ent.limits).toEqual(TIER_LIMITS.academy);
    });

    it('but a card subscription past due gets none', () => {
        expect(teacher([pastDue(1, { collection_method: 'charge_automatically' })]).tier).toBe('free');
    });
});

const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');
const MIGRATION = '20261020180500_district_seat_cap_and_grace.sql';
const read = (...segments: string[]): string => readFileSync(resolve(process.cwd(), ...segments), 'utf8');
const SQL = read('supabase/migrations', MIGRATION);

const latestDefining = (fn: string): string => {
    const pattern = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, 'i');
    const latest = readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql') && !/imslp_works_catalog/.test(name))
        .sort()
        .filter((name) => pattern.test(read('supabase/migrations', name)))
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

const grantedTo = (fn: string, role: string): boolean =>
    new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^;]*\\)\\s+to\\s+${role}\\s*;`, 'i').test(
        SQL,
    );

describe('the seat-cap migration', () => {
    it('is the resolve_entitlements() that counts, and gates seats on studio_seat_is_active', () => {
        expect(latestDefining('resolve_entitlements')).toBe(MIGRATION);
        const def = definition(SQL, 'resolve_entitlements');
        expect(def).toMatch(/public\.studio_seat_is_active\s*\(sm\.studio_id,\s*v_user\)/i);
        expect(def).toMatch(/not\s+public\.studio_seat_is_active/i);
        expect(def).toMatch(/when\s+v_read_only\s+then\s+public\.tier_limits\s*\('student'\)/i);
        expect(def).toMatch(/'seat_read_only',\s*v_read_only/i);
    });

    it('counts the grace period the TypeScript specification does', () => {
        const def = definition(SQL, 'district_grace_ends_at');
        expect(def).toContain(`p_past_due_since + interval '${DISTRICT_INVOICE_GRACE_DAYS} days'`);
        expect(def).toMatch(/max\(b\.grace_extended_until\)/i);
    });

    it('ranks kept seats first, then the oldest, the same in both seat functions', () => {
        expect(definition(SQL, 'studio_seat_states')).toMatch(
            /order by sm\.kept_active desc, sm\.created_at, sm\.user_id/i,
        );
        expect(definition(SQL, 'studio_seat_is_active')).toMatch(
            /\(o\.kept_active and not v_kept\)\s*or \(o\.kept_active = v_kept and \(o\.created_at, o\.user_id\) < \(v_joined, p_user\)\)/i,
        );
    });

    it('never deletes: read-only seats are archived as plan_lapse and every restore path undoes that', () => {
        const def = definition(SQL, 'reconcile_studio_seats');
        expect(def).toMatch(/public\.apply_free_tier_archival\s*\(v_member\)/i);
        expect(def).toMatch(/public\.restore_user_plan_archived_scores\s*\(v_member\)/i);
        expect(SQL).not.toMatch(/delete\s+from\s+public\.(documents|studio_members)/i);
    });

    it('reconciles on every event that moves a seat, and hourly for the clock', () => {
        expect(SQL).toMatch(/create trigger studio_seat_overrides_reconcile after insert or update or delete/i);
        expect(SQL).toMatch(/create trigger studio_members_release_seat after delete on public\.studio_members/i);
        expect(SQL).toMatch(
            /create trigger subscriptions_follow_district after insert or update on public\.subscriptions/i,
        );
        expect(SQL).toMatch(/cron\.schedule \('district-seat-reconcile', '41 \* \* \* \*'/);
        expect(definition(SQL, 'studio_set_active_seats')).toMatch(
            /return public\.reconcile_studio_seats \(p_studio\)/i,
        );
    });

    it('keeps the billing record and its log out of every client role, with RLS on', () => {
        for (const table of ['district_billing', 'district_billing_log']) {
            expect(SQL).toMatch(new RegExp(`alter table public\\.${table} enable row level security;`, 'i'));
            for (const role of ['public', 'anon', 'authenticated']) {
                expect(SQL).toMatch(new RegExp(`revoke all on table public\\.${table} from ${role};`, 'i'));
            }
            expect(SQL).not.toMatch(new RegExp(`grant [^;]+ on table public\\.${table} to (anon|authenticated)`, 'i'));
            expect(SQL).not.toMatch(new RegExp(`create policy [^;]+ on public\\.${table}`, 'i'));
        }
    });

    it('declares contract_ends_at nullable on the district billing record, where the retention purge reads it', () => {
        expect(SQL).toMatch(/create table public\.district_billing \(/i);
        expect(SQL).toMatch(/\n\s+contract_ends_at timestamptz,\n/);
    });

    it.each([
        'admin_set_district_contract_end',
        'admin_extend_district_grace',
        'reconcile_studio_seats',
        'reconcile_district_seats',
        'district_billing_row',
        'studio_seat_is_active',
        'studio_seat_states',
        'subscription_is_live',
    ])('%s is the service role’s alone', (fn) => {
        for (const role of ['public', 'anon', 'authenticated']) {
            expect(SQL).toMatch(new RegExp(`revoke all on function public\\.${fn} \\([^;]*\\) from ${role};`, 'i'));
            expect(grantedTo(fn, role), role).toBe(false);
        }
        expect(grantedTo(fn, 'service_role')).toBe(true);
    });

    it.each(['admin_set_district_contract_end', 'admin_extend_district_grace'])(
        '%s refuses a signed-in caller itself, behind the grant',
        (fn) => {
            expect(definition(SQL, fn)).toMatch(
                /if\s+auth\.uid\(\)\s+is\s+not\s+null\s+then\s*\n\s*raise\s+exception/i,
            );
        },
    );

    it.each(['studio_set_active_seats', 'studio_seat_status'])('%s is the owner’s, checked inside', (fn) => {
        expect(grantedTo(fn, 'authenticated')).toBe(true);
        expect(grantedTo(fn, 'anon')).toBe(false);
        expect(definition(SQL, fn)).toMatch(/v_owner\s+<>\s+auth\.uid\(\)/i);
    });
});

describe('the webhook leaves the billing record to the database', () => {
    it('never names district_billing, a contract end or a grace extension', () => {
        for (const source of [
            read('supabase/functions/stripe-webhook/index.ts'),
            read('supabase/functions/_shared/stripeEvents.ts'),
        ]) {
            expect(source).not.toMatch(/district_billing|contract_ends_at|grace_extended_until/);
        }
    });
});
