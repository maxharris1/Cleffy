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
 * cap.
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
    'restore_user_plan_archived_scores',
    'apply_free_tier_archival',
    // No caller check at all: anyone who could call it could read any user's plan.
    'resolve_entitlements',
];
// Trigger functions run as their definer; nobody should be able to call them.
const TRIGGER_ONLY = ['studio_members_restore_plan_archived'];
const CLIENT_RPCS = ['claim_pdf_export', 'consume_pdf_export'];

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

    it('offers clients no smart-import refund: imslp-download refunds its own failures', () => {
        // A client-callable refund existed only for an import the client rolled
        // back. imslp-download now creates the score after the PDF is fetched and
        // gives the credit back on every failure itself, so such an RPC would
        // only let an account import, delete the score and take the credit back.
        for (const m of migrations()) {
            if (/_imslp_works_catalog\.sql$/.test(m.name)) {
                continue;
            }
            expect(m.sql, m.name).not.toMatch(/function\s+public\.refund_smart_import\s*\(/i);
            expect(m.sql, m.name).not.toMatch(/create\s+table\s+public\.smart_import_charges/i);
        }
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
        const restore = definition(
            latestDefining('restore_user_plan_archived_scores'),
            'restore_user_plan_archived_scores',
        );
        expect(restore).toMatch(/archived_reason\s*=\s*'plan_lapse'/i);
        // Same advisory lock key as documents_enforce_score_cap, so the two serialize.
        for (const def of [archival, restore]) {
            expect(def).toMatch(/pg_advisory_xact_lock\s*\(\s*hashtext\('cleffy\.documents_score_cap'\)/i);
        }
    });

    it('restores lapse archives most recently used first', () => {
        const restore = definition(
            latestDefining('restore_user_plan_archived_scores'),
            'restore_user_plan_archived_scores',
        );
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
        // Only the seated teacher: a seat changes nobody else's plan.
        expect(def).toMatch(/public\.restore_user_plan_archived_scores\s*\(\s*new\.user_id\s*\)/i);
    });

    it("restores the teachers seated in the subscriber's studios on the webhook's restore", () => {
        // A seated teacher gets no webhook of their own; the Academy owner's
        // resubscribe is the only event that says their seat entitles again.
        const def = definition(latestDefining('restore_plan_archived_scores'), 'restore_plan_archived_scores');
        expect(def).toMatch(/public\.restore_user_plan_archived_scores\s*\(\s*p_user\s*\)/i);
        expect(def).toMatch(
            /from\s+public\.studio_members\s+sm\s+join\s+public\.studios\s+st\s+on\s+st\.id\s*=\s*sm\.studio_id\s+where\s+st\.owner_id\s*=\s*p_user/i,
        );
        // Gated on the member now being unlimited, then restored under their own lock.
        expect(def).toMatch(
            /resolve_entitlements\s*\(\s*v_member\s*\)\s*->\s*'limits'\s*->>\s*'cloud_scores'\s*\)::int\s*<\s*0/i,
        );
        expect(def).toMatch(/public\.restore_user_plan_archived_scores\s*\(\s*v_member\s*\)/i);
    });

    it('meters a share-link guest against the score owner, never exempting them', () => {
        const def = definition(latestDefining('claim_pdf_export'), 'claim_pdf_export');
        expect(def).toMatch(/claim_pdf_export\s*\(\s*p_document\s+uuid\s+default\s+null\b/i);
        expect(def).not.toMatch(/'exempt',\s*'anonymous'/i);
        // Membership first, then the owner's plan and the owner's counter.
        expect(def).toMatch(/public\.document_role\s*\(\s*p_document\s*\)\s+is\s+null/i);
        expect(def).toMatch(/public\.resolve_entitlements\s*\(\s*v_owner\s*\)/i);
        expect(def).toMatch(/v_billed\s*:=\s*v_owner\s*;/i);
        expect(def).toMatch(/public\.consume_quota\s*\(\s*v_billed\s*,\s*'pdf_exports'/i);
    });

    it('lets a claim id be retried without counting twice, and never gives a unit back', () => {
        // Behaviour is proven in tests/sql/billing_export_claims.sql; this holds
        // the shape that makes the retry safe in place without a database.
        const sql = latestDefining('claim_pdf_export');
        const def = definition(sql, 'claim_pdf_export');
        expect(def).toMatch(/p_claim\s+uuid\s+default\s+null/i);
        // A replay must be the claimer's own, recent, and for the same account.
        expect(def).toMatch(/v_prior\.claimed_by\s*=\s*v_user/i);
        expect(def).toMatch(/v_prior\.billed_to\s*=\s*v_billed/i);
        expect(def).toMatch(/v_prior\.created_at\s*>\s*now\s*\(\s*\)\s*-\s*interval\s*'1 hour'/i);
        // A refused id is forgotten, so it can never replay as ok.
        expect(def).toMatch(/not\s+\(v_answer\s*->>\s*'ok'\)::boolean/i);
        // No client-callable path that hands a unit back.
        for (const m of migrations()) {
            if (/_imslp_works_catalog\.sql$/.test(m.name)) {
                continue;
            }
            expect(m.sql, m.name).not.toMatch(/function\s+public\.release_pdf_export/i);
        }
        // The ledger is the function's alone.
        for (const role of ['public', 'anon', 'authenticated']) {
            expect(sql).toMatch(
                new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.pdf_export_claims\\s+from\\s+${role}\\s*;`, 'i'),
            );
        }
        expect(sql).toMatch(/alter\s+table\s+public\.pdf_export_claims\s+enable\s+row\s+level\s+security/i);
        // One function: an old one-argument overload would make p_document alone ambiguous.
        expect(sql).toMatch(/drop\s+function\s+if\s+exists\s+public\.claim_pdf_export\s*\(\s*uuid\s*\)\s*;/i);
    });

    it('asks about the row owner without the JWT caller check wherever server code acts for someone else', () => {
        // get_entitlements(p_user) raises when p_user is not the JWT's user, so
        // a seat invite (JWT: the Academy owner) restoring the teacher's scores
        // would abort in the cap trigger if any of these still called it.
        for (const fn of [
            'documents_enforce_score_cap',
            'restore_plan_archived_scores',
            'restore_user_plan_archived_scores',
            'apply_free_tier_archival',
        ]) {
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
});
