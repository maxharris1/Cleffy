import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Privilege guard for the billing-correctness RPCs.
 *
 * Their behaviour is proven against Postgres (in begin/rollback transactions on
 * the dev branch -- see the migration's notes); what CI can hold in place
 * without a database is who may call them. Every one is SECURITY DEFINER, so a
 * grant in the wrong place is not a style slip: restore_plan_archived_scores
 * granted to authenticated would let anyone un-archive their scores past the
 * cap, and record_smart_import_charge would let anyone mint refundable charges.
 *
 * The LAST definition in timestamp order is the one checked, same as
 * limitsInSync, so a later migration that redefines a function is what counts.
 *
 * Resolved from the project root: the jsdom test environment gives import.meta a
 * non-file URL, so fileURLToPath cannot be used here.
 */
const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

// Read once: the IMSLP catalog migrations are tens of megabytes of inserts.
let cached: Array<{ name: string; sql: string }> | null = null;
const migrations = (): Array<{ name: string; sql: string }> => {
    cached ??= readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => ({ name, sql: readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8') }));
    return cached;
};

/** The text of the last migration that (re)defines `fn`. */
const latestDefining = (fn: string): string => {
    const pattern = new RegExp(`function\\s+public\\.${fn}\\s*\\(`, 'i');
    const latest = migrations()
        .filter((m) => pattern.test(m.sql))
        .at(-1);
    if (!latest) {
        throw new Error(`no migration defines ${fn}()`);
    }
    return latest.sql;
};

/** The `create or replace function ... $$;` block for `fn`. */
const definition = (sql: string, fn: string): string => {
    const start = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, 'i'));
    expect(start).toBeGreaterThanOrEqual(0);
    const bodyOpen = sql.indexOf('$$', start);
    const bodyClose = sql.indexOf('$$', bodyOpen + 2);
    return sql.slice(start, bodyClose + 2);
};

const grants = (sql: string, fn: string, verb: 'grant' | 'revoke', role: string): boolean =>
    new RegExp(
        `${verb}\\s+(all|execute)\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s+(to|from)\\s+${role}\\s*;`,
        'i',
    ).test(sql);

const SERVICE_ONLY = [
    'restore_plan_archived_scores',
    'apply_free_tier_archival',
    'record_smart_import_charge',
    // No caller check at all: anyone who could call it could read any user's plan.
    'resolve_entitlements',
];
// Trigger functions run as their definer; nobody should be able to call them.
const TRIGGER_ONLY = ['studio_members_restore_plan_archived', 'documents_refuse_refunded_import'];
const CLIENT_RPCS = ['claim_pdf_export', 'consume_pdf_export', 'refund_smart_import'];

describe('billing-correctness RPC privileges', () => {
    it.each([...SERVICE_ONLY, ...CLIENT_RPCS])('%s is SECURITY DEFINER with a pinned search_path', (fn) => {
        const def = definition(latestDefining(fn), fn);
        expect(def).toMatch(/security\s+definer/i);
        expect(def).toMatch(/set\s+search_path\s*=\s*public/i);
    });

    it.each(SERVICE_ONLY)('%s is callable by the service role only', (fn) => {
        const sql = latestDefining(fn);
        for (const role of ['public', 'anon', 'authenticated']) {
            expect(grants(sql, fn, 'revoke', role), `revoke from ${role}`).toBe(true);
            expect(grants(sql, fn, 'grant', role), `grant to ${role}`).toBe(false);
        }
        expect(grants(sql, fn, 'grant', 'service_role')).toBe(true);
    });

    it.each(TRIGGER_ONLY)('%s is a SECURITY DEFINER trigger nobody can call', (fn) => {
        const sql = latestDefining(fn);
        const def = definition(sql, fn);
        expect(def).toMatch(/returns\s+trigger/i);
        expect(def).toMatch(/security\s+definer/i);
        expect(def).toMatch(/set\s+search_path\s*=\s*public/i);
        for (const role of ['public', 'anon', 'authenticated']) {
            expect(grants(sql, fn, 'revoke', role), `revoke from ${role}`).toBe(true);
            expect(grants(sql, fn, 'grant', role), `grant to ${role}`).toBe(false);
        }
    });

    it.each(CLIENT_RPCS)('%s is callable by signed-in users and never by anon', (fn) => {
        const sql = latestDefining(fn);
        expect(grants(sql, fn, 'revoke', 'public')).toBe(true);
        expect(grants(sql, fn, 'revoke', 'anon')).toBe(true);
        expect(grants(sql, fn, 'grant', 'anon')).toBe(false);
        expect(grants(sql, fn, 'grant', 'authenticated')).toBe(true);
    });

    it.each(CLIENT_RPCS)('%s resolves the caller from the JWT, never from an argument', (fn) => {
        const def = definition(latestDefining(fn), fn);
        // consume_pdf_export delegates to claim_pdf_export, which does the check.
        if (fn === 'consume_pdf_export') {
            expect(def).toMatch(/public\.claim_pdf_export\s*\(\s*\)/i);
            return;
        }
        expect(def).toMatch(/auth\.uid\s*\(\s*\)/i);
        expect(def).toMatch(/if\s+v_user\s+is\s+null\s+then\s+raise/i);
    });

    it('keeps the smart-import ledger out of every client role', () => {
        const sql = latestDefining('refund_smart_import');
        for (const role of ['public', 'anon', 'authenticated']) {
            expect(sql).toMatch(
                new RegExp(
                    `revoke\\s+all\\s+on\\s+table\\s+public\\.smart_import_charges\\s+from\\s+${role}\\s*;`,
                    'i',
                ),
            );
        }
        expect(sql).not.toMatch(/create\s+policy\s+\w+\s+on\s+public\.smart_import_charges/i);
        expect(sql).toMatch(/alter\s+table\s+public\.smart_import_charges\s+enable\s+row\s+level\s+security/i);
    });

    it('derives archived_reason from the writing role, in a SECURITY INVOKER trigger', () => {
        const sql = latestDefining('documents_archived_reason');
        const def = definition(sql, 'documents_archived_reason');
        // A definer trigger would see its owner as current_user and trust every write.
        expect(def).not.toMatch(/security\s+definer/i);
        expect(def).toMatch(/current_user\s+in\s+\(\s*'authenticated'\s*,\s*'anon'\s*\)/i);
    });

    it('stamps plan_lapse only from the lapse, and restores only plan_lapse', () => {
        const archival = definition(latestDefining('apply_free_tier_archival'), 'apply_free_tier_archival');
        expect(archival).toMatch(/archived_reason\s*=\s*'plan_lapse'/i);
        const restore = definition(latestDefining('restore_plan_archived_scores'), 'restore_plan_archived_scores');
        expect(restore).toMatch(/archived_reason\s*=\s*'plan_lapse'/i);
        // Same advisory lock key as documents_enforce_score_cap, so the two serialize.
        for (const def of [archival, restore]) {
            expect(def).toMatch(/pg_advisory_xact_lock\s*\(\s*hashtext\('cleffy\.documents_score_cap'\)/i);
        }
    });

    it('restores lapse archives most recently used first', () => {
        const restore = definition(latestDefining('restore_plan_archived_scores'), 'restore_plan_archived_scores');
        // The ordering and filter of the restore set itself, not only the row lock.
        expect(restore).toMatch(
            /where\s+d\.owner_id\s*=\s*p_user\s+and\s+d\.archived_reason\s*=\s*'plan_lapse'\s+order\s+by\s+d\.updated_at\s+desc/i,
        );
        expect(restore).toMatch(/limit\s+v_slots/i);
    });

    it('restores a seated teacher from the seat insert itself', () => {
        const sql = latestDefining('studio_members_restore_plan_archived');
        expect(sql).toMatch(
            /create\s+trigger\s+studio_members_restore_plan_archived\s+after\s+insert\s+on\s+public\.studio_members/i,
        );
        const def = definition(sql, 'studio_members_restore_plan_archived');
        expect(def).toMatch(/public\.restore_plan_archived_scores\s*\(\s*new\.user_id\s*\)/i);
    });

    it('asks about the row owner without the JWT caller check wherever server code acts for someone else', () => {
        // get_entitlements(p_user) raises when p_user is not the JWT's user, so
        // a seat invite (JWT: the Academy owner) restoring the teacher's scores
        // would abort in the cap trigger if any of these still called it.
        for (const fn of ['documents_enforce_score_cap', 'restore_plan_archived_scores', 'apply_free_tier_archival']) {
            const def = definition(latestDefining(fn), fn);
            expect(def, fn).toMatch(/public\.resolve_entitlements\s*\(/i);
            expect(def, fn).not.toMatch(/public\.get_entitlements\s*\(/i);
        }
    });

    it('keeps get_entitlements as the caller check in front of resolve_entitlements', () => {
        const def = definition(latestDefining('get_entitlements'), 'get_entitlements');
        expect(def).toMatch(/auth\.uid\s*\(\s*\)/i);
        expect(def).toMatch(/p_user\s*<>\s*v_caller/i);
        expect(def).toMatch(/errcode\s*=\s*'42501'/i);
        expect(def).toMatch(/return\s+public\.resolve_entitlements\s*\(\s*v_caller\s*\)/i);
    });

    it('moved the entitlement resolution verbatim, mode filter included', () => {
        // Compared against the definition it replaced, by file name, so a later
        // migration that changes the resolution on purpose does not trip this.
        const read = (name: string) => readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8');
        const resolution = (def: string) => {
            const from = def.indexOf('    perform 1\n    from auth.users u');
            const to = def.lastIndexOf('end;');
            expect(from).toBeGreaterThan(0);
            return def.slice(from, to);
        };
        const before = resolution(definition(read('20260828180000_billing_stripe_mode.sql'), 'get_entitlements'));
        const after = resolution(definition(read('20261007120300_billing_correctness.sql'), 'resolve_entitlements'));
        expect(after).toBe(before);
        expect(after).toMatch(/s\.mode\s*=\s*any\s*\(public\.entitling_billing_modes\s*\(\s*\)\)/i);
    });

    it('refunds an import only once its bytes are gone, and retires the id for good', () => {
        const refund = definition(latestDefining('refund_smart_import'), 'refund_smart_import');
        expect(refund).toMatch(/from\s+storage\.objects\s+o\s+where\s+o\.bucket_id\s*=\s*'scores'/i);
        expect(refund).toMatch(/from\s+public\.documents\s+d\s+where\s+d\.id\s*=\s*p_document/i);
        // Same per-id lock in the refund and the insert guard, so they serialize.
        const lock = /pg_advisory_xact_lock\s*\(\s*hashtext\('cleffy\.smart_import_refund'\)/i;
        expect(refund).toMatch(lock);

        const sql = latestDefining('documents_refuse_refunded_import');
        const guard = definition(sql, 'documents_refuse_refunded_import');
        expect(guard).toMatch(lock);
        expect(guard).toMatch(/refunded_at\s+is\s+not\s+null/i);
        expect(sql).toMatch(
            /create\s+trigger\s+documents_refuse_refunded_import\s+before\s+insert\s+or\s+update\s+of\s+id\s+on\s+public\.documents/i,
        );
    });
});
