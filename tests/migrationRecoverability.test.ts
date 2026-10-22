import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Drift guard for the recovery runbook.
 *
 * DEPLOY.md's "Recovery and disaster recovery" section is not advice — it names
 * specific lines of specific migrations, and every instruction in it is only
 * correct while those lines still say what they said when it was written. The
 * Phase 1 rehearsal established each fact by hand, once, against a prod-data
 * copy; a one-time manual observation is exactly the kind of thing that goes
 * stale silently, and a stale recovery runbook is worse than none because it is
 * followed under pressure. So the four load-bearing premises are asserted here.
 *
 * The most important one by a distance is `entitling_billing_modes()`. The
 * migration ships `array['live','test']`; production runs a hand-applied
 * `array['live']` that exists in no migration (DEPLOY.md §0's live flip). A
 * second `create or replace` of that function anywhere in the tree would
 * re-open test-mode subscriptions as entitlements on production the next time
 * migrations run — Stripe's published test card buying a real plan — and
 * because production's history row for that migration has `statements = NULL`,
 * no drift check against the recorded history can see it. The function being
 * defined in exactly one place is what made the 1.0 push safe, and this is
 * what makes a change to that loud.
 *
 * Since 20261022100200_deployment_config.sql (launch re-audit BL-2) the
 * narrowing is a row in `public.deployment_config` instead, which a replay of
 * the function body cannot undo: that migration is the one deliberate second
 * definition, and the tests below pin what it has to keep.
 *
 * Resolved from the project root: the jsdom test environment gives import.meta a
 * non-file URL, so fileURLToPath cannot be used here.
 */
const MIGRATIONS_DIR = resolve(process.cwd(), 'supabase/migrations');

/**
 * `--` comments go, string literals survive. Without this every assertion below
 * is wrong in the same direction: `20260828180000_billing_stripe_mode.sql`
 * quotes the narrowed `create or replace function
 * public.entitling_billing_modes ()` in its header comment as the live-flip
 * step, so counting raw text finds two definitions in one file and none of them
 * real. Literals are matched first so a `--` inside one is not mistaken for a
 * comment.
 */
const statements = (sql: string): string =>
    sql.replace(/'(?:[^']|'')*'|--[^\n]*/g, (match) => (match.startsWith("'") ? match : ''));

/**
 * Read once, like tests/billing/billingCorrectnessSql.test.ts does it: the
 * IMSLP catalog migrations are tens of megabytes of inserts, and every
 * assertion below walks the whole directory. Re-reading per assertion is what
 * makes this file slow enough to trip vitest's default 5-second timeout on a
 * loaded machine.
 */
let cached: { name: string; sql: string }[] | null = null;

const migrations = (): { name: string; sql: string }[] => {
    cached ??= readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) => ({ name, sql: statements(readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8')) }));
    return cached;
};

/** Migrations whose statements match, by file name, in timestamp order. */
const definedIn = (pattern: RegExp): string[] =>
    migrations()
        .filter(({ sql }) => pattern.test(sql))
        .map(({ name }) => name);

/**
 * Whether `sql` revokes from / grants to `role` on `fn`, role list and all.
 *
 * The role list is the half that matters and the half a bare `revoke all on
 * function …` match misses, so it is read here: Postgres takes a
 * comma-separated list (`from public, anon, authenticated`), and the signature
 * between the name and it is matched loosely because these functions carry
 * long, line-wrapped argument lists. Same shape as
 * tests/billing/billingCorrectnessSql.test.ts's own grant reader, which guards
 * the billing RPCs the same way.
 */
const privilege = (sql: string, fn: string, verb: 'grant' | 'revoke', role: string): boolean =>
    new RegExp(
        `${verb}\\s+(all|execute)\\s+on\\s+function\\s+public\\.${fn}\\s*\\([^)]*\\)\\s+(to|from)\\s+([a-z_]+\\s*,\\s*)*${role}\\s*(,|;)`,
        'i',
    ).test(sql);

describe('entitling_billing_modes() — the live-flip landmine', () => {
    /**
     * Production's live body is `array['live']`, applied by hand and recorded in
     * no migration. Every migration that redefines this function reverts that
     * narrowing wherever it runs, so there must only ever be the one — and
     * whoever adds a second has to come here, read the comment at the top of
     * this file, and decide deliberately.
     */
    /**
     * Two, deliberately (launch re-audit BL-2). 20261022100200 replaces the
     * hard-coded body with a read of `public.deployment_config`, so production's
     * narrowing lives in a row no replay of a function body can undo, and it
     * carries a hand-narrowed body into that row before replacing it, so applying
     * it over today's production keeps test mode out. A third definition still
     * has to come through here: it would have to keep both properties, which the
     * two tests below hold.
     */
    it('is redefined by exactly two migrations: the original and the config read', () => {
        expect(definedIn(/create\s+or\s+replace\s+function\s+public\.entitling_billing_modes\s*\(/i)).toEqual([
            '20260828180000_billing_stripe_mode.sql',
            '20261022100200_deployment_config.sql',
        ]);
    });

    it('is last defined as a STABLE read of deployment_config, falling back to both modes', () => {
        const sql = migrations().find(({ name }) => name === '20261022100200_deployment_config.sql')?.sql ?? '';
        const start = sql.search(/create\s+or\s+replace\s+function\s+public\.entitling_billing_modes\s*\(/i);
        const definition = sql.slice(start, sql.indexOf('$$;', start));
        expect(definition).toMatch(/\bstable\b/i);
        expect(definition).not.toMatch(/\bimmutable\b/i);
        expect(definition).toMatch(/from\s+public\.deployment_config\b/i);
        expect(definition).toMatch(/coalesce\s*\([\s\S]*array\s*\[\s*'live'\s*,\s*'test'\s*\]/i);
    });

    it('carries a hand-narrowed body into deployment_config before replacing it', () => {
        const sql = migrations().find(({ name }) => name === '20261022100200_deployment_config.sql')?.sql ?? '';
        const carry = sql.search(/insert\s+into\s+public\.deployment_config/i);
        const replace = sql.search(/create\s+or\s+replace\s+function\s+public\.entitling_billing_modes\s*\(/i);
        expect(carry).toBeGreaterThan(-1);
        expect(carry).toBeLessThan(replace);
    });

    /**
     * And that one still ships both modes, which is the whole reason replaying
     * it against production is dangerous. If this ever becomes `array['live']`
     * the landmine is gone and DEPLOY.md's warning should go with it; failing
     * here is the reminder to delete the warning rather than leave a scary note
     * about a problem that no longer exists.
     */
    it('ships both modes, which is what a replay would restore on production', () => {
        const sql = statements(readFileSync(resolve(MIGRATIONS_DIR, '20260828180000_billing_stripe_mode.sql'), 'utf8'));
        expect(sql).toMatch(/select\s+array\s*\[\s*'live'\s*,\s*'test'\s*\]\s*::\s*text\s*\[\s*\]/i);
    });
});

describe('imslp-sync — the cron job the push has to pause', () => {
    /**
     * The runbook says to deactivate this job "immediately after migration 3
     * commits" and re-enable it after migration 10, because for migrations 3-10
     * it calls an `imslp_sync_tick()` that later migrations redefine, against
     * tables migration 10 drops, while issuing outbound pg_net HTTP to IMSLP
     * from production. "Migration 3" is only a useful instruction while this is
     * the file that schedules it.
     */
    it('is scheduled by exactly one migration', () => {
        expect(definedIn(/cron\.schedule\s*\(\s*'imslp-sync'/i)).toEqual(['20260902120000_imslp_category_index.sql']);
    });

    /**
     * `omr-sweep` is the other job, scheduled every minute by
     * `20260806140000_omr_cron.sql` — which production applied long ago, so it
     * is already running there (verified read-only on 2026-10-12: one job,
     * active). The runbook's instruction is to pause `imslp-sync` across the
     * push and leave `omr-sweep` alone, and that is only safe advice while no
     * migration in the pending set re-schedules `omr-sweep` underneath the
     * operator. Pinning the whole map rather than each half means a third job
     * appearing anywhere also has to come through here.
     *
     * `district-seat-reconcile` is the third (hourly, from
     * `20261020180500_district_seat_cap_and_grace.sql`). It needs no pause
     * either: it does not exist until its own migration commits, it calls only
     * functions that migration defines, and what it writes (a read-only seat's
     * plan_lapse archive) is undone by the same restore paths a payment runs.
     */
    it('and omr-sweep, district-seat-reconcile (and the billing mail outbox, plus the retention jobs) are the only jobs any migration touches', () => {
        const touched = new Map<string, string[]>();
        for (const { name, sql } of migrations()) {
            for (const match of sql.matchAll(/cron\.(?:schedule|unschedule)\s*\(\s*'([a-z0-9-]+)'/gi)) {
                const job = match[1] ?? '';
                touched.set(
                    job,
                    [...(touched.get(job) ?? []), name].filter((n, i, a) => a.indexOf(n) === i),
                );
            }
        }
        // `billing-mail-outbox` (launch checkout fix pass) is safe to schedule
        // mid-push: its tick only tidies its own table and posts nowhere until
        // the Vault secrets exist, which are created after the push.
        // The five retention jobs (20261021120300) are safe to let run across
        // a push: each calls a function the same migration defines, against
        // tables no pending migration drops, and touches only rows already past
        // their retention period. What they do on their first night — delete
        // archived students older than 12 months and guests idle for 90 days —
        // is the policy, and the PR lists the counts to check beforehand.
        const retention = ['20261021120300_retention_jobs.sql'];
        expect(Object.fromEntries([...touched].sort())).toEqual({
            'billing-mail-outbox': ['20261020160200_billing_mail_outbox.sql'],
            // Safe to leave running across a push: it calls a function its own
            // migration defines, and only pokes content-notices while notices are due.
            'content-notice-retry': ['20261020150000_content_moderation.sql'],
            'district-seat-reconcile': ['20261020180500_district_seat_cap_and_grace.sql'],
            'imslp-sync': ['20260902120000_imslp_category_index.sql'],
            'omr-sweep': ['20260806140000_omr_cron.sql'],
            'retention-archived-students': retention,
            'retention-compact-tombstones': retention,
            // The same pattern (launchfix P5): it calls a function its own
            // migration defines and deletes only a deleted account's strikes
            // 12 months after the newest under the same key.
            'retention-content-strikes': ['20261022130100_content_strikes_survive_deletion.sql'],
            'retention-rate-limits': retention,
            'retention-stale-guests': retention,
            'retention-support-messages': retention,
            // Launchfix P3: safe to leave running across a push for the same
            // reason as content-notice-retry -- it calls a function its own
            // migration defines, and only pokes resend-inbound while inbound
            // mail is due and the Vault secrets exist.
            'support-inbound-retry': ['20261022110200_support_inbound_lease.sql'],
        });
    });
});

describe('omr_jobs.id — why a naive logical restore of production fails', () => {
    /**
     * `generated always as identity` is the reason a prod-to-environment copy
     * needs `OVERRIDING SYSTEM VALUE` and a `setval` afterwards: without the
     * first the insert is refused outright, without the second the first insert
     * after the restore collides on the primary key. Relax this to `generated
     * by default` and both become unnecessary — so this failing means the
     * recovery section's SQL should be simplified, not that something broke.
     */
    it('is still an always-generated identity column', () => {
        expect(definedIn(/\bid\s+bigint\s+generated\s+always\s+as\s+identity\b/i)).toEqual([
            '20260806120000_omr_jobs.sql',
        ]);
    });

    /**
     * And nothing later relaxes it, which the `create table` text above cannot
     * see. `alter table public.omr_jobs alter column id set generated by
     * default` (or `drop identity`) is one line in a migration nobody would
     * connect to a recovery runbook, and it makes the restore SQL in the
     * recovery section wrong in the quiet direction: `OVERRIDING SYSTEM VALUE`
     * on a by-default column is accepted and ignored, so the copy succeeds and
     * the operator never learns that the `setval` they skipped is now the only
     * thing standing between them and a primary-key collision — or, after a
     * `drop identity`, that there is no sequence left for `setval` to move at
     * all and every insert after the restore needs an explicit id.
     *
     * Pinned across every migration rather than the one that creates the table:
     * the ALTER can live anywhere, and the whole point is that it would be
     * written somewhere else.
     */
    it('is not relaxed, or dropped, by any later migration', () => {
        expect(
            definedIn(
                /alter\s+table\s+(if\s+exists\s+)?public\.omr_jobs[\s\S]*?alter\s+column\s+id\s+(set\s+generated\s+by\s+default|drop\s+identity|add\s+generated)/i,
            ),
        ).toEqual([]);
    });
});

/**
 * The four tables and three functions Phase 1 found on production and on `dev`
 * but in no migration in the repo (finding F2, ~10,618 rows including the two
 * largest tables in production). `mh/playalong-on-dev-ab47` / PR #52 brings all
 * seven under migration control; until it merges the tree has none of them and
 * the loops below are empty, which is itself the thing DEPLOY.md records.
 */
const UNMANAGED_TABLES = ['pd_pdf_store', 'playalong_corpus', 'playalong_corpus_seed', 'playalong_corpus_control'];
const UNMANAGED_FUNCTIONS = ['playalong_corpus_get_by_hash', 'playalong_corpus_put', 'playalong_corpus_get_by_layout'];

describe('the out-of-band corpus objects (finding F2)', () => {
    /**
     * Production already has all seven, so whatever migration claims them has to
     * replay over objects that exist: an unguarded `create table` fails the
     * deploy for the whole file, and since these are the two largest tables in
     * production, a file that half-applies is the worst outcome available. This
     * is a conditional guard on purpose — it says nothing while no migration
     * creates them, and starts enforcing the moment one does.
     */
    it.each(UNMANAGED_TABLES)('%s is only ever created guarded, with RLS and a grant', (table) => {
        for (const { name, sql } of migrations()) {
            const creates = sql.match(
                new RegExp(`create\\s+table\\s+(if\\s+not\\s+exists\\s+)?public\\.${table}\\b`, 'gi'),
            );
            if (!creates) {
                continue;
            }
            for (const create of creates) {
                expect(create.toLowerCase(), `${name} creates ${table} unguarded`).toMatch(/if\s+not\s+exists/i);
            }
            expect(sql, `${name} must enable RLS on ${table}`).toMatch(
                new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, 'i'),
            );
            expect(sql, `${name} must grant ${table} to service_role`).toMatch(
                new RegExp(`grant\\s+all\\s+on\\s+(table\\s+)?public\\.${table}\\s+to\\s+service_role`, 'i'),
            );
        }
    });

    /**
     * All three are SECURITY DEFINER readers and writers of the corpus, and
     * production grants EXECUTE to `service_role` alone. A fresh database grants
     * EXECUTE to PUBLIC by default, so a migration that creates one of them
     * without the revoke hands every anonymous caller a definer-rights write
     * path into the corpus — on a rebuilt environment, not on production, which
     * is precisely the environment nobody checks.
     */
    /**
     * The half-lift the runbook used to offer, as a tripwire.
     *
     * R2 said "either merge #52 or lift its first two migrations onto `dev`
     * separately". The first two do bring all seven objects under migration
     * control — which is what closes the irreplaceable-data exposure — but they
     * do NOT reproduce production's schema: `edition` on `pd_pdf_store` and
     * `playalong_corpus_seed` comes from `…160000`, `pd_pdf_store_origin_check`
     * admitting `imslp` from `…180000`, and `playalong_corpus_control`'s
     * `imslp_paused_until` / `imslp_pause_reason` from `…190000`. Stop after two
     * and a rebuilt environment silently refuses every IMSLP-sourced row and
     * drops every edition signal the importer writes — the failure arrives later,
     * as data the app cannot store, not as a migration that fails.
     *
     * So once anything in the tree creates these tables, the columns and the
     * constraint have to be in the tree too. Says nothing while no migration
     * creates them (this branch), passes with all six of #52's files, and fails
     * on exactly the partial lift. The runbook now names the files per object;
     * this is what keeps that honest.
     */
    it('are not brought under migration control without the columns and constraint production has', () => {
        const created = definedIn(/create\s+table\s+(if\s+not\s+exists\s+)?public\.pd_pdf_store\b/i);
        if (created.length === 0) {
            return;
        }
        const required: [string, RegExp][] = [
            [
                'pd_pdf_store.edition (…160000)',
                /alter\s+table\s+(if\s+exists\s+)?public\.pd_pdf_store[\s\S]{0,400}?add\s+column\s+if\s+not\s+exists\s+edition\b/i,
            ],
            [
                'playalong_corpus_seed.edition (…160000)',
                /alter\s+table\s+(if\s+exists\s+)?public\.playalong_corpus_seed[\s\S]{0,400}?add\s+column\s+if\s+not\s+exists\s+edition\b/i,
            ],
            [
                "pd_pdf_store_origin_check admitting 'imslp' (…180000)",
                /add\s+constraint\s+pd_pdf_store_origin_check[\s\S]{0,400}?'imslp'/i,
            ],
            [
                'playalong_corpus_control.imslp_paused_until (…190000)',
                /alter\s+table\s+(if\s+exists\s+)?public\.playalong_corpus_control[\s\S]{0,400}?add\s+column\s+if\s+not\s+exists\s+imslp_paused_until\b/i,
            ],
        ];
        for (const [what, pattern] of required) {
            expect(
                definedIn(pattern).length,
                `${created.join(', ')} creates the corpus tables, so some migration must also carry ${what}`,
            ).toBeGreaterThan(0);
        }
    });

    it.each(UNMANAGED_FUNCTIONS)('%s is only ever created with EXECUTE narrowed to service_role', (fn) => {
        for (const { name, sql } of migrations()) {
            if (!new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, 'i').test(sql)) {
                continue;
            }
            // The ROLES, not just the statements. `revoke all … from postgres`
            // and `grant execute … to authenticated` are both well-formed and
            // both the opposite of production's ACL, and a revoke/grant pair
            // matched without its role list says nothing at all about who can
            // call a SECURITY DEFINER writer of the corpus.
            for (const role of ['public', 'anon', 'authenticated']) {
                expect(privilege(sql, fn, 'revoke', role), `${name} must revoke ${fn} from ${role}`).toBe(true);
                expect(privilege(sql, fn, 'grant', role), `${name} must not grant ${fn} to ${role}`).toBe(false);
            }
            expect(privilege(sql, fn, 'grant', 'service_role'), `${name} must grant ${fn} to service_role`).toBe(true);
        }
    });
});

/**
 * 20261020160300 (launch checkout, Codex round 4 on #62) redefines two
 * functions 20261020160200 created -- settle_billing_mail and the cron's
 * billing_mail_outbox_tick -- and adds columns, constraints and triggers to
 * tables that migration made. A recovery replays migrations over a database
 * that may already hold some of them, so this one has to apply twice cleanly,
 * and it must not touch the cron job itself: the job calls the tick by name,
 * so redefining the function is enough, and the job map above stays as it is.
 * When the four launch PRs merge this block is reconciled by hand, like the
 * job map: the generator does not write it.
 */
describe('20261020160300_cancel_link_token_lifetime — replays cleanly', () => {
    const sql = (): string =>
        migrations().find(({ name }) => name === '20261020160300_cancel_link_token_lifetime.sql')?.sql ?? '';

    it('exists, and sorts after the outbox migration it extends', () => {
        const names = migrations().map(({ name }) => name);
        expect(names.indexOf('20261020160300_cancel_link_token_lifetime.sql')).toBeGreaterThan(
            names.indexOf('20261020160200_billing_mail_outbox.sql'),
        );
    });

    it('guards every column, index, constraint and trigger it adds, and only replaces functions', () => {
        const text = sql();
        expect(text).not.toMatch(/add\s+column\s+(?!if\s+not\s+exists)/i);
        expect(text).not.toMatch(/create\s+index\s+(?!if\s+not\s+exists)/i);
        expect(text).not.toMatch(/create\s+(table|function)\s/i);
        for (const constraint of text.matchAll(/add\s+constraint\s+([a-z_]+)/gi)) {
            expect(text).toContain(`drop constraint if exists ${constraint[1]}`);
        }
        for (const trigger of text.matchAll(/create\s+trigger\s+([a-z_]+)\s+[\s\S]*?\son\s+(public\.[a-z_]+)/gi)) {
            expect(text).toContain(`drop trigger if exists ${trigger[1]} on ${trigger[2]}`);
        }
    });

    it('leaves the cron job to the migration that schedules it', () => {
        expect(sql()).not.toMatch(/cron\.(schedule|unschedule)/i);
    });
});

/**
 * 20261020160400 (launch checkout, Codex round 5 on #62) adds the cancel-link
 * tombstone table and its triggers, and redefines functions 20261020160300
 * made: the token guard, the tick, and save_cancel_link_token -- dropped and
 * recreated, since its result type changes. Like 20261020160300 it must apply
 * twice cleanly and leave the cron job alone. It also has to sort before
 * #61's first migration (20261020180400) for the binding merge order. When
 * the four launch PRs merge this block is reconciled by hand, like the one
 * above: the generator does not write it.
 */
describe('20261020160400_cancel_link_tombstones_db_clock — replays cleanly', () => {
    const NAME = '20261020160400_cancel_link_tombstones_db_clock.sql';
    const sql = (): string => migrations().find(({ name }) => name === NAME)?.sql ?? '';

    it('exists, after the migration it extends and before #61 district seats', () => {
        const names = migrations().map(({ name }) => name);
        expect(names.indexOf(NAME)).toBeGreaterThan(names.indexOf('20261020160300_cancel_link_token_lifetime.sql'));
        expect(NAME < '20261020180400').toBe(true);
    });

    it('guards every table, index and trigger it adds, and only replaces functions', () => {
        const text = sql();
        expect(text).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.billing_cancel_token_tombstones/i);
        expect(text).not.toMatch(/create\s+table\s+(?!if\s+not\s+exists)/i);
        expect(text).not.toMatch(/create\s+index\s+(?!if\s+not\s+exists)/i);
        expect(text).not.toMatch(/create\s+function\s/i);
        expect(text).not.toMatch(/add\s+(column|constraint)\s/i);
        for (const trigger of text.matchAll(/create\s+trigger\s+([a-z_]+)\s+[\s\S]*?\son\s+(public\.[a-z_]+)/gi)) {
            expect(text).toContain(`drop trigger if exists ${trigger[1]} on ${trigger[2]}`);
        }
        // The one function dropped is the one whose result type changes, and
        // it is recreated with its grant.
        expect([...text.matchAll(/drop\s+function\s+if\s+exists\s+([a-z_.]+)/gi)].map((m) => m[1])).toEqual([
            'public.save_cancel_link_token',
        ]);
        expect(text).toMatch(/create\s+or\s+replace\s+function\s+public\.save_cancel_link_token\s*\(/i);
        expect(text).toContain(
            'grant execute on function public.save_cancel_link_token (uuid, uuid, text, uuid) to service_role',
        );
    });

    it('leaves the cron job to the migration that schedules it', () => {
        expect(sql()).not.toMatch(/cron\.(schedule|unschedule)/i);
    });
});

/**
 * 20261020160500 (launch checkout, Codex round 5 on #62) gives the jsonb save
 * its own name, save_cancel_link_token_v2, and puts save_cancel_link_token
 * back to `returns text`, so 20261020160300 -- which creates it that way --
 * replays over a database that has 20261020160400. Dropping the old save IF
 * EXISTS whatever it returns is what lets this one re-run too. Reconciled by
 * hand at merge time, like the blocks above.
 */
describe('20261020160500_cancel_link_save_replayable — replays cleanly, and lets 20261020160300 replay', () => {
    const NAME = '20261020160500_cancel_link_save_replayable.sql';
    const sql = (): string => migrations().find(({ name }) => name === NAME)?.sql ?? '';
    const sqlOf = (name: string): string => migrations().find((m) => m.name === name)?.sql ?? '';

    it('exists, after 20261020160400 and before #61 district seats', () => {
        const names = migrations().map(({ name }) => name);
        expect(names.indexOf(NAME)).toBeGreaterThan(
            names.indexOf('20261020160400_cancel_link_tombstones_db_clock.sql'),
        );
        expect(NAME < '20261020180400').toBe(true);
    });

    it('only drops the old save and replaces functions', () => {
        const text = sql();
        expect([...text.matchAll(/drop\s+function\s+if\s+exists\s+([a-z_.]+)/gi)].map((m) => m[1])).toEqual([
            'public.save_cancel_link_token',
        ]);
        expect(text).not.toMatch(/create\s+(function|table|index|trigger)\s/i);
        expect(text).not.toMatch(/cron\.(schedule|unschedule)/i);
    });

    it('leaves save_cancel_link_token returning text, as 20261020160300 creates it', () => {
        const returns = (text: string): string | undefined =>
            text.match(
                /create\s+or\s+replace\s+function\s+public\.save_cancel_link_token\s*\([^)]*\)\s*returns\s+(\w+)/i,
            )?.[1];
        expect(returns(sqlOf('20261020160300_cancel_link_token_lifetime.sql'))).toBe('text');
        expect(returns(sql())).toBe('text');
        expect(sql()).toMatch(
            /create\s+or\s+replace\s+function\s+public\.save_cancel_link_token_v2\s*\([^)]*\)\s*returns\s+jsonb/i,
        );
        for (const fn of ['save_cancel_link_token', 'save_cancel_link_token_v2']) {
            expect(sql()).toContain(`grant execute on function public.${fn} (uuid, uuid, text, uuid) to service_role`);
        }
    });
});

/**
 * 20261020160600 (launch checkout, Codex round 6 on #62) serializes the
 * cancel-link history: advisory locks taken by every delete and every insert
 * of a token, a unique outbox-id tombstone, and the tick taking its locks
 * before it deletes. It replaces functions 20261020160400 and 20261020160500
 * made, adds one trigger and one index, and must apply twice cleanly -- CI's
 * supabase-local job replays it after the three before it -- and sort before
 * #61's first migration. Reconciled by hand at merge time, like the blocks
 * above: the generator does not write it.
 */
describe('20261020160600_cancel_link_serialized_history — replays cleanly', () => {
    const NAME = '20261020160600_cancel_link_serialized_history.sql';
    const sql = (): string => migrations().find(({ name }) => name === NAME)?.sql ?? '';

    it('exists, after 20261020160500 and before #61 district seats', () => {
        const names = migrations().map(({ name }) => name);
        expect(names.indexOf(NAME)).toBeGreaterThan(names.indexOf('20261020160500_cancel_link_save_replayable.sql'));
        expect(NAME < '20261020180400').toBe(true);
    });

    it('guards every index and trigger it adds, drops no function, and only replaces functions', () => {
        const text = sql();
        expect(text).not.toMatch(/create\s+(table|function)\s/i);
        expect(text).not.toMatch(/create\s+(unique\s+)?index\s+(?!if\s+not\s+exists)/i);
        expect(text).not.toMatch(/add\s+(column|constraint)\s/i);
        expect(text).not.toMatch(/drop\s+function/i);
        expect(text).toMatch(/drop\s+index\s+if\s+exists\s+public\.billing_cancel_token_tombstones_outbox;/i);
        for (const trigger of text.matchAll(/create\s+trigger\s+([a-z_]+)\s+[\s\S]*?\son\s+(public\.[a-z_]+)/gi)) {
            expect(text).toContain(`drop trigger if exists ${trigger[1]} on ${trigger[2]}`);
        }
        for (const fn of [
            'save_cancel_link_token_v2 (uuid, uuid, text, uuid)',
            'billing_mail_outbox_tick ()',
            'read_cancel_link_token (text)',
        ]) {
            expect(text).toContain(`grant execute on function public.${fn} to service_role`);
        }
    });

    it('leaves the cron job to the migration that schedules it', () => {
        expect(sql()).not.toMatch(/cron\.(schedule|unschedule)/i);
    });
});

/**
 * 20261020160700 (launch checkout, Codex round 7 on #62) makes spending a
 * cancel link one statement gated on the database's clock: a new service-role
 * RPC, consume_cancel_link_token, and the token guard (20261020160400's
 * billing_cancel_tokens_lifetime) refusing an update that spends an expired
 * link. It only replaces functions -- the guard's trigger is 20261020160300's
 * -- and must apply twice cleanly -- CI's supabase-local job replays it after
 * the four before it -- and sort before #61's first migration. Reconciled by
 * hand at merge time, like the blocks above: the generator does not write it.
 */
describe('20261020160700_cancel_link_consume_db_clock — replays cleanly', () => {
    const NAME = '20261020160700_cancel_link_consume_db_clock.sql';
    const sql = (): string => migrations().find(({ name }) => name === NAME)?.sql ?? '';

    it('exists, after 20261020160600 and before #61 district seats', () => {
        const names = migrations().map(({ name }) => name);
        expect(names.indexOf(NAME)).toBeGreaterThan(names.indexOf('20261020160600_cancel_link_serialized_history.sql'));
        expect(NAME < '20261020180400').toBe(true);
    });

    it('only replaces functions: no table, index, trigger, column or dropped function', () => {
        const text = sql();
        expect(text).toMatch(/create\s+or\s+replace\s+function\s+public\.consume_cancel_link_token\s/i);
        expect(text).toMatch(/create\s+or\s+replace\s+function\s+public\.billing_cancel_tokens_lifetime\s/i);
        expect(text).not.toMatch(/create\s+(table|function|trigger|(unique\s+)?index)\s/i);
        expect(text).not.toMatch(/add\s+(column|constraint)\s/i);
        expect(text).not.toMatch(/drop\s+(function|trigger|table|index)/i);
    });

    it('grants the RPC to the service role alone, with search_path pinned', () => {
        const text = sql();
        expect(text).toContain(
            'revoke all on function public.consume_cancel_link_token (text) from public, anon, authenticated;',
        );
        expect(text).toContain('grant execute on function public.consume_cancel_link_token (text) to service_role;');
        expect(text).not.toMatch(
            /grant\s+execute\s+on\s+function\s+public\.consume_cancel_link_token[^;]*(anon|authenticated)/i,
        );
        expect(text).toMatch(
            /consume_cancel_link_token \(p_hash text\)[\s\S]*?security definer\s+set search_path = ''/,
        );
        expect(text).toContain(
            'revoke all on function public.billing_cancel_tokens_lifetime () from public, anon, authenticated, service_role;',
        );
    });

    it('leaves the cron job to the migration that schedules it', () => {
        expect(sql()).not.toMatch(/cron\.(schedule|unschedule)/i);
    });
});
