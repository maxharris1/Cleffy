#!/usr/bin/env node
/**
 * Does this branch still describe the live Supabase project?
 *
 * The failure this exists to catch, because it has already happened once:
 * migrations were applied straight to production before the branch carrying them
 * was merged. Nothing complained. Production ran five migrations and a
 * mode-aware billing path that `main` had never heard of, so `main` — the branch
 * that is supposed to BE production — silently stopped describing it. The repo
 * only looked healthy because nobody was comparing.
 *
 * Supabase's own GitHub integration deploys on merge; it does not check that the
 * branch was ever the source of what is live. That is this script's whole job.
 *
 * Two read-only questions:
 *
 *   migrations  supabase_migrations.schema_migrations, over the Management API's
 *               SQL endpoint. Direct Postgres is not reachable from CI or from
 *               the Claude sandbox; HTTPS is.
 *   functions   GET /v1/projects/{ref}/functions — a live function with no
 *               source in the tree is code nobody can review or roll back.
 *
 * Exit 0 clean, 1 on drift, 2 on a usage or transport error: a network failure
 * must never read as "no drift".
 *
 * Usage:  node scripts/check-supabase-drift.mjs [--json] [--migrations] [--functions]
 * Env:    SUPABASE_ACCESS_TOKEN (sbp_…)   SUPABASE_PROJECT_REF
 */

import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = resolve(ROOT, 'supabase/migrations');
const FUNCTIONS_DIR = resolve(ROOT, 'supabase/functions');
const API = 'https://api.supabase.com';

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
// Neither flag means both, so a bare invocation is the full check.
const wantMigrations = args.has('--migrations') || !args.has('--functions');
const wantFunctions = args.has('--functions') || !args.has('--migrations');

const die = (message) => {
    console.error(`check-supabase-drift: ${message}`);
    process.exit(2);
};

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token) die('SUPABASE_ACCESS_TOKEN is not set');
if (!ref) die('SUPABASE_PROJECT_REF is not set');

const api = async (path, init = {}) => {
    let res;
    try {
        res = await fetch(`${API}${path}`, {
            ...init,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        });
    } catch (err) {
        die(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) die(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
    return res.json();
};

/** Local migrations, by the `<version>_<name>.sql` convention the CLI enforces. */
const localMigrations = () =>
    readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith('.sql'))
        .map((file) => {
            const match = /^(\d+)_(.+)\.sql$/.exec(file);
            return match ? { version: match[1], name: match[2], file } : null;
        })
        .filter((entry) => entry !== null)
        .sort((a, b) => a.version.localeCompare(b.version));

const checkMigrations = async () => {
    const rows = await api(`/v1/projects/${ref}/database/query`, {
        method: 'POST',
        body: JSON.stringify({
            query: 'select version, name from supabase_migrations.schema_migrations order by version;',
        }),
    });
    const applied = rows.map((row) => ({ version: String(row.version), name: String(row.name ?? '') }));
    const local = localMigrations();
    const appliedSet = new Set(applied.map((entry) => entry.version));
    const localSet = new Set(local.map((entry) => entry.version));

    // THE incident check: applied on the project, described by no file here. The
    // schema cannot be rebuilt from this branch until it is committed.
    const appliedNotInBranch = applied.filter((entry) => !localSet.has(entry.version));

    // Committed but not yet applied — the normal state of a branch about to merge.
    const pending = local.filter((entry) => !appliedSet.has(entry.version));

    // `supabase db push` refuses a pending migration older than the newest applied
    // one, so this blocks the deploy rather than merely looking untidy.
    const newestApplied = applied.length > 0 ? applied[applied.length - 1].version : '';
    const outOfOrder = pending.filter((entry) => entry.version < newestApplied);

    return { applied: applied.length, local: local.length, appliedNotInBranch, pending, outOfOrder };
};

/** Function directories in the tree — `_shared` is a library, not a deployable. */
const localFunctions = () =>
    readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort();

const checkFunctions = async () => {
    const live = await api(`/v1/projects/${ref}/functions`);
    const local = new Set(localFunctions());
    const liveSlugs = new Set(live.map((fn) => fn.slug));

    // Deployed from somebody's laptop and never committed: unreviewable, and lost
    // the moment that laptop is.
    const liveNotInBranch = live
        .filter((fn) => !local.has(fn.slug))
        .map((fn) => ({ slug: fn.slug, version: fn.version }));
    const neverDeployed = [...local].filter((slug) => !liveSlugs.has(slug));

    return { live: live.length, local: local.size, liveNotInBranch, neverDeployed };
};

const report = {};
if (wantMigrations) report.migrations = await checkMigrations();
if (wantFunctions) report.functions = await checkFunctions();

if (asJson) {
    console.log(JSON.stringify(report, null, 2));
} else {
    if (report.migrations) {
        const m = report.migrations;
        console.log(`migrations: ${m.local} in this branch, ${m.applied} applied on ${ref}`);
        for (const e of m.appliedNotInBranch)
            console.log(`  ✗ applied to the project, absent here: ${e.version}_${e.name}`);
        for (const e of m.outOfOrder) console.log(`  ✗ out of order (db push will refuse): ${e.file}`);
        for (const e of m.pending) console.log(`  · pending, will apply on merge: ${e.file}`);
    }
    if (report.functions) {
        const f = report.functions;
        console.log(`functions: ${f.local} in this branch, ${f.live} live on ${ref}`);
        for (const e of f.liveNotInBranch) console.log(`  ✗ live but absent here: ${e.slug} (v${e.version})`);
        for (const slug of f.neverDeployed) console.log(`  · in this branch, not yet live: ${slug}`);
    }
}

// `pending` and `neverDeployed` are what a merge is FOR, so neither fails.
// Everything else means the project holds something this branch cannot account for.
const failures =
    (report.migrations?.appliedNotInBranch.length ?? 0) +
    (report.migrations?.outOfOrder.length ?? 0) +
    (report.functions?.liveNotInBranch.length ?? 0);

if (failures > 0) {
    console.error(`\n${failures} discrepancie(s) between this branch and ${ref}.`);
    console.error('See docs/BRANCH_PROTECTION.md — "When the drift check fails".');
    process.exit(1);
}
console.log('\nclean: this branch and the live project agree.');
