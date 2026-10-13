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
 * defined in exactly one place is what currently makes the 1.0 push safe, and
 * this is what makes a change to that loud.
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
    it('is redefined by exactly one migration', () => {
        expect(definedIn(/create\s+or\s+replace\s+function\s+public\.entitling_billing_modes\s*\(/i)).toEqual([
            '20260828180000_billing_stripe_mode.sql',
        ]);
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
     */
    it('and omr-sweep are the only jobs any migration touches', () => {
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
        expect(Object.fromEntries([...touched].sort())).toEqual({
            'imslp-sync': ['20260902120000_imslp_category_index.sql'],
            'omr-sweep': ['20260806140000_omr_cron.sql'],
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
