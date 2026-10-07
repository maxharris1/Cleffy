#!/usr/bin/env node
/**
 * Regenerate scripts/apply-migrations.sql from supabase/migrations/*.sql.
 * tests/applyMigrationsInSync.test.ts fails the build when the two disagree;
 * run `npm run migrations:mirror` after adding or editing a migration.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = 'supabase/migrations';
const isCatalogSql = (name) => /^\d+_imslp_works_catalog\.sql$/.test(name);

const header = `-- Combined migrations for the Supabase SQL editor (generated from supabase/migrations/*.sql)

-- Paste and run this whole file once in: Dashboard → SQL Editor → New query
-- Catalog inserts (*_imslp_works_catalog.sql) are omitted: they exceed the SQL editor
-- paste limit. Apply those with \`npx supabase db push\` or \`psql -f\`.
`;

const parts = readdirSync(resolve(ROOT, DIR))
    .filter((name) => name.endsWith('.sql') && !isCatalogSql(name))
    .sort()
    .map((name) => `\n-- ===== ${DIR}/${name} =====\n${readFileSync(resolve(ROOT, DIR, name), 'utf8').trimEnd()}\n`);

writeFileSync(resolve(ROOT, 'scripts/apply-migrations.sql'), header + parts.join(''));
