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

/**
 * The three guards behind the double-charge fix (QA round 4, D1-D3). Their
 * behaviour is proven against Postgres in tests/sql/billing_double_charge.sql,
 * run by hand like the rest of that directory; what CI can hold without a
 * database is that the migrations still declare them, and that the names the
 * webhook matches on are the names the SQL creates — a rename on one side alone
 * turns the duplicate-subscription branch into an unhandled 23505, which is a
 * Stripe retry every few hours against a constraint that will never yield.
 */
describe('the double-charge guards', () => {
    const declaring = (pattern: RegExp): { name: string; sql: string } => {
        const found = migrations().filter((m) => pattern.test(m.sql));
        expect(found.length, `migrations declaring ${pattern.source}`).toBe(1);
        return found[0] as { name: string; sql: string };
    };

    const ENTITLING_INDEX = 'subscriptions_one_entitling_per_user_mode';

    it('creates the partial unique index on the statuses that entitle', () => {
        const migration = declaring(new RegExp(`create unique index if not exists ${ENTITLING_INDEX}`, 'i'));
        expect(migration.sql).toMatch(
            new RegExp(
                `create\\s+unique\\s+index\\s+if\\s+not\\s+exists\\s+${ENTITLING_INDEX}\\s+on\\s+public\\.subscriptions\\s*\\(user_id,\\s*mode\\)\\s+where\\s+status\\s+in\\s*\\('active',\\s*'trialing'\\)`,
                'i',
            ),
        );
        // A violating row must stop the push with something a human can act on,
        // not with Postgres's own message about a duplicated key.
        expect(migration.sql).toMatch(/raise\s+exception/i);
        expect(migration.sql).toMatch(/errcode\s*=\s*'23505'/i);
        expect(migration.sql).toMatch(/having\s+count\s*\(\*\)\s*>\s*1/i);
    });

    it('names that index in the write function, and re-raises any other unique violation', () => {
        // The match used to live in the Edge Function, over the text of
        // PostgREST's error message -- neither a documented contract. It is now
        // Postgres's own diagnostics, inside the statement that hits the index
        // (QA round 4 review of #56, finding 3).
        const def = definition(latestDefining('write_subscription_under_lock'), 'write_subscription_under_lock');
        expect(def).toMatch(/get\s+stacked\s+diagnostics\s+v_constraint\s*=\s*constraint_name\s*;/i);
        expect(def).toContain(ENTITLING_INDEX);
        expect(def).toMatch(new RegExp(`if\\s+v_constraint\\s*=\\s*'${ENTITLING_INDEX}'`, 'i'));
        // Anything else: a primary key, a constraint added later. Swallowing one
        // would turn a bug into an acknowledged event.
        expect(def).toMatch(/when\s+unique_violation\s+then[\s\S]*?\braise\s*;/i);
        // And the deleted-account FK keeps its own answer rather than throwing.
        expect(def).toMatch(/when\s+foreign_key_violation\s+then\s*\n\s*return\s+'missing_user'\s*;/i);
    });

    it('checks the write lease in the same statement as the write, holding the lease row', () => {
        // Finding 3: only release_subscription_write ever checked whose lease it
        // was, so a delivery whose lease had gone stale still wrote the state it
        // had read minutes earlier over the newer state that replaced it.
        const sql = latestDefining('write_subscription_under_lock');
        const def = definition(sql, 'write_subscription_under_lock');
        expect(def).toMatch(
            /from\s+public\.subscription_writes\s+where\s+stripe_subscription_id\s*=\s*p_subscription_id\s+and\s+holder\s*=\s*p_holder\s+for\s+update/i,
        );
        expect(def).toMatch(/if\s+not\s+found\s+then\s*\n\s*return\s+'lost_lock'\s*;/i);
        // The conflict target stays the primary key: a second entitling
        // subscription is not the same subscription, so there is no row for it
        // to merge into.
        expect(def).toMatch(/on\s+conflict\s*\(stripe_subscription_id\)\s*do\s+update/i);
        expect(def).not.toMatch(/security\s+definer/i);
        expect(def).toMatch(/set\s+search_path\s*=\s*public/i);
        // SECURITY INVOKER means the service role needs the table grant that
        // `subscriptions` never got (it predates core_table_grants).
        expect(sql).toMatch(/grant\s+all\s+on\s+table\s+public\.subscriptions\s+to\s+service_role\s*;/i);
        expect(sql).toMatch(
            /revoke\s+all\s+on\s+function\s+public\.write_subscription_under_lock[\s\S]*?from\s+public,\s*anon,\s*authenticated\s*;/i,
        );
        expect(sql).toMatch(
            /grant\s+execute\s+on\s+function\s+public\.write_subscription_under_lock[\s\S]*?to\s+service_role\s*;/i,
        );
    });

    it('lets the webhook branch on all four answers and nothing else', () => {
        const source = readFileSync(resolve(process.cwd(), 'supabase/functions/stripe-webhook/index.ts'), 'utf8');
        expect(source).toContain("admin.rpc('write_subscription_under_lock'");
        // The holder is threaded in: a write that did not carry one could not be
        // refused, which is the whole fix.
        expect(source).toMatch(/p_holder:\s*holder/);
        for (const answer of ['written', 'lost_lock', 'duplicate', 'missing_user']) {
            expect(source, answer).toContain(`case '${answer}':`);
        }
        // An answer this does not model is a throw, not a silent success.
        expect(source).toMatch(/default:\s*\n\s*throw new Error\(/);
        // And the row is no longer written through PostgREST, which could not
        // carry the condition at all.
        expect(source).not.toMatch(/\.from\('subscriptions'\)\s*\n?\s*\.upsert\(/);
    });

    it('stages the checkout idempotency key under the holder, before Stripe sees it', () => {
        // Finding 1: the attempt id the key is derived from lived only in the
        // isolate's memory until finish_checkout_attempt, so a death around the
        // Stripe create left a session nothing could replay the key for -- and
        // the next attempt, minting a fresh key, got a second one.
        const sql = latestDefining('stage_checkout_attempt');
        const def = definition(sql, 'stage_checkout_attempt');
        expect(def).toMatch(/update\s+public\.checkout_attempts/i);
        expect(def).toMatch(/attempt_id\s*=\s*p_attempt_id/i);
        expect(def).toMatch(/price_id\s*=\s*p_price_id/i);
        // Cleared: by now the stored session has been handed back or expired, and
        // a null session beside a non-null attempt is what marks the key as
        // replayable.
        expect(def).toMatch(/session_id\s*=\s*null/i);
        // Scoped to the lease, which is what stops an attempt whose lease was
        // taken over from reaching the create at all.
        expect(def).toMatch(/where\s+user_id\s*=\s*p_user\s+and\s+mode\s*=\s*p_mode\s+and\s+holder\s*=\s*p_holder/i);
        // And it does NOT give the lock back: the create still has to happen
        // under it.
        expect(def).not.toMatch(/holder\s*=\s*null/i);
        expect(def).toMatch(/return\s+found\s*;/i);
        expect(sql).toMatch(
            /revoke\s+all\s+on\s+function\s+public\.stage_checkout_attempt\s*\(uuid,\s*text,\s*uuid,\s*uuid,\s*text\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
        );
        expect(sql).toMatch(
            /grant\s+execute\s+on\s+function\s+public\.stage_checkout_attempt\s*\(uuid,\s*text,\s*uuid,\s*uuid,\s*text\)\s+to\s+service_role\s*;/i,
        );
    });

    it('keeps the duplicate refund owed in a table, service-role only', () => {
        // Finding 2: the debt was a property of an event, and the retry of that
        // event never reaches the duplicate branch again -- the cancel has made
        // the subscription `canceled`, which the index has nothing to refuse.
        const migration = declaring(/create table if not exists public\.duplicate_refunds/i);
        expect(migration.sql).toMatch(
            /state\s+text\s+not\s+null\s+check\s*\(state\s+in\s*\('pending',\s*'resolved',\s*'needs_human'\)\)/i,
        );
        // Keyed on the subscription and the mode, not on the event: the event id
        // changes with every delivery and the status changes under the retry.
        expect(migration.sql).toMatch(/primary\s+key\s*\(stripe_subscription_id,\s*mode\)/i);
        // An account deletion must not erase a refund we never issued.
        expect(migration.sql).toMatch(/user_id\s+uuid\s+references\s+auth\.users\s*\(id\)\s+on\s+delete\s+set\s+null/i);
        expect(migration.sql).toMatch(
            /alter\s+table\s+public\.duplicate_refunds\s+enable\s+row\s+level\s+security\s*;/i,
        );
        expect(migration.sql).toMatch(/grant\s+all\s+on\s+table\s+public\.duplicate_refunds\s+to\s+service_role\s*;/i);
        // No policy at all, so RLS refuses every client role outright.
        expect(migration.sql).not.toMatch(/create\s+policy/i);

        // Only `pending` is retried, and a settled debt is never reopened.
        const pending = definition(latestDefining('pending_duplicate_refund'), 'pending_duplicate_refund');
        expect(pending).toMatch(/d\.state\s*=\s*'pending'/i);
        const record = definition(latestDefining('record_duplicate_refund'), 'record_duplicate_refund');
        expect(record).toMatch(/case\s+when\s+d\.state\s*=\s*'resolved'\s+then\s+d\.state\s+else\s+'pending'\s+end/i);
        // Counted where the outcome arrives, the failures included: a high count
        // still `pending` is the refund no delivery will ever manage.
        const settle = definition(latestDefining('settle_duplicate_refund'), 'settle_duplicate_refund');
        expect(settle).toMatch(/attempts\s*=\s*attempts\s*\+\s*1/i);
        expect(record).not.toMatch(/attempts\s*=/i);

        for (const [fn, args] of [
            ['record_duplicate_refund', 'text, text, uuid'],
            ['settle_duplicate_refund', 'text, text, text, boolean, text, text'],
            ['pending_duplicate_refund', 'text, text'],
        ] as const) {
            const sql = latestDefining(fn);
            expect(grants(sql, fn, 'revoke', 'public,\\s*anon,\\s*authenticated'), `${fn} revoke`).toBe(true);
            expect(grants(sql, fn, 'grant', 'service_role'), `${fn} grant`).toBe(true);
            expect(definition(sql, fn), `${fn} (${args})`).not.toMatch(/security\s+definer/i);
        }
    });

    it('gives stripe_events a claim state, defaulting the rows that predate it to done', () => {
        const migration = declaring(/add column if not exists status text not null default 'done'/i);
        expect(migration.sql).toMatch(/check\s*\(status\s+in\s*\('processing',\s*'done'\)\)/i);
        expect(migration.sql).toMatch(/add column if not exists claimed_at timestamptz not null default now\(\)/i);
    });

    it('claims an event in one statement, taking over only a stale claim', () => {
        const sql = latestDefining('claim_stripe_event');
        const def = definition(sql, 'claim_stripe_event');
        // One INSERT ... ON CONFLICT: two deliveries racing cannot both win.
        expect(def).toMatch(/insert\s+into\s+public\.stripe_events/i);
        expect(def).toMatch(/on\s+conflict\s*\(id\)\s*do\s+update/i);
        expect(def).toMatch(
            /where\s+e\.status\s*=\s*'processing'\s+and\s+e\.claimed_at\s*<\s*now\s*\(\)\s*-\s*p_stale_after/i,
        );
        expect(def).toMatch(/set\s+search_path\s*=\s*public/i);
        // No SECURITY DEFINER: the service role already owns this table, and a
        // definer function would hand the claim to anyone who could call it.
        expect(def).not.toMatch(/security\s+definer/i);
        expect(sql).toMatch(
            /revoke\s+all\s+on\s+function\s+public\.claim_stripe_event\s*\(text,\s*text,\s*interval\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
        );
        expect(sql).toMatch(
            /grant\s+execute\s+on\s+function\s+public\.claim_stripe_event\s*\(text,\s*text,\s*interval\)\s+to\s+service_role\s*;/i,
        );
    });

    it('refuses a stale subscription write in a BEFORE UPDATE trigger that returns OLD', () => {
        const sql = latestDefining('subscriptions_refuse_stale_event');
        const def = definition(sql, 'subscriptions_refuse_stale_event');
        expect(sql).toMatch(/add column if not exists last_event_created_at timestamptz/i);
        expect(sql).toMatch(
            /create\s+trigger\s+subscriptions_refuse_stale_event\s+before\s+update\s+on\s+public\.subscriptions/i,
        );
        expect(def).toMatch(/returns\s+trigger/i);
        // OLD, not NULL: the statement still reports a row, so PostgREST answers
        // the webhook 200 and Stripe is not asked to retry an event too old to
        // matter.
        expect(def).toMatch(/return\s+old\s*;/i);
        // Both NULL cases let the write through, and an unstamped write keeps
        // the stamp the row already has.
        expect(def).toMatch(/new\.last_event_created_at\s*:=\s*old\.last_event_created_at/i);
        expect(def).toMatch(/old\.last_event_created_at\s+is\s+not\s+null/i);
    });
});
