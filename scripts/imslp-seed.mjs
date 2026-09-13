#!/usr/bin/env node
/**
 * Load the committed IMSLP works-mirror catalog into Postgres.
 *
 * Does not call IMSLP. The catalog files are produced by
 * `npm run imslp:export-catalog`.
 *
 * Usage:
 *   npm run imslp:seed
 *   npm run imslp:seed -- --catalog tests/imslp/fixtures/imslp-works-catalog.jsonl
 *   npm run imslp:seed -- --dry-run
 *
 * Env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. When both are unset the
 *       local stack is assumed (port from supabase/config.toml, public demo
 *       service key) — hosted environments must set both explicitly.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CATALOG_JSONL_PATH,
    SYNC_JSON_PATH,
    catalogSyncRows,
    catalogWorkRows,
    readCatalog,
    taxonomyCategories,
} from './imslp-catalog.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_SERVICE_ROLE_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const UPSERT_CHUNK = 500;

const die = (message) => {
    console.error(`imslp-seed: ${message}`);
    process.exit(2);
};

const parseArgs = (argv) => {
    const out = { catalog: CATALOG_JSONL_PATH, sync: SYNC_JSON_PATH, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') {
            out.dryRun = true;
        } else if (arg === '--catalog') {
            const value = argv[++i];
            if (!value) die('--catalog needs a path');
            out.catalog = resolve(value);
            const sibling = out.catalog
                .replace(/-catalog\.jsonl\.gz$/, '-sync.json')
                .replace(/-catalog\.jsonl$/, '-sync.json');
            if (sibling !== out.catalog) {
                out.sync = sibling;
            }
        } else if (arg === '--sync') {
            const value = argv[++i];
            if (!value) die('--sync needs a path');
            out.sync = resolve(value);
        } else {
            die(`unknown flag: ${arg} (IMSLP walks moved to npm run imslp:export-catalog)`);
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
        upsertWorks: async (rows) => {
            for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
                await request('/imslp_works?on_conflict=page_id', {
                    method: 'POST',
                    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
                    body: JSON.stringify(rows.slice(i, i + UPSERT_CHUNK)),
                });
            }
        },
        upsertSync: async (rows) => {
            for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
                await request('/imslp_category_sync?on_conflict=category', {
                    method: 'POST',
                    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
                    body: JSON.stringify(rows.slice(i, i + UPSERT_CHUNK)),
                });
            }
        },
    };
};

const main = async () => {
    const args = parseArgs(process.argv.slice(2));
    const catalog = readCatalog(args.catalog, args.sync);
    const seenAt = catalog.generatedAt;
    const workRows = catalogWorkRows(catalog.works, seenAt);
    const syncRows = catalogSyncRows(catalog.categories, seenAt);
    const missingChips = taxonomyCategories().filter((c) => !syncRows.some((row) => row.category === c));
    if (missingChips.length > 0) {
        die(`catalog is missing chip categories: ${missingChips.join(', ')}`);
    }

    console.log(
        `[imslp-seed] ${workRows.length} works, ${syncRows.length} chip categories → ${
            args.dryRun ? 'dry run (no writes)' : resolveTarget().label
        }`,
    );
    if (args.dryRun) {
        return;
    }

    const db = makeDb(resolveTarget());
    await db.upsertWorks(workRows);
    await db.upsertSync(syncRows);
    console.log(`[imslp-seed] loaded ${workRows.length} works, ${syncRows.length} sync rows`);
};

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
