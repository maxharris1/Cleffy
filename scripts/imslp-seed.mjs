#!/usr/bin/env node
/* global AbortSignal */
/**
 * Fill the IMSLP works mirror (public.imslp_works) in one run.
 *
 * Walks every taxonomy category with the same generator batches the imslp-sync
 * edge tick uses — MediaWiki `generator=categorymembers` + `prop=categories` +
 * `clcategories=<every taxonomy category>` — so one pass over "For piano"
 * records each piano work's era, forms, keys and composer flags at once.
 * MediaWiki caps clcategories at 50 values, so each 500-page batch costs about
 * four requests; the whole taxonomy is ~3,500 requests (~1 h at 1 req/s).
 *
 * Per category it opens a new generation in imslp_category_sync, upserts
 * batches into imslp_works as they arrive, and on completion marks the row
 * `ok` and prunes the category from pages this walk did not see. Interrupt it
 * and run again: a `building` row resumes at its cmcontinue cursor.
 *
 * Usage:
 *   npm run imslp:seed                                   # every category
 *   npm run imslp:seed -- --category "Chopin, Frédéric"  # one (repeatable)
 *   npm run imslp:seed -- --dry-run --category Nocturnes # walk, write nothing
 *   npm run imslp:seed -- --delay 500                    # ms between requests
 *
 * Env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. When both are unset the
 *       local stack is assumed (port from supabase/config.toml, public demo
 *       service key) — hosted environments must set both explicitly.
 *       Behind an egress proxy set NODE_USE_ENV_PROXY=1.
 *
 * Shared modules are TypeScript; this runs under `node --experimental-strip-types`
 * (see package.json), which is why the .ts extensions below are required.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    applyPageResult,
    categoriesToSync,
    planTick,
    toWorkRow,
    walkCategoryBatch,
} from '../supabase/functions/_shared/categorySync.ts';
import {
    ALL_TAXONOMY_CATEGORIES,
    COMPOSER_FACETS,
    ERA_FACETS,
    FORM_FACETS,
    INSTRUMENT_BY_ID,
    INSTRUMENT_FACETS,
    KEY_FACETS,
} from '../supabase/functions/_shared/searchFacetData.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMSLP_API = 'https://imslp.org/api.php';
const USER_AGENT =
    'Mozilla/5.0 (compatible; Cleffy/1.0; +https://cleffy.app) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
// Well-known local Supabase demo JWT (public; only valid against the local stack).
const LOCAL_SERVICE_ROLE_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const UPSERT_CHUNK = 500;
const MW_RETRIES = 3;

const die = (message) => {
    console.error(`imslp-seed: ${message}`);
    process.exit(2);
};

const parseArgs = (argv) => {
    const out = { categories: [], dryRun: false, delayMs: 1000 };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') {
            out.dryRun = true;
        } else if (arg === '--category') {
            const value = argv[++i];
            if (!value) die('--category needs a value');
            out.categories.push(value);
        } else if (arg === '--delay') {
            const value = Number(argv[++i]);
            if (!Number.isFinite(value) || value < 0) die('--delay needs a non-negative number of ms');
            out.delayMs = value;
        } else {
            die(`unknown flag: ${arg}`);
        }
    }
    return out;
};

const localApiPort = () => {
    const toml = readFileSync(resolve(ROOT, 'supabase/config.toml'), 'utf8');
    const section = toml.split(/^\[api\]\s*$/m)[1]?.split(/^\[/m)[0] ?? '';
    const port = section.match(/^\s*port\s*=\s*(\d+)/m)?.[1];
    if (!port) die('could not read [api] port from supabase/config.toml');
    return port;
};

const resolveTarget = () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url && key) {
        return { url: url.replace(/\/+$/, ''), key, label: url };
    }
    if (url || key) {
        die('set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or neither for the local stack');
    }
    const local = `http://127.0.0.1:${localApiPort()}`;
    return { url: local, key: LOCAL_SERVICE_ROLE_KEY, label: `${local} (local stack)` };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mwFetch = async (params) => {
    const url = new URL(IMSLP_API);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }
    url.searchParams.set('format', 'json');
    let lastError;
    for (let attempt = 1; attempt <= MW_RETRIES; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
                signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) {
                throw new Error(`IMSLP API HTTP ${res.status}`);
            }
            const payload = await res.json();
            if (payload && typeof payload === 'object' && payload.error) {
                throw new Error(payload.error.info ?? 'IMSLP API error');
            }
            return payload;
        } catch (err) {
            lastError = err;
            if (attempt < MW_RETRIES) {
                await sleep(2000 * attempt);
            }
        }
    }
    throw lastError instanceof Error ? lastError : new Error('IMSLP request failed');
};

const makeDb = ({ url, key }) => {
    const headers = {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
    };
    const request = async (path, init) => {
        const res = await fetch(`${url}/rest/v1${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`PostgREST ${init.method ?? 'GET'} ${path} → ${res.status} ${body.slice(0, 300)}`);
        }
        const text = await res.text();
        return text ? JSON.parse(text) : null;
    };
    return {
        syncRow: async (category) => {
            const rows = await request(`/imslp_category_sync?category=eq.${encodeURIComponent(category)}&select=*`, {});
            return Array.isArray(rows) ? rows[0] : undefined;
        },
        upsertSync: (row) =>
            request('/imslp_category_sync?on_conflict=category', {
                method: 'POST',
                headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
                body: JSON.stringify(row),
            }),
        upsertWorks: async (rows) => {
            for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
                await request('/imslp_works?on_conflict=page_id', {
                    method: 'POST',
                    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
                    body: JSON.stringify(rows.slice(i, i + UPSERT_CHUNK)),
                });
            }
        },
        prune: (anchor, before) =>
            request('/rpc/imslp_prune_anchor', { method: 'POST', body: JSON.stringify({ anchor, before }) }),
    };
};

const seedCategory = async (category, { db, dryRun, delayMs }) => {
    const previous = dryRun ? undefined : await db.syncRow(category);
    const plan = planTick(category, previous);
    const startedAt =
        plan.cmcontinue && previous?.building_started_at ? previous.building_started_at : new Date().toISOString();
    if (!dryRun) {
        await db.upsertSync({
            category,
            state: 'building',
            active_generation: previous?.active_generation ?? 0,
            building_generation: plan.generation,
            building_started_at: startedAt,
            cmcontinue: plan.cmcontinue,
            pages_done: plan.pagesDone,
            last_error: null,
            completed_at: previous?.completed_at ?? null,
            updated_at: new Date().toISOString(),
        });
    }

    let cursor = plan.cmcontinue;
    let pagesDone = plan.pagesDone;
    let requests = 0;
    let decision;
    const tally = new Map();

    try {
        for (;;) {
            if (requests > 0) {
                await sleep(delayMs);
            }
            const batch = await walkCategoryBatch(mwFetch, {
                category,
                clcategories: ALL_TAXONOMY_CATEGORIES,
                gcmcontinue: cursor,
            });
            requests += batch.requests;
            for (const m of batch.members) {
                for (const c of m.categories) {
                    tally.set(c, (tally.get(c) ?? 0) + 1);
                }
            }
            if (batch.members.length > 0 && !dryRun) {
                const seenAt = new Date().toISOString();
                await db.upsertWorks(batch.members.map((m) => toWorkRow(category, m, seenAt)));
            }
            decision = applyPageResult(
                { ...plan, pagesDone, cmcontinue: cursor },
                previous,
                batch.members,
                batch.gcmcontinue,
                null,
            );
            pagesDone = decision.pagesDone;
            cursor = batch.gcmcontinue;
            process.stderr.write(`\r[imslp-seed] ${category}: ${pagesDone} pages, ${requests} requests`);
            if (decision.kind !== 'continue') {
                break;
            }
            if (!dryRun) {
                await db.upsertSync({
                    category,
                    state: 'building',
                    active_generation: previous?.active_generation ?? 0,
                    building_generation: plan.generation,
                    building_started_at: startedAt,
                    cmcontinue: cursor,
                    pages_done: pagesDone,
                    last_error: null,
                    completed_at: previous?.completed_at ?? null,
                    updated_at: new Date().toISOString(),
                });
            }
        }
    } catch (err) {
        decision = applyPageResult(
            { ...plan, pagesDone, cmcontinue: cursor },
            previous,
            [],
            cursor,
            err instanceof Error ? err.message : 'seed failed',
        );
    }
    process.stderr.write('\n');

    const state = decision.kind === 'complete' ? 'ok' : decision.kind === 'failed' ? 'failed' : 'building';
    if (!dryRun) {
        await db.upsertSync({
            category,
            state,
            active_generation: decision.activeGeneration,
            building_generation: decision.buildingGeneration,
            building_started_at: startedAt,
            cmcontinue: decision.cmcontinue,
            pages_done: decision.pagesDone,
            last_error: decision.lastError,
            completed_at: decision.kind === 'complete' ? new Date().toISOString() : (previous?.completed_at ?? null),
            updated_at: new Date().toISOString(),
        });
        if (decision.kind === 'complete') {
            const pruned = await db.prune(category, startedAt);
            console.log(
                `[imslp-seed] ${category}: ok, ${decision.pagesDone} pages, ${requests} requests, pruned ${pruned}`,
            );
        }
    }
    if (decision.kind === 'failed') {
        console.error(`[imslp-seed] ${category}: FAILED after ${decision.pagesDone} pages — ${decision.lastError}`);
    } else if (dryRun) {
        console.log(`[imslp-seed] ${category}: dry run, ${decision.pagesDone} pages, ${requests} requests`);
        const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
        for (const [c, n] of top) {
            console.log(`    ${String(n).padStart(6)}  ${c}`);
        }
    }
    return decision.kind;
};

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    const all = categoriesToSync(
        COMPOSER_FACETS,
        INSTRUMENT_FACETS,
        FORM_FACETS,
        ERA_FACETS,
        KEY_FACETS,
        INSTRUMENT_BY_ID['piano']?.category,
    );
    const unknown = args.categories.filter((c) => !all.includes(c));
    if (unknown.length > 0) {
        die(`not taxonomy categories: ${unknown.join(', ')}`);
    }
    const categories = args.categories.length > 0 ? args.categories : all;
    const target = args.dryRun ? null : resolveTarget();
    const db = target ? makeDb(target) : null;
    console.log(
        `[imslp-seed] ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} → ${
            args.dryRun ? 'dry run (no writes)' : target.label
        }`,
    );

    let failed = 0;
    for (const category of categories) {
        const kind = await seedCategory(category, { db, dryRun: args.dryRun, delayMs: args.delayMs });
        if (kind === 'failed') {
            failed += 1;
        }
    }
    if (failed > 0) {
        console.error(`[imslp-seed] ${failed} categor${failed === 1 ? 'y' : 'ies'} failed; run again to resume`);
        process.exit(1);
    }
};

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
